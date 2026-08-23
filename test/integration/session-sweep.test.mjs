import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run } from "../../lib/proc.mjs";
import { makeProject, backlogAvailable } from "../helpers/fixture.mjs";
import { appendEvent, cachePath, journalPath, writeCache } from "../../lib/cache.mjs";
import { taskView } from "../../lib/backlog.mjs";
import { ABANDONED_AFTER_MS, sweepAbandoned } from "../../lib/session-sweep.mjs";

/** A journal from a session that never ran SessionEnd: edits, then nothing. */
function abandonedJournal(root, sessionId, files) {
  for (const p of files) appendEvent(root, sessionId, { t: "edit", p });
  const path = journalPath(root, sessionId);
  const when = new Date(Date.now() - 2 * ABANDONED_AFTER_MS);
  utimesSync(path, when, when);
  return path;
}

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "session-start.mjs");

function shQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`;
}

/** Drive the real SessionStart hook the way Claude Code does: JSON on stdin. */
async function feedSessionStart(payload, cwd) {
  return run(
    "/bin/sh",
    ["-c", `printf %s ${shQuote(JSON.stringify(payload))} | ${shQuote(process.execPath)} ${shQuote(HOOK)}`],
    { cwd, timeoutMs: 30000 },
  );
}

/** Poll until `probe` returns something, or fail — the sweep runs detached. */
async function waitFor(probe, { timeoutMs = 30000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the detached sweep");
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

let available = false;
before(async () => {
  available = await backlogAvailable();
});

// The loss this recovers (BCC-16): SessionEnd does not run when Claude Code
// crashes, and that session's edited-file list was never written anywhere.
test("an abandoned session's pending files land on the active task at the next start", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Sweep target");
    await p.cli(["task", "edit", id, "-s", "In Progress", "--modified-file", "src/existing.ts"]);
    const path = abandonedJournal(p.root, "crashed", ["src/app.ts", "src/util.ts"]);

    const result = await sweepAbandoned({ repoRoot: p.root, sessionId: "live" });
    assert.deepEqual(result.swept, ["crashed"], JSON.stringify(result));

    const view = await taskView(id, { cwd: p.root });
    assert.equal(view.ok, true, JSON.stringify(view));
    assert.deepEqual([...view.task.modifiedFiles].sort(), ["src/app.ts", "src/existing.ts", "src/util.ts"]);
    assert.equal(existsSync(path), false, "a flushed journal must not be swept twice");
  } finally {
    p.cleanup();
  }
});

// The second half of "removed": a repeat start has nothing left to do, and in
// particular does not write the same list onto whatever task is active then.
test("a second sweep after a successful one is a no-op", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Sweep once");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    abandonedJournal(p.root, "crashed", ["src/app.ts"]);
    await sweepAbandoned({ repoRoot: p.root, sessionId: "live" });

    const second = await sweepAbandoned({ repoRoot: p.root, sessionId: "live" });
    assert.deepEqual(second.swept, []);
    assert.deepEqual(second.files, []);
  } finally {
    p.cleanup();
  }
});

// Fail closed: two tasks In Progress is ambiguous, and guessing would write
// somebody's file list onto the wrong task.
test("an ambiguous active task leaves the journal in place for the next start", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const first = await p.createTask("Ambiguous one");
    const second = await p.createTask("Ambiguous two");
    await p.cli(["task", "edit", first, "-s", "In Progress"]);
    await p.cli(["task", "edit", second, "-s", "In Progress"]);
    const path = abandonedJournal(p.root, "crashed", ["src/app.ts"]);

    const result = await sweepAbandoned({ repoRoot: p.root, sessionId: "live" });
    assert.equal(result.reason, "ambiguous", JSON.stringify(result));
    assert.deepEqual(result.files, []);
    assert.ok(existsSync(path), "the journal was discarded without being written anywhere");

    for (const id of [first, second]) {
      const view = await taskView(id, { cwd: p.root });
      assert.deepEqual(view.task.modifiedFiles ?? [], [], `${id} was written to`);
    }
  } finally {
    p.cleanup();
  }
});

// End to end for the exit path that could not be recovered before (BCC-18):
// the session was killed, Claude Code reported the SessionEnd hook cancelled,
// and the resume arrives under the same session id. Driven through the real
// hook, so the wiring is part of what is proven — including the detached
// child, which is why this waits for the write instead of assuming it landed.
test("resuming after a killed session puts its pending files on the active task", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Resume flush");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);

    const session = "killed-and-resumed";
    for (const path of ["src/a.ts", "src/b.ts"]) appendEvent(p.root, session, { t: "edit", p: path });
    writeCache(p.root, session, { taskId: id, state: "status" });

    const r = await feedSessionStart({ session_id: session, cwd: p.root, source: "resume" }, p.root);
    assert.equal(r.ok, true, r.stderr);

    const files = await waitFor(async () => {
      const view = await taskView(id, { cwd: p.root });
      const found = view.ok ? (view.task.modifiedFiles ?? []) : [];
      return found.length > 0 ? found : null;
    });
    assert.deepEqual([...files].sort(), ["src/a.ts", "src/b.ts"]);
    assert.equal(existsSync(journalPath(p.root, session)), false, "the spent journal should be gone");
    // The snapshot is this session's own, written by the brief moments ago —
    // only the inherited journal was spent.
    assert.ok(existsSync(cachePath(p.root, session)), "the live session's snapshot was discarded with it");
  } finally {
    p.cleanup();
  }
});
