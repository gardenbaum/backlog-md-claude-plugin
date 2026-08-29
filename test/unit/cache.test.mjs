import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheDir,
  cachePath,
  readCache,
  writeCache,
  updateCache,
  clearCache,
  journalPath,
  appendEvent,
  readJournal,
  deriveSession,
  stateBase,
} from "../../lib/cache.mjs";

const repo = () => mkdtempSync(join(tmpdir(), "bcc-repo-"));

test("lexical and canonical repository paths share one session directory", () => {
  const root = repo();
  assert.equal(cacheDir(root), cacheDir(realpathSync(root)));
});

test("a written snapshot reads back identically", () => {
  const root = repo();
  writeCache(root, "sess-1", { taskId: "BACK-12", state: "branch" });
  assert.deepEqual(readCache(root, "sess-1"), { taskId: "BACK-12", state: "branch" });
});

test("an unknown session reads as null", () => {
  assert.equal(readCache(repo(), "never-written"), null);
});

test("a corrupt snapshot reads as null rather than throwing", () => {
  const root = repo();
  writeCache(root, "sess-1", { a: 1 });
  writeFileSync(cachePath(root, "sess-1"), "{ not json");
  assert.equal(readCache(root, "sess-1"), null);
});

test("nothing is ever written inside the repository", () => {
  const root = repo();
  const written = writeCache(root, "sess-1", { a: 1 });
  assert.ok(written.startsWith(stateBase()), `expected a state-dir path, got ${written}`);
  assert.ok(!written.startsWith(root), "must not write inside the repo");
});

test("different repositories get different cache directories", () => {
  assert.notEqual(cacheDir(repo()), cacheDir(repo()));
});

test("the same repository is stable across calls", () => {
  const root = repo();
  assert.equal(cacheDir(root), cacheDir(root));
});

test("a hostile session id cannot escape the cache directory", () => {
  const root = repo();
  const p = cachePath(root, "../../../etc/passwd");
  assert.equal(p, join(cacheDir(root), "_________etc_passwd.json"));
});

test("updateCache merges into an existing snapshot", () => {
  const root = repo();
  writeCache(root, "s", { taskId: "BACK-1", edits: 2 });
  const merged = updateCache(root, "s", { edits: 3 });
  assert.deepEqual(merged, { taskId: "BACK-1", edits: 3 });
  assert.deepEqual(readCache(root, "s"), merged);
});

test("updateCache creates a snapshot when none exists", () => {
  const root = repo();
  assert.deepEqual(updateCache(root, "s", { a: 1 }), { a: 1 });
});

test("clearCache removes the snapshot and is safe to repeat", () => {
  const root = repo();
  writeCache(root, "s", { a: 1 });
  clearCache(root, "s");
  assert.equal(readCache(root, "s"), null);
  clearCache(root, "s");
});

test("clearCache also removes the journal", () => {
  const root = repo();
  appendEvent(root, "s", { t: "edit", p: "src/a.ts" });
  clearCache(root, "s");
  assert.deepEqual(readJournal(root, "s"), []);
});

test("readJournal returns an empty array for a session with no journal", () => {
  assert.deepEqual(readJournal(repo(), "never-appended"), []);
});

test("readJournal skips a malformed line without discarding the rest", () => {
  const root = repo();
  appendEvent(root, "s", { t: "edit", p: "src/a.ts" });
  appendFileSync(journalPath(root, "s"), "not json\n");
  appendEvent(root, "s", { t: "edit", p: "src/b.ts" });
  assert.deepEqual(readJournal(root, "s"), [
    { t: "edit", p: "src/a.ts" },
    { t: "edit", p: "src/b.ts" },
  ]);
});

test("deriveSession counts edits and lists pending paths in first-seen order, deduplicated", () => {
  const root = repo();
  for (const p of ["src/a.ts", "src/b.ts", "src/a.ts"]) appendEvent(root, "s", { t: "edit", p });
  const derived = deriveSession(root, "s");
  assert.equal(derived.sourceEdits, 3, "every edit counts, even a repeat path");
  assert.deepEqual(derived.pendingModifiedFiles, ["src/a.ts", "src/b.ts"]);
});

test("deriveSession with no journal at all reports the empty baseline", () => {
  const derived = deriveSession(repo(), "never-appended");
  assert.deepEqual(derived, {
    sourceEdits: 0,
    pendingModifiedFiles: [],
    editsAtLastNotes: 0,
    stale: false,
    taskId: null,
  });
});

test("deriveSession: editsAtLastNotes counts only edits before the last notes event", () => {
  const root = repo();
  appendEvent(root, "s", { t: "edit", p: "a" });
  appendEvent(root, "s", { t: "edit", p: "b" });
  appendEvent(root, "s", { t: "notes" });
  appendEvent(root, "s", { t: "edit", p: "c" });
  const derived = deriveSession(root, "s");
  assert.equal(derived.sourceEdits, 3);
  assert.equal(derived.editsAtLastNotes, 2, "only the two edits before the notes event count");
});

test("deriveSession: stale is true once a stale event is observed and no identity has re-derived it", () => {
  const root = repo();
  appendEvent(root, "s", { t: "stale" });
  assert.equal(deriveSession(root, "s").stale, true);
});

test("deriveSession: an identity event after a stale event clears staleness and sets taskId", () => {
  const root = repo();
  appendEvent(root, "s", { t: "stale" });
  appendEvent(root, "s", { t: "identity", id: "BACK-1" });
  const derived = deriveSession(root, "s");
  assert.equal(derived.stale, false);
  assert.equal(derived.taskId, "BACK-1");
});

test("deriveSession: a stale event after the last identity event reinstates staleness", () => {
  const root = repo();
  appendEvent(root, "s", { t: "identity", id: "BACK-1" });
  appendEvent(root, "s", { t: "stale" });
  const derived = deriveSession(root, "s");
  assert.equal(derived.stale, true);
  assert.equal(derived.taskId, "BACK-1", "the id itself survives; only the suspicion is reinstated");
});

test("deriveSession: taskId is the id of the last identity event, not the first", () => {
  const root = repo();
  appendEvent(root, "s", { t: "identity", id: "BACK-1" });
  appendEvent(root, "s", { t: "identity", id: "BACK-2" });
  assert.equal(deriveSession(root, "s").taskId, "BACK-2");
});

// PostToolUse's read-modify-write of the JSON snapshot lost updates under
// exactly the concurrency Claude Code produces by dispatching independent
// tool calls in parallel — measured at 2-4 of 6 concurrent edits landing.
// A single small appendFileSync is atomic on POSIX, so this must not happen
// to the journal.
test("appendEvent survives many concurrent writers: every event lands", async () => {
  const root = repo();
  const N = 20;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() => appendEvent(root, "s", { t: "edit", p: `src/${i}.ts` })),
    ),
  );
  const derived = deriveSession(root, "s");
  assert.equal(derived.sourceEdits, N, "every concurrent append must be counted");
  assert.equal(derived.pendingModifiedFiles.length, N, "every concurrent append must have a distinct path recorded");
});

// Session state used to live in os.tmpdir(): world-writable and shared on a
// multi-user Linux box, with a path derivable from the repository root. These
// three tests pin the resolution order that replaced it (BCC-7).
test("XDG_STATE_HOME wins when it is set", () => {
  const previous = process.env.XDG_STATE_HOME;
  const custom = mkdtempSync(join(tmpdir(), "bcc-xdg-"));
  process.env.XDG_STATE_HOME = custom;
  try {
    assert.ok(cacheDir(repo()).startsWith(join(custom, "backlog-md-cc")));
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test("without XDG_STATE_HOME the home directory is used", () => {
  const previous = process.env.XDG_STATE_HOME;
  delete process.env.XDG_STATE_HOME;
  try {
    assert.equal(
      stateBase({}, () => "/home/someone"),
      join("/home/someone", ".local", "state"),
    );
    assert.ok(cacheDir(repo()).startsWith(join(homedir(), ".local", "state")));
  } finally {
    if (previous !== undefined) process.env.XDG_STATE_HOME = previous;
  }
});

// Unreachable through the environment alone -- os.homedir() falls back to the
// passwd entry when HOME is unset -- which is why stateBase takes both.
test("with neither XDG_STATE_HOME nor a home directory it falls back to tmpdir", () => {
  assert.equal(
    stateBase({}, () => ""),
    tmpdir(),
  );
});

test("the state directory is created private to the user", { skip: process.platform === "win32" }, () => {
  const root = repo();
  writeCache(root, "sess-mode", { a: 1 });
  assert.equal(statSync(cacheDir(root)).mode & 0o777, 0o700);
});
