#!/usr/bin/env node
// What the hooks cost per turn (BCC-27).
//
// Drives each hook the way Claude Code does — one process, JSON on stdin —
// against a throwaway copy of this repository's own backlog, and reads the
// elapsed milliseconds the hook records in debug.jsonl. Two numbers per
// scenario: the time inside the hook, which is what the plugin controls, and
// the whole child process, which is what the session waits for.
//
// Usage: node scripts/measure-latency.mjs [runs]
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNS = Number(process.argv[2] || 15);

const state = mkdtempSync(join(tmpdir(), "backlog-md-latency-state-"));
const project = mkdtempSync(join(tmpdir(), "backlog-md-latency-project-"));
cpSync(join(REPO, "backlog"), join(project, "backlog"), { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, "src", "app.ts"), "export const x = 1;\n");
for (const args of [
  ["init", "-q", "."],
  ["config", "user.email", "t@example.com"],
  ["config", "user.name", "T"],
]) {
  execFileSync("git", args, { cwd: project });
}

const env = { ...process.env, XDG_STATE_HOME: state, BACKLOG_MD_DEBUG: "1" };
const edited = { file_path: join(project, "src", "app.ts") };
const hook = (file, payload) =>
  spawnSync(process.execPath, [join(REPO, "hooks", file)], {
    cwd: project,
    env,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });

/** Any task file of the copied backlog — the deny path needs a real one. */
const taskFile = join(project, "backlog", "tasks", readdirSync(join(project, "backlog", "tasks")).sort()[0]);

/** @type {[string, string, (i: number) => object, ((i: number) => void)?][]} */
const scenarios = [
  ["SessionStart", "session-start.mjs", (i) => ({ session_id: `s${i}`, cwd: project, source: "startup" })],
  [
    "UserPromptSubmit (plain prompt)",
    "user-prompt-submit.mjs",
    (i) => ({ session_id: `s${i}`, cwd: project, prompt: "make the parser handle empty input" }),
  ],
  [
    "UserPromptSubmit (after edits)",
    "user-prompt-submit.mjs",
    (i) => ({ session_id: `s${i}`, cwd: project, prompt: "now make it handle empty input" }),
    (i) => {
      for (let k = 0; k < 3; k++)
        hook("post-tool-use.mjs", { session_id: `s${i}`, cwd: project, tool_name: "Edit", tool_input: edited });
    },
  ],
  [
    "UserPromptSubmit (three task ids)",
    "user-prompt-submit.mjs",
    (i) => ({ session_id: `s${i}`, cwd: project, prompt: "compare BCC-901 with BCC-902 and BCC-903" }),
  ],
  [
    "PostToolUse",
    "post-tool-use.mjs",
    (i) => ({ session_id: `s${i}`, cwd: project, tool_name: "Edit", tool_input: edited }),
  ],
  [
    "PreToolUse (allow)",
    "pre-tool-use.mjs",
    (i) => ({ session_id: `s${i}`, cwd: project, tool_name: "Edit", tool_input: edited }),
  ],
  [
    "PreToolUse (deny)",
    "pre-tool-use.mjs",
    (i) => ({
      session_id: `s${i}`,
      cwd: project,
      tool_name: "Edit",
      tool_input: { file_path: taskFile },
    }),
  ],
  ["SessionEnd", "session-end.mjs", (i) => ({ session_id: `s${i}`, cwd: project, reason: "exit" })],
];

const log = join(state, "backlog-md-cc", "debug.jsonl");
const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return sorted.length === 0 ? { median: "-", p95: "-" } : { median: at(0.5).toFixed(0), p95: at(0.95).toFixed(0) };
}

for (const [label, file, payload, setup] of scenarios) {
  const before = lines().length;
  const walls = [];
  for (let i = 0; i < RUNS; i++) {
    if (setup) setup(i);
    const started = process.hrtime.bigint();
    hook(file, payload(i));
    walls.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const recorded = lines()
    .slice(before)
    .map((l) => JSON.parse(l))
    .filter((r) => r.hook === file && typeof r.ms === "number")
    .map((r) => r.ms);
  const inHook = stats(recorded);
  const process_ = stats(walls);
  console.log(
    `${label.padEnd(34)} in-hook ${String(inHook.median).padStart(5)}ms / p95 ${String(inHook.p95).padStart(5)}ms   ` +
      `process ${String(process_.median).padStart(5)}ms / p95 ${String(process_.p95).padStart(5)}ms`,
  );
}

rmSync(state, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
