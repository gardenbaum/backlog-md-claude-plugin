import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findNext, rankReady } from "../../lib/next.mjs";
import { renderNext } from "../../lib/render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "..", "helpers", "fake-backlog.mjs");

function withMode(mode, fn) {
  const previous = process.env.FAKE_BACKLOG_MODE;
  process.env.FAKE_BACKLOG_MODE = mode;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.FAKE_BACKLOG_MODE;
    else process.env.FAKE_BACKLOG_MODE = previous;
  });
}

const opts = { bin: process.execPath, prefixArgs: [FAKE] };

const t = (id, priority, ordinal) => ({ id, title: `T ${id}`, priority, ordinal, status: "To Do" });
const ORDER = ["High", "Medium", "Low"];

test("configured priority order wins over ordinal", () => {
  const ranked = rankReady([t("A", "low", 1), t("B", "high", 9000)], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A"],
  );
});

// The JSON says "high"; the config says "High". Matching that case-sensitively
// would rank every task as unknown and silently fall back to ordinal order.
test("priority matching is case-insensitive against the configured order", () => {
  const ranked = rankReady([t("A", "LOW", 1), t("B", "High", 2)], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A"],
  );
});

test("ordinal breaks a priority tie, ascending", () => {
  const ranked = rankReady([t("A", "high", 3000), t("B", "high", 1000)], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A"],
  );
});

test("a task with no priority ranks after every known priority", () => {
  const ranked = rankReady([t("A", null, 1), t("B", "low", 9000)], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A"],
  );
});

test("a priority the config does not list ranks with the unknowns", () => {
  const ranked = rankReady([t("A", "urgent", 1), t("B", "low", 2)], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A"],
  );
});

test("id breaks a full tie so the order is stable across runs", () => {
  const ranked = rankReady([t("TASK-2", "high", null), t("TASK-1", "high", null)], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["TASK-1", "TASK-2"],
  );
});

test("ranking does not mutate its input", () => {
  const input = [t("A", "low", 1), t("B", "high", 2)];
  const copy = JSON.parse(JSON.stringify(input));
  rankReady(input, ORDER);
  assert.deepEqual(input, copy);
});

test("an empty configured order leaves ordinal as the only signal", () => {
  const ranked = rankReady([t("A", "high", 2), t("B", "low", 1)], []);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A"],
  );
});

// The recommendation is the plugin's own, so it is a notice() — frame()'s note
// would tell the reader to disregard the very thing being delivered. The
// ranked titles are contributor text, so they follow in a frame() block of
// their own rather than borrowing the notice's authority (BCC-23).
test("the recommendation is a notice and the titles it ranks are framed data", () => {
  const out = renderNext([t("TASK-1", "high", 1)], { status: "To Do" });
  assert.match(out, /<backlog-md-notice>/);
  assert.match(out, /<backlog-task-data>/);
  const authority = out.slice(out.indexOf("<backlog-md-notice>"), out.indexOf("</backlog-md-notice>"));
  assert.ok(!authority.includes("T TASK-1"), authority);
});

test("the rendering names the column it drew from and the start command", () => {
  const out = renderNext([t("TASK-1", "high", 1)], { status: "To Do" });
  assert.match(out, /To Do/);
  assert.match(out, /\/backlog-md:start TASK-1/);
});

test("an empty result says so instead of rendering an empty list", () => {
  const out = renderNext([], { status: "To Do" });
  assert.match(out, /no ready task/i);
});

// Nothing ready has two causes and two different next steps. The message named
// only the blocked one, so a session facing an empty backlog went looking for a
// blockage that was not there, while the task it needed was never written
// (BCC-6).
test("an empty backlog is told to create the first task; a blocked one is not", () => {
  const empty = renderNext([], { status: "To Do", total: 0 });
  assert.match(empty, /backlog task create/);
  assert.match(empty, /no tasks at all/i);

  const blocked = renderNext([], { status: "To Do", total: 4 });
  assert.match(blocked, /no ready task/i);
  assert.ok(!/backlog task create/.test(blocked), "work that exists is blocked, not missing");
});

test("findNext counts the whole backlog when nothing is ready", () =>
  withMode("task-list-empty", async () => {
    const r = await findNext(opts);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.total, 0, "the caller cannot tell an empty backlog from a blocked one without this");
  }));

// findNext had no tests at all before this. Two mutations both leave the
// suite green without them: returning {ok: true, tasks: []} when the
// status lookup fails, and the same when the task list itself fails. Under
// either, /backlog-md:next would print "there is no ready task" when the CLI
// is actually unreachable — a false statement the command's own prose then
// tells the agent to report as fact.
test("findNext fails closed when both defaultStatus and statuses fail", () =>
  withMode("error", async () => {
    const r = await findNext(opts);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(!("tasks" in r), "a failed lookup must not carry a tasks list");
  }));

test("findNext fails closed when the task list itself fails, even though the status and priority lookups succeeded", () =>
  withMode("next-list-fails", async () => {
    const r = await findNext(opts);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(!("tasks" in r), "a failed task list must not be reported as an empty ready list");
  }));

// BCC-42. A task due tomorrow used to rank behind one with no deadline at all,
// because ordinal was the only tie-break under priority.
const due = (id, priority, ordinal, dueDate) => ({ ...t(id, priority, ordinal), dueDate });

test("at equal priority a nearer due date ranks before a task with no due date", () => {
  const ranked = rankReady([due("A", "high", 1, null), due("B", "high", 9000, "2026-09-01 12:00")], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A"],
  );
});

test("the nearer of two due dates wins, to the minute", () => {
  const ranked = rankReady([due("A", "high", 1, "2026-09-01 12:30"), due("B", "high", 2, "2026-09-01 12:00")], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A"],
  );
});

// No deadline is not an imminent deadline. Reading a missing field as zero
// would put every undated task at the front of the list.
test("missing due dates sort last, not first", () => {
  const ranked = rankReady(
    [due("A", "high", 1, null), due("B", "high", 2, "2026-12-01"), due("C", "high", 3, undefined)],
    ORDER,
  );
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A", "C"],
  );
});

// A deadline says when, priority says whether: a due date must not promote
// low-priority work over high-priority work.
test("priority still outranks a nearer due date", () => {
  const ranked = rankReady([due("A", "low", 1, "2026-08-23"), due("B", "high", 2, null)], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A"],
  );
});

test("a mixed list is ordered priority, then due date, then ordinal, then id", () => {
  const ranked = rankReady(
    [
      due("TASK-7", "low", 10, "2026-08-23"),
      due("TASK-2", "high", 500, null),
      due("TASK-1", "high", 500, null),
      due("TASK-5", "high", 900, "2026-10-01"),
      due("TASK-4", "high", 100, "2026-09-01"),
      due("TASK-9", null, 1, "2026-08-24"),
    ],
    ORDER,
  );
  assert.deepEqual(
    ranked.map((x) => x.id),
    // high with dates by date, then high without dates by ordinal then id,
    // then low, then the unknown priority — regardless of how near its date is.
    ["TASK-4", "TASK-5", "TASK-1", "TASK-2", "TASK-7", "TASK-9"],
  );
});

// Two absent dates are both Infinity, and Infinity - Infinity is NaN — a
// comparator returning NaN silently loses every later tie-break.
test("two tasks without due dates still fall through to ordinal and id", () => {
  const ranked = rankReady([due("TASK-2", "high", 5, null), due("TASK-1", "high", 5, null)], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["TASK-1", "TASK-2"],
  );
});

// An unparseable date is not a claim about time; treating it as "very soon"
// would let a typo jump the queue.
test("an unparseable due date is treated as no due date", () => {
  const ranked = rankReady([due("A", "high", 9, "not a date"), due("B", "high", 1, null)], ORDER);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["B", "A"],
  );
});
