import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { checkStaged } from "../../scripts/backlog-cc.mjs";

/**
 * checkStaged (scripts/backlog-cc.mjs) blocks a commit only on a *positive*
 * parse failure (`cli-error` or `unparseable`) — `cli-missing` and `timeout`
 * say nothing about the file itself and must pass. Neither branch had a
 * test. This is exactly the environment the project's own diagnosis already
 * worries about: a version manager (mise, asdf) shims node/backlog into
 * interactive shells only, so a regression collapsing this filter to
 * `if (!view.ok)` would block every commit touching a task file wherever
 * that's true.
 *
 * The PATH below keeps git resolvable while excluding wherever `backlog` is
 * actually installed (a shim directory, typically not where git lives), so
 * a spawn of "backlog" genuinely cannot find it.
 */
const GIT_DIR = dirname(execSync("command -v git").toString().trim());
const NO_BACKLOG_PATH = [GIT_DIR, "/usr/bin", "/bin"].join(":");
// node's own directory is often the same shim directory `backlog` lives in
// (mise, nvm) — fine to include, since a stand-in "backlog" placed earlier
// on PATH still wins the lookup for that name.
const NODE_DIR = dirname(process.execPath);

function backlogResolvesUnder(pathEnv) {
  try {
    execSync("command -v backlog", { env: { PATH: pathEnv } });
    return true;
  } catch {
    return false;
  }
}

function makeStagedTaskProject(count = 1) {
  const root = mkdtempSync(join(tmpdir(), "bcc-check-staged-"));
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(root, "backlog", "config.yml"), "statuses: [To Do]\n");
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(root, "backlog", "tasks", `TASK-${i} - Sample.md`), `---\nid: TASK-${i}\n---\n# Sample\n`);
  }
  execSync("git init -q .", { cwd: root });
  execSync("git config user.email t@example.com", { cwd: root });
  execSync("git config user.name Test", { cwd: root });
  execSync("git add -A", { cwd: root });
  return root;
}

async function withPath(pathEnv, fn) {
  const original = process.env.PATH;
  process.env.PATH = pathEnv;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

test("checkStaged passes a staged task file when the CLI cannot be found, rather than blocking on uncertainty", async (t) => {
  if (backlogResolvesUnder(NO_BACKLOG_PATH)) {
    return t.skip("backlog is reachable even without its usual directory on PATH; cannot isolate cli-missing here");
  }
  const root = makeStagedTaskProject();
  try {
    const result = await withPath(NO_BACKLOG_PATH, () => checkStaged({ cwd: root }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.checked, [join("backlog", "tasks", "TASK-1 - Sample.md")]);
    assert.deepEqual(result.broken, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkStaged passes a staged task file when the CLI times out, rather than blocking on uncertainty", async () => {
  const root = makeStagedTaskProject();
  const binDir = mkdtempSync(join(tmpdir(), "bcc-hang-bin-"));
  try {
    // A `#!/bin/sh` wrapper around `sleep` forks a grandchild that outlives
    // the SIGKILL `run()` sends to the immediate child, leaking an orphaned
    // process that holds the stdio pipes open and hangs the test file after
    // this test itself passes. A single node process hangs in place, exactly
    // like fake-backlog.mjs's own "hang" mode, so SIGKILL actually ends it.
    writeFileSync(join(binDir, "backlog"), "#!/usr/bin/env node\nsetTimeout(() => {}, 999000);\n", { mode: 0o755 });
    const result = await withPath(`${binDir}:${NODE_DIR}:${NO_BACKLOG_PATH}`, () => checkStaged({ cwd: root }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.checked, [join("backlog", "tasks", "TASK-1 - Sample.md")]);
    assert.deepEqual(result.broken, []);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

/** A `backlog` that answers correctly, but slowly enough to be worth budgeting. */
const SLOW_MS = 200;
function slowBacklog() {
  const dir = mkdtempSync(join(tmpdir(), "bcc-slow-bin-"));
  const task = JSON.stringify({ schemaVersion: 1, kind: "task-view", task: { id: "TASK-1", title: "Sample" } });
  writeFileSync(
    join(dir, "backlog"),
    `#!/usr/bin/env node\nsetTimeout(() => process.stdout.write(${JSON.stringify(task)} + "\\n"), ${SLOW_MS});\n`,
    { mode: 0o755 },
  );
  return dir;
}

// One taskView per staged file, sequentially, each with the CLI wrapper's own
// 3s timeout and — before BCC-26 — no cap over the whole run. A commit that
// renames a column stages dozens of task files, and dozens of worst cases in
// a row is a pre-commit hook that looks hung. The budget lets the remainder
// through unchecked instead, which is what the rest of this check does with
// every other uncertainty.
test("checkStaged stops at its budget and lets the rest of a large commit through", async () => {
  const root = makeStagedTaskProject(40);
  const binDir = slowBacklog();
  try {
    const started = Date.now();
    const result = await withPath(`${binDir}:${NODE_DIR}:${NO_BACKLOG_PATH}`, () =>
      checkStaged({ cwd: root, budgetMs: 600 }),
    );
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checked.length, 40);
    assert.ok(result.skipped > 0, `nothing was skipped in ${elapsed}ms: ${JSON.stringify(result)}`);
    // Unbudgeted this run is 40 x SLOW_MS = 8s. Half of that is generous
    // room for a loaded machine and still nowhere near the unbudgeted cost.
    assert.ok(elapsed < 4000, `took ${elapsed}ms, which is not a budget`);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// The other half: a budget that gives up early on an ordinary commit would
// turn the check off without saying so.
test("checkStaged with room to finish skips nothing", async () => {
  const root = makeStagedTaskProject(3);
  const binDir = slowBacklog();
  try {
    const result = await withPath(`${binDir}:${NODE_DIR}:${NO_BACKLOG_PATH}`, () => checkStaged({ cwd: root }));
    assert.equal(result.skipped, 0, JSON.stringify(result));
    assert.equal(result.checked.length, 3);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
