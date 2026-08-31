#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveSession, listSessions, listSessionSummaries } from "../lib/cache.mjs";
import { EVALUATION_TASKS } from "./tasks.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * OMP 18.0.11 does not replay MiniMax reasoning by default. The supported
 * textual-history compatibility flag preserves it across the tool-result turn.
 */
export function modelsConfigFor(model) {
  const separator = model.indexOf("/");
  if (model.slice(0, separator) !== "minimax-code" || separator === -1) return null;
  return [
    "providers:",
    "  minimax-code:",
    "    modelOverrides:",
    `      ${model.slice(separator + 1)}:`,
    "        compat:",
    "          requiresThinkingAsText: true",
    "",
  ].join("\n");
}

/**
 * OMP resolves the agent directory from the active profile *or* from
 * `PI_CODING_AGENT_DIR`, never both: with `OMP_PROFILE`/`PI_PROFILE` set it
 * discards the override and reads `models.yml` from `~/.omp/profiles/<name>/agent`.
 * A MiniMax run would then silently lose `requiresThinkingAsText` instead of
 * failing, so refuse to start rather than measure the wrong configuration.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null} the offending variable, or null when the override holds
 */
export function ignoredAgentDirOverride(env = process.env) {
  for (const name of ["OMP_PROFILE", "PI_PROFILE"]) {
    if (env[name]?.trim()) return name;
  }
  return null;
}

function usage() {
  return [
    "Usage: npm run eval -- --model-a <model> --model-b <model> [options]",
    "",
    "Runs five fixed Backlog.md workflow prompts once per model in fresh temporary projects.",
    "",
    "Options:",
    "  --model-a <model>     First OMP model (required).",
    "  --model-b <model>     Second OMP model (required).",
    "  --max-time <duration> Per-run OMP limit; default: 5m.",
    "  --tasks <ids>         Comma-separated task IDs; default: all five.",
    "  --keep                Preserve generated workspaces and state directories.",
    "  --output <path>       Write the JSON report to this file as well as stdout.",
  ].join("\n");
}

function options(argv) {
  const parsed = { maxTime: "5m", taskIds: null, keep: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--keep") {
      parsed.keep = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--model-a") parsed.modelA = value;
    else if (argument === "--model-b") parsed.modelB = value;
    else if (argument === "--max-time") parsed.maxTime = value;
    else if (argument === "--tasks") parsed.taskIds = new Set(value.split(",").filter(Boolean));
    else if (argument === "--output") parsed.output = value;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!parsed.modelA || !parsed.modelB) throw new Error("--model-a and --model-b are required");
  return parsed;
}

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ ok: false, code: null, stdout, stderr, error: error.message }));
    child.on("close", (code, signal) => resolve({ ok: code === 0, code, signal, stdout, stderr }));
  });
}

async function workspaceFor(task) {
  const workspace = mkdtempSync(join(tmpdir(), `backlog-md-eval-${task.id}-`));
  const init = await run(
    "backlog",
    ["init", "Backlog evaluation", "--defaults", "--agent-instructions", "none", "--no-git"],
    {
      cwd: workspace,
    },
  );
  if (!init.ok) throw new Error(`backlog init failed: ${init.stderr || init.stdout || init.error || init.code}`);
  const seeded = await run(
    "backlog",
    [
      "task",
      "create",
      task.seed.title,
      "-d",
      task.seed.description,
      ...task.seed.criteria.flatMap((criterion) => ["--ac", criterion]),
    ],
    { cwd: workspace },
  );
  if (!seeded.ok)
    throw new Error(`backlog task create failed: ${seeded.stderr || seeded.stdout || seeded.error || seeded.code}`);
  return workspace;
}

function metricsFor(workspace, stateDir) {
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateDir;
  try {
    // The summary is written synchronously at shutdown, before the detached
    // flush worker that removes the journal exists — so it is here by the time
    // OMP has exited. The journal is the fallback for a run that was killed
    // before its shutdown handler ran.
    const summary = listSessionSummaries(workspace)[0];
    if (summary) return { sessionId: summary.sessionId, metrics: summary.metrics };
    const session = listSessions(workspace)[0];
    return session
      ? { sessionId: session.sessionId, metrics: deriveSession(workspace, session.sessionId).metrics }
      : null;
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
}

function emptyMetrics() {
  return {
    guards: 0,
    toolCalls: {},
    acceptanceChecks: 0,
    unplannedStarts: 0,
    unfinishedSessions: 0,
    steeringMessages: 0,
    tasklessContinues: 0,
  };
}

function addMetrics(total, metrics) {
  total.guards += metrics.guards;
  total.acceptanceChecks += metrics.acceptanceChecks;
  total.unplannedStarts += metrics.unplannedStarts;
  total.unfinishedSessions += metrics.unfinishedSessions;
  total.steeringMessages += metrics.steeringMessages;
  // Sessions summarised before BCC-4 carry no such counter.
  total.tasklessContinues += metrics.tasklessContinues ?? 0;
  for (const [tool, count] of Object.entries(metrics.toolCalls)) {
    total.toolCalls[tool] = (total.toolCalls[tool] ?? 0) + count;
  }
  return total;
}

export function compareMetrics(results) {
  const totals = new Map();
  for (const result of results) {
    const total = totals.get(result.model) ?? emptyMetrics();
    totals.set(result.model, addMetrics(total, result.metrics ?? emptyMetrics()));
  }
  return Object.fromEntries(totals);
}

async function evaluate(task, model, config) {
  const workspace = await workspaceFor(task);
  const stateDir = mkdtempSync(join(tmpdir(), `backlog-md-eval-state-${task.id}-`));
  const agentDir = join(stateDir, "agent");
  const modelsConfig = modelsConfigFor(model);
  if (modelsConfig) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.yml"), modelsConfig);
  }
  const started = performance.now();
  try {
    const execution = await run(
      process.env.OMP_BIN || "omp",
      [
        "--print",
        "--mode",
        "json",
        "--auto-approve",
        "--no-prewalk",
        "--max-time",
        config.maxTime,
        "--model",
        model,
        "--cwd",
        workspace,
        "--plugin-dir",
        root,
        // `--plugin-dir` publishes commands, skills, rules, agents and MCP from
        // the work tree, but an extension module is read only from a registry
        // plugin's `omp.extensions` manifest field, and an injected root has no
        // registry entry. Measured against OMP 18.0.11 (BCC-5): a project-scope
        // registry install with that field registers all six native tools,
        // while the same install with the field pointing at a missing file,
        // with the field removed, or with an undeclared `extensions/` directory
        // loads nothing at all — there is no conventional folder scan.
        // Disabling ambient discovery and naming the module keeps the measured
        // build the work tree's, not an installed copy's.
        "--no-extensions",
        "-e",
        join(root, "omp", "index.mjs"),
        task.prompt,
      ],
      {
        cwd: workspace,
        env: { ...process.env, XDG_STATE_HOME: stateDir, PI_CODING_AGENT_DIR: agentDir },
      },
    );
    const observed = metricsFor(workspace, stateDir);
    // No session state means the extension never recorded anything — it was
    // not loaded, or the run died before its shutdown handler. Either way the
    // run measured nothing, and zeroed metrics would read as a clean result
    // instead of a missing one.
    const missing = observed === null;
    return {
      task: task.id,
      model,
      ok: execution.ok && !missing,
      exitCode: execution.code,
      signal: execution.signal ?? null,
      durationMs: Math.round(performance.now() - started),
      sessionId: observed?.sessionId ?? null,
      metrics: observed?.metrics ?? null,
      ...(missing ? { failure: "no Backlog.md session state was recorded for this run" } : {}),
      stderr: execution.ok ? "" : execution.stderr.trim(),
      ...(config.keep ? { workspace, stateDir } : {}),
    };
  } finally {
    if (!config.keep) {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const config = options(argv);
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const profileVariable = ignoredAgentDirOverride();
  if (profileVariable) {
    throw new Error(
      `${profileVariable} is set: OMP ignores PI_CODING_AGENT_DIR under a profile, so this run would use the profile's models.yml instead of the one written for it. Unset ${profileVariable} and re-run.`,
    );
  }
  const tasks = config.taskIds ? EVALUATION_TASKS.filter((task) => config.taskIds.has(task.id)) : EVALUATION_TASKS;
  if (tasks.length === 0) throw new Error("--tasks selected no known evaluation tasks");
  const unknown = config.taskIds
    ? [...config.taskIds].filter((id) => !EVALUATION_TASKS.some((task) => task.id === id))
    : [];
  if (unknown.length > 0) throw new Error(`Unknown evaluation task IDs: ${unknown.join(", ")}`);

  const results = [];
  for (const task of tasks) {
    for (const model of [config.modelA, config.modelB]) {
      results.push(await evaluate(task, model, config));
    }
  }
  const report = {
    tasks: tasks.map((task) => task.id),
    models: [config.modelA, config.modelB],
    results,
    totals: compareMetrics(results),
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (config.output) writeFileSync(config.output, output);
  process.stdout.write(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
  });
}
