import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, journalPath, listSessions } from "../../lib/cache.mjs";
import { ABANDONED_AFTER_MS, includesSelf, sweepAbandoned } from "../../lib/session-sweep.mjs";

// Keep every session file this test writes inside a temp directory rather than
// the developer's own state directory.
const state = mkdtempSync(join(tmpdir(), "bcc-sweep-state-"));
const originalState = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = state;
process.on("exit", () => {
  if (originalState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalState;
  rmSync(state, { recursive: true, force: true });
});

const repo = () => mkdtempSync(join(tmpdir(), "bcc-sweep-repo-"));

/** Give a session a journal with one edit in it, aged by `ageMs`. */
function journal(root, sessionId, { ageMs = 0, files = ["src/app.ts"] } = {}) {
  for (const file of files) appendEvent(root, sessionId, { t: "edit", p: file });
  const path = journalPath(root, sessionId);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  }
  return path;
}

test("listSessions reports each session once, by its file-name id", () => {
  const root = repo();
  journal(root, "sess-one");
  journal(root, "sess/two"); // sanitised to sess_two on disk
  const ids = listSessions(root).map((s) => s.sessionId);
  assert.deepEqual([...ids].sort(), ["sess_two", "sess-one"].sort());
});

// The sweep runs at session start, while this session's own journal is still
// being written. Sweeping it would delete the very list SessionEnd is about
// to flush.
test("the live session is never swept, however old its journal looks", async () => {
  const root = repo();
  const path = journal(root, "live", { ageMs: 10 * ABANDONED_AFTER_MS });
  const result = await sweepAbandoned({ repoRoot: root, sessionId: "live" });
  assert.deepEqual(result.swept, []);
  assert.ok(existsSync(path), "the live session's journal was removed");
});

test("a journal too recent to be certainly dead is left alone", async () => {
  const root = repo();
  const path = journal(root, "other", { ageMs: 60_000 });
  const result = await sweepAbandoned({ repoRoot: root, sessionId: "live" });
  assert.deepEqual(result.swept, []);
  assert.ok(existsSync(path));
});

// No task is resolved for these: an empty journal has nothing to write
// anywhere, so clearing it cannot lose anything and needs no CLI at all.
test("a dead session with nothing pending is cleared without resolving a task", async () => {
  const root = repo();
  // A journal with only a non-edit event: dead, but nothing to flush.
  appendEvent(root, "empty", { t: "stale" });
  const path = journalPath(root, "empty");
  const when = new Date(Date.now() - 2 * ABANDONED_AFTER_MS);
  utimesSync(path, when, when);

  const result = await sweepAbandoned({ repoRoot: root, sessionId: "live" });
  assert.deepEqual(result.swept, ["empty"]);
  assert.deepEqual(result.files, []);
  assert.equal(existsSync(path), false, "an empty dead journal should be gone");
});

// Fail closed, as SessionEnd does — and here that also means keeping the
// journal, so the next session start can try again.
test("an unresolvable task writes nothing and deletes nothing", async () => {
  const root = repo(); // not a Backlog.md project: nothing can resolve
  const path = journal(root, "dead", { ageMs: 2 * ABANDONED_AFTER_MS });
  const result = await sweepAbandoned({ repoRoot: root, sessionId: "live" });
  assert.deepEqual(result.files, []);
  assert.ok(result.reason, JSON.stringify(result));
  assert.ok(existsSync(path), "the pending list was discarded without being written");
});

// The exit path that started BCC-18: two Ctrl-C, Claude Code reports the
// SessionEnd hook as cancelled, and the resume comes back under the same
// session id — where the age rule would never reach the journal, because the
// live session is exempt from it.
test("a resumed session sweeps the journal its killed predecessor left under the same id", async () => {
  const root = repo();
  const path = journal(root, "resumed", { ageMs: 0 });
  const untouched = await sweepAbandoned({ repoRoot: root, sessionId: "resumed" });
  assert.deepEqual(untouched.swept, [], "the live session is exempt without includeSelf");
  assert.ok(existsSync(path));

  // Not a Backlog.md project, so the flush cannot resolve a task — what this
  // asserts is that the journal was considered at all, which the age rule
  // alone never does for the live id.
  const withSelf = await sweepAbandoned({ repoRoot: root, sessionId: "resumed", includeSelf: true });
  assert.ok(withSelf.reason, JSON.stringify(withSelf));
  assert.ok(existsSync(path), "an unresolvable task must still keep the journal");
});

// A SessionStart from clear or compact is the same process still running, so
// its journal is in use, not inherited. hooks/session-start.mjs passes
// includeSelf only for startup and resume; this pins the behaviour it relies on.
test("without includeSelf the live journal is left alone even with nothing else to sweep", async () => {
  const root = repo();
  const path = journal(root, "live");
  const result = await sweepAbandoned({ repoRoot: root, sessionId: "live" });
  assert.deepEqual(result.swept, []);
  assert.ok(existsSync(path));
});

// The threshold is short (30 minutes) because a swept live session loses its
// counters, not its files — but a session that was active a minute ago must
// still be left alone, or every start would trample its neighbours.
test("the shortened threshold still leaves a just-active session alone", async () => {
  const root = repo();
  const path = journal(root, "busy", { ageMs: 5 * 60_000 });
  const result = await sweepAbandoned({ repoRoot: root, sessionId: "live" });
  assert.deepEqual(result.swept, []);
  assert.ok(existsSync(path));
  assert.equal(ABANDONED_AFTER_MS, 30 * 60 * 1000);
});

// hooks/session-start.mjs passes --include-self on this decision alone, and a
// wrong answer here is invisible until somebody loses a file list: `compact`
// would flush a journal still in use, `resume` not flushing is the bug BCC-18
// exists to fix.
test("only a starting process may sweep its own session id", () => {
  assert.equal(includesSelf("startup"), true);
  assert.equal(includesSelf("resume"), true);
  assert.equal(includesSelf("clear"), false);
  assert.equal(includesSelf("compact"), false);
  assert.equal(includesSelf(undefined), false);
});
