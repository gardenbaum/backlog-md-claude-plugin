import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectDoctor, formatDoctor, HOOK_MARKER, HOOK_NAMES } from "../../scripts/backlog-cc.mjs";
import {
  appendEvent,
  clearJournal,
  journalPath,
  recordRuntimeFailure,
  stateBase,
  writeCache,
  writeSessionSummary,
} from "../../lib/cache.mjs";
import { run } from "../../lib/proc.mjs";
import { ABANDONED_AFTER_MS, sweepAbandoned } from "../../lib/session-sweep.mjs";

// This repository's own root — a hint that really does resolve, which is what
// the core.hooksPath tests below need their hooks to carry.
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Run a doctor collection with no plugin reachable except through the hooks'
 * own hint: an empty HOME, so the marketplace-cache scan finds nothing, and no
 * CLAUDE_PLUGIN_ROOT, so the environment of whoever runs the suite cannot
 * decide the result (BCC-14).
 */
async function withEmptyHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "bcc-empty-home-"));
  const { HOME, CLAUDE_PLUGIN_ROOT } = process.env;
  process.env.HOME = home;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  try {
    return await fn();
  } finally {
    if (HOME === undefined) delete process.env.HOME;
    else process.env.HOME = HOME;
    if (CLAUDE_PLUGIN_ROOT !== undefined) process.env.CLAUDE_PLUGIN_ROOT = CLAUDE_PLUGIN_ROOT;
    rmSync(home, { recursive: true, force: true });
  }
}

function projectDir() {
  const root = mkdtempSync(join(tmpdir(), "bcc-doctor-"));
  mkdirSync(join(root, "backlog"));
  writeFileSync(join(root, "backlog", "config.yml"), "statuses: [To Do]\n");
  return root;
}

/** `projectDir()` plus a real `git init`, needed to set `core.hooksPath`. */
async function gitProjectDir() {
  const root = projectDir();
  await run("git", ["init", "-q", "."], { cwd: root });
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  return root;
}

test("the report names the node version it is running under", async () => {
  const r = await collectDoctor({ cwd: projectDir(), sessionId: "s" });
  assert.equal(r.node.version, process.version);
});

test("Doctor renders recent per-session behavior counters", async () => {
  const root = projectDir();
  for (const event of [
    { t: "metric", name: "guard" },
    { t: "metric", name: "tool", tool: "backlog_task_plan" },
    { t: "metric", name: "tool", tool: "backlog_task_plan" },
    { t: "metric", name: "acceptance-check" },
    { t: "metric", name: "unplanned-start" },
    { t: "metric", name: "unfinished-session" },
    { t: "metric", name: "steering" },
  ]) {
    appendEvent(root, "metric-session", event);
  }

  const report = await collectDoctor({ cwd: root, sessionId: "s" });
  assert.deepEqual(report.sessionMetrics, [
    {
      sessionId: "metric-session",
      metrics: {
        guards: 1,
        toolCalls: { backlog_task_plan: 2 },
        acceptanceChecks: 1,
        unplannedStarts: 1,
        unfinishedSessions: 1,
        steeringMessages: 1,
      },
    },
  ]);
  assert.match(
    formatDoctor(report),
    /recent behavior counters \(last 1 session\):[\s\S]*metric-session: guards 1; tool calls backlog_task_plan ×2; acceptance checks 1; unplanned starts 1; unfinished sessions 1; steering messages 1/i,
  );
});

test("Doctor reports counters for a session whose flush already removed its journal", async () => {
  const root = projectDir();
  appendEvent(root, "flushed-session", { t: "metric", name: "acceptance-check" });
  writeSessionSummary(root, "flushed-session");
  // What the detached flush worker does on every terminal outcome.
  clearJournal(root, "flushed-session");

  const report = await collectDoctor({ cwd: root, sessionId: "s" });
  assert.deepEqual(report.sessionMetrics, [
    {
      sessionId: "flushed-session",
      metrics: {
        guards: 0,
        toolCalls: {},
        acceptanceChecks: 1,
        unplannedStarts: 0,
        unfinishedSessions: 0,
        steeringMessages: 0,
      },
    },
  ]);
});

// Five journals left behind by sessions that crashed an hour ago used to fill
// the report and hide every session that ended properly, because open journals
// were merged ahead of stored summaries regardless of age.
test("Doctor reports the most recent sessions, not every open journal first", async () => {
  const root = projectDir();
  const aged = Date.now() / 1000 - 3600;
  for (let index = 0; index < 5; index += 1) {
    appendEvent(root, `stale-${index}`, { t: "metric", name: "guard" });
    utimesSync(journalPath(root, `stale-${index}`), aged, aged);
  }
  appendEvent(root, "finished", { t: "metric", name: "acceptance-check" });
  writeSessionSummary(root, "finished");
  clearJournal(root, "finished");

  const report = await collectDoctor({ cwd: root, sessionId: "s" });
  assert.equal(report.sessionMetrics.length, 5);
  assert.equal(report.sessionMetrics[0].sessionId, "finished");
  assert.equal(report.sessionMetrics[0].metrics.acceptanceChecks, 1);
});

// End to end for the path a killed session takes: the sweep freezes its
// counters into a summary, and the report reads them from there.
test("Doctor reports the counters of a session the sweep collected", async () => {
  const root = projectDir();
  appendEvent(root, "killed-session", { t: "metric", name: "steering" });
  const when = new Date(Date.now() - 2 * ABANDONED_AFTER_MS);
  utimesSync(journalPath(root, "killed-session"), when, when);

  const swept = await sweepAbandoned({ repoRoot: root, sessionId: "live" });
  assert.deepEqual(swept.swept, ["killed-session"]);

  const report = await collectDoctor({ cwd: root, sessionId: "live" });
  assert.deepEqual(report.sessionMetrics, [
    {
      sessionId: "killed-session",
      metrics: {
        guards: 0,
        toolCalls: {},
        acceptanceChecks: 0,
        unplannedStarts: 0,
        unfinishedSessions: 0,
        steeringMessages: 1,
      },
    },
  ]);
});

test("the report probes the configured worker Node separately from its host runtime", async () => {
  const original = process.env.BACKLOG_MD_NODE;
  const root = projectDir();
  try {
    process.env.BACKLOG_MD_NODE = join(root, "missing-node");
    const missing = await collectDoctor({ cwd: root, sessionId: "s" });
    assert.equal(missing.node.version, process.version);
    assert.equal(missing.workerNode.reachable, false);
    assert.match(formatDoctor(missing), /FAIL worker node[\s\S]*BACKLOG_MD_NODE/);

    process.env.BACKLOG_MD_NODE = process.execPath;
    const reachable = await collectDoctor({ cwd: root, sessionId: "s" });
    assert.equal(reachable.workerNode.reachable, true);
    assert.equal(reachable.workerNode.supported, true);
    assert.match(reachable.workerNode.version, /^v\d+/);
  } finally {
    if (original === undefined) delete process.env.BACKLOG_MD_NODE;
    else process.env.BACKLOG_MD_NODE = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the report surfaces unresolved OMP failures without a stale success line", async () => {
  const root = projectDir();
  recordRuntimeFailure(root, "OMP session_start", new Error("message failed"), 1);
  const r = await collectDoctor({ cwd: root, sessionId: "s" });
  const output = formatDoctor(r);
  assert.match(output, /FAIL OMP session_start failed[\s\S]*message failed/);
  assert.doesNotMatch(output, /OMP session_start.*(?:ok|succeeded)/i);
});

test("the report locates the project when there is one", async () => {
  const root = projectDir();
  const r = await collectDoctor({ cwd: root, sessionId: "s" });
  assert.equal(r.project.found, true);
  assert.equal(r.project.root, root);
});

test("the report says so plainly when there is no project", async () => {
  const r = await collectDoctor({ cwd: mkdtempSync(join(tmpdir(), "bcc-none-")), sessionId: "s" });
  assert.equal(r.project.found, false);
});

// What `omp plugin install --scope project` writes: the registry entry lives
// in the project while the copy stays in the user cache, and `omp plugin
// uninstall` in the other scope removes that copy without touching this entry
// — so a registered path that no longer exists is a state Doctor has to name
// (BCC-5, measured against OMP 18.0.11).
test("Doctor reports a project-scope installation and fails once its directory is gone", async () => {
  const home = mkdtempSync(join(tmpdir(), "bcc-doctor-project-home-"));
  const root = projectDir();
  const installed = mkdtempSync(join(tmpdir(), "bcc-doctor-install-"));
  const registry = join(root, ".omp", "plugins", "installed_plugins.json");
  mkdirSync(dirname(registry), { recursive: true });
  writeFileSync(
    registry,
    JSON.stringify({
      version: 2,
      plugins: { "backlog-md@gardenbaum": [{ scope: "project", installPath: installed, version: "0.3.0" }] },
    }),
  );

  try {
    const report = await collectDoctor({ cwd: root, sessionId: "s", home });
    assert.deepEqual(report.installations.paths, [
      { installPath: installed, versions: ["0.3.0"], sources: ["project registry"], present: true },
    ]);
    const output = formatDoctor(report);
    assert.match(output, new RegExp(`Backlog\\.md plugin ${installed} \\(version 0\\.3\\.0\\) via project registry`));
    assert.doesNotMatch(output, /directory is gone/);

    rmSync(installed, { recursive: true, force: true });
    const dangling = await collectDoctor({ cwd: root, sessionId: "s", home });
    assert.equal(dangling.installations.paths[0].present, false);
    assert.match(formatDoctor(dangling), /FAIL Backlog\.md plugin[\s\S]*directory is gone/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(installed, { recursive: true, force: true });
  }
});

test("Doctor fails on active Backlog installations from distinct registries", async () => {
  const home = mkdtempSync(join(tmpdir(), "bcc-doctor-home-"));
  const root = projectDir();
  const claudePath = "/opt/claude/backlog-md/1.0.0";
  const ompPath = "/opt/omp/backlog-md/2.0.0";
  const writeRegistry = (path, entry) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2, plugins: { "backlog-md@gardenbaum": [entry] } }));
  };

  try {
    writeRegistry(join(home, ".claude", "plugins", "installed_plugins.json"), {
      installPath: claudePath,
      version: "1.0.0",
      enabled: true,
    });
    writeRegistry(join(home, ".omp", "plugins", "installed_plugins.json"), {
      installPath: ompPath,
      version: "2.0.0",
      enabled: true,
    });

    const report = await collectDoctor({ cwd: root, sessionId: "s", home });
    assert.equal(report.installations.duplicate, true);
    assert.match(formatDoctor(report), new RegExp(claudePath));
    assert.match(formatDoctor(report), new RegExp(ompPath));
    assert.match(formatDoctor(report), /1\.0\.0/);
    assert.match(formatDoctor(report), /2\.0\.0/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("hookRuns is reported as never when no hook has recorded a run", async () => {
  const r = await collectDoctor({ cwd: projectDir(), sessionId: "fresh-session" });
  assert.deepEqual(r.hooks.runs, {});
  assert.equal(r.hooks.everRan, false);
});

test("hookRuns reflects what a hook recorded in the cache", async () => {
  const root = projectDir();
  writeCache(root, "s", { hookRuns: { SessionStart: "2026-08-20T12:00:00.000Z" } });
  const r = await collectDoctor({ cwd: root, sessionId: "s" });
  assert.equal(r.hooks.everRan, true);
  assert.equal(r.hooks.runs.SessionStart, "2026-08-20T12:00:00.000Z");
});

test("the report includes the cache path and it is outside the repository", async () => {
  const root = projectDir();
  const r = await collectDoctor({ cwd: root, sessionId: "s" });
  assert.ok(r.cache.path.startsWith(stateBase()), `expected a state-dir path, got ${r.cache.path}`);
  assert.ok(!r.cache.path.startsWith(root));
});

test("the formatted report omits hook-reachability advice when there is no project", async () => {
  const r = await collectDoctor({ cwd: mkdtempSync(join(tmpdir(), "bcc-none-")), sessionId: "s" });
  const output = formatDoctor(r);
  assert.ok(!output.includes("hook has recorded a run"));
  assert.ok(!output.includes("PATH"));
});

test("the formatted report still reports hook reachability when there is a project", async () => {
  const r = await collectDoctor({ cwd: projectDir(), sessionId: "fresh-session-2" });
  const output = formatDoctor(r);
  assert.ok(output.includes("no hook has recorded a run"));
});

test("the guard is reported enabled by default", async () => {
  const original = process.env.BACKLOG_MD_GUARD;
  delete process.env.BACKLOG_MD_GUARD;
  try {
    const r = await collectDoctor({ cwd: projectDir(), sessionId: "s" });
    assert.equal(r.guard.enabled, true);
    assert.match(formatDoctor(r), /guard.*enabled/i);
  } finally {
    if (original === undefined) delete process.env.BACKLOG_MD_GUARD;
    else process.env.BACKLOG_MD_GUARD = original;
  }
});

test("the guard is reported disabled when BACKLOG_MD_GUARD=0", async () => {
  const original = process.env.BACKLOG_MD_GUARD;
  process.env.BACKLOG_MD_GUARD = "0";
  try {
    const r = await collectDoctor({ cwd: projectDir(), sessionId: "s" });
    assert.equal(r.guard.enabled, false);
    assert.match(formatDoctor(r), /guard.*disabled/i);
  } finally {
    if (original === undefined) delete process.env.BACKLOG_MD_GUARD;
    else process.env.BACKLOG_MD_GUARD = original;
  }
});

// projectDir() builds the shape findProject actually recognises (a
// backlog/config.yml, not a bare root config with no backlog dir beside it)
// — plus the .git/hooks directory these tests need on top of it.
test("the report says the git hooks are absent when nothing is installed", async () => {
  const dir = projectDir();
  try {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const r = await collectDoctor({ cwd: dir });
    assert.equal(
      r.git.hooks.every((h) => h.installed === false),
      true,
      JSON.stringify(r.git),
    );
    assert.match(formatDoctor(r), /git hooks not installed/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The one hook state a person still has to act on: ours, installed, and
// resolving to nothing at all — an uninstalled plugin, or a cache the update
// emptied. The old report called a moved directory `stale`; a moved directory
// is now found again, so only genuine absence is worth a FAIL (BCC-14).
test("hooks that resolve to no plugin at all are reported as doing nothing", async () => {
  const dir = projectDir();
  try {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(
      join(dir, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\n${HOOK_MARKER}\nPLUGIN_ROOT_HINT='/gone/backlog-md/0.0.1'\n`,
      { mode: 0o755 },
    );
    const r = await withEmptyHome(() => collectDoctor({ cwd: dir }));
    const hook = r.git.hooks.find((h) => h.name === "pre-commit");
    assert.equal(hook.installed, true);
    assert.equal(hook.ours, true);
    assert.equal(r.git.resolvedRoot, null, JSON.stringify(r.git));
    assert.match(formatDoctor(r), /resolve to no plugin/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same hook, with the plugin present in the marketplace cache it never
// heard of. Nothing was reinstalled and nothing is wrong: the hook resolves.
test("a hook whose hint is gone is fine when the cache still holds the plugin", async () => {
  const dir = projectDir();
  const home = mkdtempSync(join(tmpdir(), "bcc-home-"));
  const cached = join(home, ".claude", "plugins", "cache", "m", "backlog-md", "0.9.0");
  const { HOME } = process.env;
  try {
    mkdirSync(join(cached, "scripts"), { recursive: true });
    writeFileSync(join(cached, "scripts", "backlog-cc.mjs"), "// stand-in\n");
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    for (const name of HOOK_NAMES) {
      writeFileSync(join(dir, ".git", "hooks", name), `#!/bin/sh\n${HOOK_MARKER}\nPLUGIN_ROOT_HINT='/gone'\n`, {
        mode: 0o755,
      });
    }

    process.env.HOME = home;
    const r = await collectDoctor({ cwd: dir });
    assert.equal(r.git.resolvedRoot, cached);
    assert.equal(r.git.resolvesHere, false);
    const report = formatDoctor(r);
    assert.doesNotMatch(report, /resolve to no plugin/i);
    assert.match(report, /git hooks installed/i);
  } finally {
    if (HOME === undefined) delete process.env.HOME;
    else process.env.HOME = HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a foreign hook is reported as present but not ours", async () => {
  const dir = projectDir();
  try {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = await collectDoctor({ cwd: dir });
    const hook = r.git.hooks.find((h) => h.name === "pre-commit");
    assert.equal(hook.installed, true);
    assert.equal(hook.ours, false);
    assert.equal(hook.hint, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `install-hooks --shared` writes to `.githooks` and sets `core.hooksPath` —
// the one install mode where a hard-coded `.git/hooks` path is guaranteed to
// be wrong for every clone. Measured: after a real `--shared` install the
// hooks demonstrably run, yet a `gitHookState` that ignores `core.hooksPath`
// reports them as absent, so `/backlog-md:doctor` never surfaces staleness
// for the one mode that needs it most.
test("a shared install (.githooks + core.hooksPath) is reported as installed, not absent", async () => {
  const dir = await gitProjectDir();
  try {
    const sharedDir = join(dir, ".githooks");
    mkdirSync(sharedDir, { recursive: true });
    for (const name of HOOK_NAMES) {
      writeFileSync(join(sharedDir, name), `#!/bin/sh\n${HOOK_MARKER}\nPLUGIN_ROOT_HINT='${PLUGIN_ROOT}'\n`, {
        mode: 0o755,
      });
    }
    await run("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir });

    const r = await collectDoctor({ cwd: dir });
    assert.equal(r.git.hooksPath, sharedDir);
    assert.equal(
      r.git.hooks.every((h) => h.installed && h.ours),
      true,
      JSON.stringify(r.git),
    );
    assert.equal(r.git.resolvesHere, true);
    assert.match(formatDoctor(r), /git hooks installed/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The mirror case: `core.hooksPath` points somewhere else entirely (husky's
// `.husky`, for instance). Git never runs `.git/hooks` in that configuration,
// so a marker file sitting there — left by an install that predates the
// foreign hooksPath, say — must be reported inactive, not installed.
test("a foreign core.hooksPath means our .git/hooks install is reported as inactive, not installed", async () => {
  const dir = await gitProjectDir();
  try {
    writeFileSync(
      join(dir, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\n${HOOK_MARKER}\nPLUGIN_ROOT_HINT='${PLUGIN_ROOT}'\n`,
      { mode: 0o755 },
    );
    mkdirSync(join(dir, ".husky"), { recursive: true });
    await run("git", ["config", "core.hooksPath", ".husky"], { cwd: dir });

    const r = await collectDoctor({ cwd: dir });
    assert.equal(r.git.hooksPath, join(dir, ".husky"));
    const hook = r.git.hooks.find((h) => h.name === "pre-commit");
    assert.equal(hook.installed, false, JSON.stringify(hook));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Run the CLI as a real entry point with its first stdout write rigged to
 * throw, which is the cheapest way to get an error out of `doctor` itself
 * rather than out of a stand-in for it.
 */
async function doctorThatThrows({ debug }) {
  const dir = mkdtempSync(join(tmpdir(), "bcc-cli-catch-"));
  const preload = join(dir, "boom.mjs");
  writeFileSync(
    preload,
    "const write = process.stdout.write.bind(process.stdout);\n" +
      "let armed = true;\n" +
      "process.stdout.write = (...a) => {\n" +
      '  if (armed) { armed = false; throw new Error("doctor blew up"); }\n' +
      "  return write(...a);\n" +
      "};\n",
  );
  const cli = join(PLUGIN_ROOT, "scripts", "backlog-cc.mjs");
  const env = { ...process.env, XDG_STATE_HOME: dir, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` };
  if (debug) env.BACKLOG_MD_DEBUG = "1";
  else delete env.BACKLOG_MD_DEBUG;
  const r = await run(process.execPath, [cli, "doctor"], { cwd: projectDir(), env, timeoutMs: 20000 });
  return { dir, log: join(dir, "backlog-md-cc", "debug.jsonl"), r };
}

// guard() records what it swallows; this path swallowed silently, so the two
// commands somebody runs *because* something is wrong — doctor and setup —
// were the two with no trace of their own (BCC-28).
test("an error thrown inside doctor reaches debug.jsonl when the knob is set", async () => {
  const { dir, log } = await doctorThatThrows({ debug: true });
  try {
    const records = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    const failure = records.find((x) => x.hook === "backlog-cc" && x.ok === false);
    assert.ok(failure, JSON.stringify(records));
    assert.equal(failure.event, "doctor");
    assert.match(failure.message, /doctor blew up/);
    assert.ok(failure.stack, "a record without a stack is barely a trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same error writes nothing at all with the knob unset", async () => {
  const { dir, log } = await doctorThatThrows({ debug: false });
  try {
    assert.equal(existsSync(log), false, "the debug log exists without the knob");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A report with nothing in it but the fields `formatDoctor` always reads, so
 * a config test asserts config lines and not the state of a temp directory.
 */
const configReport = (config) => ({
  node: { version: process.version, execPath: process.execPath },
  workerNode: { command: "node", reachable: true, version: process.version, supported: true },
  backlog: { reachable: true, version: "1.50.1" },
  project: { found: true, root: "/p", backlogDir: "/p/backlog", configPath: "/p/backlog/config.yml" },
  statuses: null,
  active: null,
  git: null,
  cache: { path: null, snapshot: null },
  hooks: { runs: {}, everRan: false },
  ompFailures: [],
  config,
  guard: { enabled: true },
  debug: { enabled: false, log: "/dev/null" },
});

const settled = (over = {}) => ({
  autoCommit: { value: "false", reason: null },
  bypassGitHooks: { value: "false", reason: null },
  checkActiveBranches: { value: "false", reason: null },
  remoteOperations: { value: "false", reason: null },
  onStatusChange: { value: null, reason: "unset" },
  ...over,
});

// BCC-40. Four Backlog.md settings move mechanisms this plugin depends on, and
// nothing checked or even named them.
test("doctor prints each config interaction with its consequence", () => {
  const output = formatDoctor(configReport(settled()));
  for (const key of ["autoCommit", "bypassGitHooks", "onStatusChange", "checkActiveBranches"]) {
    assert.match(output, new RegExp(`^ok +${key}.* — `, "m"), `no consequence line for ${key}`);
  }
});

test("autoCommit: true is a warn that names the unreviewed commit", () => {
  const output = formatDoctor(configReport(settled({ autoCommit: { value: "true", reason: null } })));
  assert.match(output, /^warn autoCommit: true .*SessionEnd flush.*nobody reviewed/m);
});

// The tripwire is the whole reason the pre-commit hook exists. A setting that
// silently retires it has to say so in the diagnosis.
test("bypassGitHooks: true is a warn that names the dead pre-commit tripwire", () => {
  const output = formatDoctor(configReport(settled({ bypassGitHooks: { value: "true", reason: null } })));
  assert.match(output, /^warn bypassGitHooks: true .*--no-verify.*pre-commit tripwire never runs/m);
});

test("a configured onStatusChange is a warn that names the callback", () => {
  const output = formatDoctor(configReport(settled({ onStatusChange: { value: "make sync", reason: null } })));
  assert.match(output, /^warn onStatusChange: make sync .*status change/m);
});

// A command line out of the repository's config, echoed into a diagnosis the
// agent reads back to the user: capped, like every other contributor string.
test("a long onStatusChange command is capped in the diagnosis", () => {
  const long = "x".repeat(500);
  const output = formatDoctor(configReport(settled({ onStatusChange: { value: long, reason: null } })));
  assert.ok(!output.includes(long), "the full command line was echoed");
  assert.match(output, /warn onStatusChange: x+…/);
});

// Not a warning: both are Backlog.md's defaults, and a diagnosis that warns
// about the default state teaches people to skip warnings. The line still has
// to name the risk, because that is where the brief goes missing.
test("both branch-check settings on together name the hooks' timeout risk", () => {
  const output = formatDoctor(
    configReport(
      settled({
        checkActiveBranches: { value: "true", reason: null },
        remoteOperations: { value: "true", reason: null },
      }),
    ),
  );
  assert.match(output, /checkActiveBranches: true with remoteOperations: true .*3s budget.*unavailable/);
});

// Fail open: a config read that did not answer says nothing about the project,
// so it must not turn into a warning or a failure.
test("an unreadable config value reports the reason and stays ok", () => {
  const output = formatDoctor(
    configReport(
      settled({
        autoCommit: { value: null, reason: "timeout" },
        bypassGitHooks: { value: null, reason: "cli-error" },
      }),
    ),
  );
  assert.match(output, /^ok +autoCommit: not set \(timeout\)/m);
  assert.match(output, /^ok +bypassGitHooks: not set \(cli-error\)/m);
  assert.ok(!output.includes("warn"), "an unreadable value escalated to a warning");
});

// `backlog config get onStatusChange` answers "Unknown config key" on 1.50.1
// even though the setting is parsed and honoured, so doctor reads it out of
// the project's own config.yml instead.
test("onStatusChange is read from config.yml, which no config get can reach", async (t) => {
  const root = projectDir();
  writeFileSync(join(root, "backlog", "config.yml"), "statuses: [To Do]\nonStatusChange: 'make sync'\n");
  const r = await collectDoctor({ cwd: root, sessionId: "s" });
  if (!r.config) return t.skip("backlog CLI not reachable");
  assert.equal(r.config.onStatusChange.value, "make sync");
});

// BCC-50. Hooks of ours in .git/hooks while core.hooksPath points elsewhere:
// they never run, and "not installed" — true of the live path — hid them.
test("doctor reports our hooks stranded outside the directory git reads", async () => {
  const root = await gitProjectDir();
  for (const name of HOOK_NAMES) {
    writeFileSync(join(root, ".git", "hooks", name), `#!/bin/sh\n${HOOK_MARKER}\nexit 0\n`, { mode: 0o755 });
  }
  mkdirSync(join(root, ".other"), { recursive: true });
  await run("git", ["config", "core.hooksPath", ".other"], { cwd: root });

  const output = formatDoctor(await collectDoctor({ cwd: root, sessionId: "s" }));
  assert.match(output, /^FAIL our hooks sit in \.git\/hooks .*but git runs hooks from .*they never run/m);
});

// The ordinary case must stay quiet: no core.hooksPath, hooks where git reads.
test("doctor says nothing about stranding when the hooks are where git reads them", async () => {
  const root = await gitProjectDir();
  for (const name of HOOK_NAMES) {
    writeFileSync(join(root, ".git", "hooks", name), `#!/bin/sh\n${HOOK_MARKER}\nexit 0\n`, { mode: 0o755 });
  }
  const output = formatDoctor(await collectDoctor({ cwd: root, sessionId: "s" }));
  assert.ok(!output.includes("they never run"), "reported stranding for a normal install");
});
