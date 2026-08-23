import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeProject, backlogAvailable } from "../helpers/fixture.mjs";
import { run } from "../../lib/proc.mjs";
import { readCache, readJournal, appendEvent, writeCache } from "../../lib/cache.mjs";
import { taskView } from "../../lib/backlog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = join(ROOT, "hooks", "session-end.mjs");
const CLI = join(ROOT, "scripts", "backlog-cc.mjs");

function shQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`;
}

// pendingModifiedFiles now lives in the append-only journal, not the
// snapshot writeCache/readCache address.
function seedPending(root, sessionId, paths) {
  for (const p of paths) appendEvent(root, sessionId, { t: "edit", p });
}

async function feed(payload, cwd) {
  return run(
    "/bin/sh",
    ["-c", `printf %s ${shQuote(JSON.stringify(payload))} | ${shQuote(process.execPath)} ${shQuote(HOOK)}`],
    { cwd, timeoutMs: 30000 },
  );
}

/**
 * Poll until `probe` returns something — the flush runs in a detached child
 * now (BCC-46), so the hook returning says nothing about the write yet.
 */
async function waitFor(probe, { timeoutMs = 30000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the detached flush");
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

let available = false;
before(async () => {
  available = await backlogAvailable();
});

test("pending files are unioned onto whatever the task already recorded", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Flush target");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    await p.cli(["task", "edit", id, "--modified-file", "src/existing.ts"]);
    seedPending(p.root, "s1", ["src/new.ts", "src/existing.ts"]);

    const r = await feed({ session_id: "s1", cwd: p.root }, p.root);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "", "SessionEnd emits nothing");

    const files = await waitFor(async () => {
      const view = await taskView(id, { cwd: p.root, timeoutMs: 20000 });
      const list = view.ok ? view.task.modifiedFiles || [] : [];
      return list.length >= 2 ? list.sort() : null;
    });
    assert.deepEqual(
      files,
      ["src/existing.ts", "src/new.ts"],
      "the existing entry must survive: --modified-file replaces the list",
    );
    await waitFor(async () => readCache(p.root, "s1") === null);
    assert.equal(readCache(p.root, "s1"), null, "the session cache is discarded");
    assert.deepEqual(readJournal(p.root, "s1"), [], "the journal is discarded too");
  } finally {
    p.cleanup();
  }
});

test("nothing is written when no task can be resolved", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Not started");
    seedPending(p.root, "s2", ["src/new.ts"]);
    // Seeded so the detached child has something to observably remove: the
    // journal now survives an unresolved task on purpose (BCC-47), so its
    // disappearance is no longer the signal that the child ran — and waiting
    // on state that was never written would pass before the child started.
    writeCache(p.root, "s2", { hookRuns: { SessionStart: "2026-08-23T10:00:00.000Z" } });

    await feed({ session_id: "s2", cwd: p.root }, p.root);
    await waitFor(async () => readCache(p.root, "s2") === null);

    const view = await taskView(id, { cwd: p.root, timeoutMs: 20000 });
    assert.deepEqual(view.task.modifiedFiles, [], "fail closed: never write to a guessed task");
    assert.equal(readJournal(p.root, "s2").length, 1, "an unwritten pending list must survive for the sweep");
  } finally {
    p.cleanup();
  }
});

// Driven through the CLI command rather than the hook: with nothing seeded
// there is no state whose disappearance could tell a detached child apart from
// one that never ran, so the hook path would assert nothing here.
test("an empty pending list writes nothing and still clears the cache", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Untouched");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    // no journal at all — pendingModifiedFiles derives to an empty list

    const flush = await run(process.execPath, [CLI, "flush", "s3"], { cwd: p.root, timeoutMs: 30000 });
    assert.equal(flush.ok, true, flush.stderr);
    assert.deepEqual(JSON.parse(flush.stdout).files, []);

    const view = await taskView(id, { cwd: p.root, timeoutMs: 20000 });
    assert.deepEqual(view.task.modifiedFiles, []);
    assert.equal(readCache(p.root, "s3"), null);
  } finally {
    p.cleanup();
  }
});

// The bug this file's detachment exists for (BCC-46): Claude Code aborts a
// hook that is still running while it shuts down. `run` resolves when the hook
// process is gone, so an effect that lands after it proves the child outlived
// its parent rather than being killed with it.
test("the flush completes after the hook process has exited", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Outlives the hook");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    seedPending(p.root, "s4", ["src/late.ts"]);

    const r = await feed({ session_id: "s4", cwd: p.root }, p.root);
    assert.equal(r.code, 0, "the hook itself must not fail");

    const files = await waitFor(async () => {
      const view = await taskView(id, { cwd: p.root, timeoutMs: 20000 });
      const list = view.ok ? view.task.modifiedFiles || [] : [];
      return list.length > 0 ? list : null;
    });
    assert.deepEqual(files, ["src/late.ts"]);
  } finally {
    p.cleanup();
  }
});

/**
 * A `backlog` on PATH that forwards every read to the real binary and fails
 * only `task edit`. A transient write failure has to be exactly that — the
 * reads before it must still work, or the flush never reaches the write and
 * the test proves the wrong arm.
 */
async function failingEditShim(t) {
  const real = await run("/bin/sh", ["-c", "command -v backlog"], { timeoutMs: 8000 });
  assert.equal(real.ok, true, "cannot shadow a binary that is not on PATH");
  const dir = mkdtempSync(join(tmpdir(), "bcc-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "backlog"),
    [
      "#!/bin/sh",
      'if [ "$1" = "task" ] && [ "$2" = "edit" ]; then',
      '  echo "backlog: transient failure" >&2',
      "  exit 1",
      "fi",
      `exec ${real.stdout.trim()} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(join(dir, "backlog"), 0o755);
  return { ...process.env, PATH: `${dir}:${process.env.PATH}` };
}

const flush = (cwd, sessionId, env) =>
  run(process.execPath, [CLI, "flush", sessionId], { cwd, timeoutMs: 30000, ...(env ? { env } : {}) });

// BCC-47. The flush used to clear the journal in a finally, on every path —
// so a CLI that was merely unreachable for a moment cost the pending list at
// the one moment recovery was still possible.
test("a failed write keeps the journal, and the retry writes the union once", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Retry target");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    await p.cli(["task", "edit", id, "--modified-file", "src/existing.ts"]);
    seedPending(p.root, "s5", ["src/new.ts", "src/existing.ts"]);

    const failed = await flush(p.root, "s5", await failingEditShim(t));
    assert.equal(failed.ok, true, "the flush itself must not crash");
    assert.equal(JSON.parse(failed.stdout).reason, "cli-error", failed.stdout);
    assert.deepEqual(
      readJournal(p.root, "s5").map((e) => e.p),
      ["src/new.ts", "src/existing.ts"],
      "the journal was cleared despite the write failing",
    );

    const view = await taskView(id, { cwd: p.root, timeoutMs: 20000 });
    assert.deepEqual(view.task.modifiedFiles, ["src/existing.ts"], "nothing may be written when the write failed");

    const retried = await flush(p.root, "s5");
    assert.deepEqual(JSON.parse(retried.stdout).files.sort(), ["src/existing.ts", "src/new.ts"]);

    const after = await taskView(id, { cwd: p.root, timeoutMs: 20000 });
    const files = after.task.modifiedFiles;
    assert.deepEqual(files.slice().sort(), ["src/existing.ts", "src/new.ts"]);
    assert.equal(files.length, new Set(files).size, "the retry duplicated an entry");
    assert.deepEqual(readJournal(p.root, "s5"), [], "a landed write must clear the journal");
  } finally {
    p.cleanup();
  }
});

// The other transient arm: the flush never gets as far as writing, because the
// task cannot be resolved. Same rule — the pending list is not the CLI's to
// lose.
test("an unresolvable task keeps the journal too", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    await p.createTask("Never started");
    seedPending(p.root, "s6", ["src/new.ts"]);

    const r = await flush(p.root, "s6");
    assert.equal(JSON.parse(r.stdout).reason, "none", r.stdout);
    assert.deepEqual(
      readJournal(p.root, "s6").map((e) => e.p),
      ["src/new.ts"],
      "nothing was written, so nothing may be forgotten",
    );
  } finally {
    p.cleanup();
  }
});

// The snapshot has no second chance to wait for: the session is over, and the
// next one under this id writes its own at SessionStart.
test("the snapshot goes even when the journal is kept", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    await p.createTask("Never started");
    writeCache(p.root, "s7", { hookRuns: { SessionStart: "2026-08-23T10:00:00.000Z" } });
    seedPending(p.root, "s7", ["src/new.ts"]);

    await flush(p.root, "s7");
    assert.equal(readCache(p.root, "s7"), null, "the spent snapshot survived");
    assert.equal(readJournal(p.root, "s7").length, 1, "the journal must survive with it");
  } finally {
    p.cleanup();
  }
});

// The fifth hook's no-project case (BCC-49). SessionStart, PreToolUse,
// PostToolUse and UserPromptSubmit each pin theirs in test/contract; this one
// had none, and it is the hook where inertness is easiest to lose — the
// detached child is spawned directly below a single `if (!project) return`.
//
// Silence alone would be a weak assertion, because `guard()` swallows a throw
// and still exits 0. BACKLOG_MD_DEBUG makes that visible: the guard records
// ok:false with the message for anything it swallowed, so a hook that failed
// quietly cannot pass as one that had nothing to do.
test("outside a Backlog.md project the hook is inert, and provably not just quiet", async (t) => {
  const empty = mkdtempSync(join(tmpdir(), "bcc-noproject-"));
  const state = mkdtempSync(join(tmpdir(), "bcc-nostate-"));
  t.after(() => {
    rmSync(empty, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  const payload = JSON.stringify({ session_id: "s8", cwd: empty });
  const r = await run(
    "/bin/sh",
    ["-c", `printf %s ${shQuote(payload)} | ${shQuote(process.execPath)} ${shQuote(HOOK)}`],
    { cwd: empty, timeoutMs: 30000, env: { ...process.env, XDG_STATE_HOME: state, BACKLOG_MD_DEBUG: "1" } },
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "", "a hook with no project to work on has nothing to say");

  const dir = join(state, "backlog-md-cc");
  const entry = JSON.parse(readFileSync(join(dir, "debug.jsonl"), "utf8").trim().split("\n").pop());
  assert.equal(entry.event, "SessionEnd");
  assert.equal(entry.ok, true, `the hook exited 0 by swallowing a failure: ${entry.message}`);

  // A spawn that should not have happened needs a moment to prove it did not.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.deepEqual(readdirSync(dir), ["debug.jsonl"], "state was written for a project that does not exist");
});
