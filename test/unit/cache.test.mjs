import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheDir,
  cachePath,
  readCache,
  writeCache,
  updateCache,
  clearCache,
  clearJournal,
  journalPath,
  appendEvent,
  readJournal,
  deriveSession,
  listSessions,
  listSessionSummaries,
  writeSessionSummary,
  stateBase,
  runtimeHealthPath,
  readRuntimeFailures,
  recordRuntimeFailure,
  createRuntimeFailureState,
  clearRuntimeFailure,
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

test("OMP runtime health keeps a bounded list of unresolved failures", () => {
  const root = repo();
  for (let i = 0; i < 20; i += 1) recordRuntimeFailure(root, `operation-${i}`, new Error(`failure-${i}`), i);
  const failures = readRuntimeFailures(root);
  assert.equal(failures.length, 16);
  assert.equal(failures[0].operation, "operation-4");
  assert.equal(failures.at(-1).message, "failure-19");
  assert.ok(runtimeHealthPath(root).startsWith(cacheDir(root)));
  assert.ok(!runtimeHealthPath(root).startsWith(root));
});

test("only a newer successful OMP attempt clears an unresolved failure", () => {
  const root = repo();
  recordRuntimeFailure(root, "session context", new Error("send failed"), 200);
  assert.equal(clearRuntimeFailure(root, "session context", 100), false);
  assert.equal(readRuntimeFailures(root).length, 1);
  assert.equal(clearRuntimeFailure(root, "session context", 200), true);
  assert.deepEqual(readRuntimeFailures(root), []);
});

test("a success in one OMP session cannot clear another session's failure", () => {
  const root = repo();
  recordRuntimeFailure(root, "tool guard", new Error("session B failed"), 200, "session-b");
  assert.equal(clearRuntimeFailure(root, "tool guard", 300, "session-a"), false);
  assert.equal(readRuntimeFailures(root)[0].scope, "session-b");
  assert.equal(clearRuntimeFailure(root, "tool guard", 300, "session-b"), true);
});

test("runtime failure state resolves successful attempts from its in-memory snapshot", () => {
  const root = repo();
  const health = createRuntimeFailureState(root);
  assert.equal(health.record("tool recording", new Error("record failed"), 100, "session"), true);
  rmSync(runtimeHealthPath(root), { force: true });
  assert.equal(health.clear("tool recording", 100, "session"), true);
});

test("separately hydrated OMP health states preserve unrelated failures", () => {
  const root = repo();
  const first = createRuntimeFailureState(root);
  const second = createRuntimeFailureState(root);

  assert.equal(first.record("tool guard", new Error("first failed"), 100, "first"), true);
  assert.equal(second.record("tool recording", new Error("second failed"), 200, "second"), true);
  assert.deepEqual(
    readRuntimeFailures(root)
      .map((failure) => failure.operation)
      .sort(),
    ["tool guard", "tool recording"],
  );

  assert.equal(second.clear("tool recording", 200, "second"), true);
  assert.deepEqual(
    readRuntimeFailures(root).map((failure) => failure.operation),
    ["tool guard"],
  );
});

test("a contended OMP health lock drops the best-effort update promptly", () => {
  const root = repo();
  recordRuntimeFailure(root, "existing failure", new Error("already recorded"), 1, "existing");
  const lockPath = `${runtimeHealthPath(root)}.lock`;
  writeFileSync(lockPath, "held", { flag: "wx" });
  try {
    const health = createRuntimeFailureState(root);
    const startedAt = performance.now();
    assert.equal(health.record("contended failure", new Error("must not block"), 2, "contended"), false);
    assert.ok(performance.now() - startedAt < 100, "health contention must not stall a tool path");
    assert.deepEqual(
      readRuntimeFailures(root).map((failure) => failure.operation),
      ["existing failure"],
    );
  } finally {
    rmSync(lockPath, { force: true });
  }
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

test("deriveSession aggregates Backlog behavior counters", () => {
  const root = repo();
  appendEvent(root, "s", { t: "metric", name: "guard" });
  appendEvent(root, "s", { t: "metric", name: "tool", tool: "backlog_task_plan" });
  appendEvent(root, "s", { t: "metric", name: "tool", tool: "backlog_task_plan" });
  appendEvent(root, "s", { t: "metric", name: "acceptance-check" });
  appendEvent(root, "s", { t: "metric", name: "unplanned-start" });
  appendEvent(root, "s", { t: "metric", name: "unfinished-session" });
  appendEvent(root, "s", { t: "metric", name: "steering" });
  appendEvent(root, "s", { t: "metric", name: "taskless-continue" });

  assert.deepEqual(deriveSession(root, "s").metrics, {
    guards: 1,
    toolCalls: { backlog_task_plan: 2 },
    acceptanceChecks: 1,
    unplannedStarts: 1,
    unfinishedSessions: 1,
    steeringMessages: 1,
    tasklessContinues: 1,
  });
});

test("deriveSession with no journal at all reports the empty baseline", () => {
  const derived = deriveSession(repo(), "never-appended");
  assert.deepEqual(derived, {
    sourceEdits: 0,
    pendingModifiedFiles: [],
    editsAtLastNotes: 0,
    stale: false,
    taskId: null,
    metrics: {
      guards: 0,
      toolCalls: {},
      acceptanceChecks: 0,
      unplannedStarts: 0,
      unfinishedSessions: 0,
      steeringMessages: 0,
      tasklessContinues: 0,
    },
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

test("deriveSession: notes clear the pending files, a later edit makes one pending again", () => {
  const root = repo();
  appendEvent(root, "s", { t: "edit", p: "a" });
  appendEvent(root, "s", { t: "edit", p: "b" });
  appendEvent(root, "s", { t: "notes" });
  assert.deepEqual(deriveSession(root, "s").pendingModifiedFiles, [], "notes say what changed; nothing is pending");
  appendEvent(root, "s", { t: "edit", p: "a" });
  assert.deepEqual(deriveSession(root, "s").pendingModifiedFiles, ["a"], "changed again since it was written down");
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

test("a session summary outlives the journal it was derived from", () => {
  const root = repo();
  appendEvent(root, "ended", { t: "metric", name: "guard" });
  appendEvent(root, "ended", { t: "metric", name: "tool", tool: "backlog_next" });
  writeSessionSummary(root, "ended");
  clearJournal(root, "ended");

  assert.deepEqual(deriveSession(root, "ended").metrics.toolCalls, {});
  const [summary] = listSessionSummaries(root);
  assert.equal(summary.sessionId, "ended");
  assert.equal(summary.metrics.guards, 1);
  assert.deepEqual(summary.metrics.toolCalls, { backlog_next: 1 });
});

// The sweep freezes a long-idle session's counters and deletes its journal.
// If that session then ends properly, there is nothing left to derive, and an
// all-zero summary would claim the model never touched the tools (BCC-5).
test("counters already frozen survive a later summary derived from an emptied journal", () => {
  const root = repo();
  appendEvent(root, "swept", { t: "metric", name: "guard" });
  writeSessionSummary(root, "swept");
  clearJournal(root, "swept");

  const kept = writeSessionSummary(root, "swept");
  assert.equal(kept.guards, 1);
  assert.equal(listSessionSummaries(root)[0].metrics.guards, 1);
});

test("a session that really did nothing still gets its empty summary", () => {
  const root = repo();
  writeSessionSummary(root, "quiet");
  const [summary] = listSessionSummaries(root);
  assert.equal(summary.sessionId, "quiet");
  assert.equal(summary.metrics.guards, 0);
});

// A summary the sweep could see would be swept forever: it holds no pending
// files, so every session start would "collect" it and find it again next time.
test("summaries are invisible to the session listing the sweep walks", () => {
  const root = repo();
  writeSessionSummary(root, "ended");
  assert.deepEqual(listSessions(root), []);
});

test("stored summaries stay bounded as sessions accumulate", () => {
  const root = repo();
  for (let i = 0; i < 25; i += 1) writeSessionSummary(root, `s-${i}`, 1000 + i);
  const stored = listSessionSummaries(root);
  assert.equal(stored.length, 20);
  assert.equal(stored[0].sessionId, "s-24");
  assert.equal(stored.at(-1).sessionId, "s-5");
});
