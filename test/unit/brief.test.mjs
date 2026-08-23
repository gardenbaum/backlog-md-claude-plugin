import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrief } from "../../lib/brief.mjs";
import { findNext } from "../../lib/next.mjs";
import { readCache, writeCache } from "../../lib/cache.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "helpers", "fake-backlog.mjs");
const CLI = { bin: process.execPath, prefixArgs: [FAKE] };

function project() {
  const root = mkdtempSync(join(tmpdir(), "bcc-brief-"));
  mkdirSync(join(root, "backlog"));
  writeFileSync(join(root, "backlog", "config.yml"), "statuses: [To Do]\n");
  return root;
}

// updateCache (lib/cache.mjs) merges shallowly, so a naive
// `hookRuns: { [event]: ts }` patch would replace the whole `hookRuns` key and
// erase whichever hook ran earlier in the session. buildBrief must instead
// read the existing snapshot and merge into `hookRuns`.
//
// The second event used to be `PreCompact`, which the plugin no longer
// registers (BCC-37). The invariant is not about that hook: doctor reports
// every key in `hookRuns`, and one buildBrief run must not silently drop what
// another recorded — so the test seeds a foreign key instead of naming a hook
// that does not exist.
test("buildBrief merges hookRuns instead of overwriting it", async () => {
  const root = project();
  const sessionId = "sess-merge";
  writeCache(root, sessionId, { hookRuns: { SomeOtherHook: "2026-08-20T12:00:00.000Z" } });

  await buildBrief({ cwd: root, sessionId, event: "SessionStart" });
  const afterFirst = readCache(root, sessionId);
  assert.ok(afterFirst.hookRuns.SessionStart, "SessionStart run must be recorded");
  assert.equal(afterFirst.hookRuns.SomeOtherHook, "2026-08-20T12:00:00.000Z", "an existing entry was erased");

  await buildBrief({ cwd: root, sessionId, event: "SessionStart" });
  const afterSecond = readCache(root, sessionId);
  assert.ok(afterSecond.hookRuns.SessionStart > afterFirst.hookRuns.SessionStart, "the rerun must refresh its own key");
  assert.equal(afterSecond.hookRuns.SomeOtherHook, "2026-08-20T12:00:00.000Z");
});

// This project's config has no "In Progress" status, so resolveActiveTask's
// status step returns "unavailable" (reason: no-in-progress-status) rather
// than a real resolution — the same shape a transient CLI failure takes.
// "unavailable" establishes nothing about which task is active, unlike
// "none" and "ambiguous", which positively establish that none does. An
// earlier version of buildBrief wrote `taskId: resolved.task?.id ?? null`
// unconditionally, discarding a good cached id to this kind of noise.
test("a cached taskId survives an unavailable resolution", async () => {
  const root = project();
  const sessionId = "sess-unavailable";
  writeCache(root, sessionId, { taskId: "BACK-9" });

  const { snapshot } = await buildBrief({ cwd: root, sessionId, event: "SessionStart" });
  assert.equal(snapshot.state, "unavailable");
  assert.equal(snapshot.taskId, "BACK-9", "a transient resolution failure must not discard a previously cached id");
  assert.equal(readCache(root, sessionId).taskId, "BACK-9");
});

// Two definitions of "the to-do column" used to coexist: this brief took
// statuses[0] while findNext resolved defaultStatus first. In a project where
// they differ, the two surfaces proposed tasks from different columns. The
// fake CLI reports statuses[0] = "In Progress" and defaultStatus = "Doing",
// so a regression shows up as BACK-2 (or nothing) instead of BACK-1 (BCC-9).
test("the brief and findNext take candidates from the same to-do column", async () => {
  const root = project();
  const previous = process.env.FAKE_BACKLOG_MODE;
  process.env.FAKE_BACKLOG_MODE = "divergent-todo";
  try {
    const { context } = await buildBrief({ cwd: root, sessionId: "sess-column", event: "SessionStart", ...CLI });
    const next = await findNext({ cwd: root, ...CLI });

    assert.equal(next.ok, true);
    assert.equal(next.status, "Doing", "findNext must use defaultStatus, not statuses[0]");
    assert.ok(context, "a project with no active task still gets a brief");
    assert.match(context, /BACK-1/, "the brief must offer the task in the defaultStatus column");
    assert.doesNotMatch(context, /BACK-2/, "a task outside the to-do column is not a candidate");
    assert.deepEqual(
      next.tasks.map((t) => t.id),
      ["BACK-1"],
      "both surfaces must land on the same task",
    );
  } finally {
    if (previous === undefined) delete process.env.FAKE_BACKLOG_MODE;
    else process.env.FAKE_BACKLOG_MODE = previous;
  }
});
