import { test } from "node:test";
import assert from "node:assert/strict";
import { observe, looksLikeBuildIntent, NOTES_STALENESS_THRESHOLD } from "../../lib/observations.mjs";

const task = (over = {}) => ({
  id: "BACK-12",
  status: "In Progress",
  acceptanceCriteria: [
    { index: 1, text: "one", checked: true },
    { index: 2, text: "two", checked: false },
    { index: 4, text: "four", checked: false },
  ],
  finalSummary: null,
  ...over,
});

test("no task means nothing to say", () => {
  assert.deepEqual(observe(null, { sourceEdits: 5 }), []);
});

test("open criteria are silent until the session has edited something", () => {
  assert.deepEqual(observe(task(), { sourceEdits: 0 }), []);
});

test("open criteria are named by index and asked for evidence, never for a checkbox", () => {
  const [line] = observe(task(), { sourceEdits: 3 });
  assert.match(line, /BACK-12/);
  assert.match(line, /\b2, 4\b/, "names the open indices");
  assert.match(line, /file:line/i, "asks for evidence");
  assert.match(line, /cannot be verified/i, "offers the honest way out");
  assert.ok(!/^\s*check them\s*$/i.test(line));
});

test("a single open criterion gets a singular verb", () => {
  const t = task({ acceptanceCriteria: [{ index: 3, text: "three", checked: false }] });
  const [line] = observe(t, { sourceEdits: 2 });
  assert.match(line, /acceptance criteria 3 is unchecked/);
});

test("several open criteria get a plural verb", () => {
  const [line] = observe(task(), { sourceEdits: 2 });
  assert.match(line, /acceptance criteria 2, 4 are unchecked/);
});

test("all criteria checked says nothing about criteria", () => {
  const checked = task({ acceptanceCriteria: [{ index: 1, text: "one", checked: true }] });
  assert.deepEqual(observe(checked, { sourceEdits: 9 }), []);
});

test("stale notes are reported strictly beyond the threshold, not at it", () => {
  const t = task({ acceptanceCriteria: [] });
  const at = observe(t, { sourceEdits: NOTES_STALENESS_THRESHOLD, editsAtLastNotes: 0 });
  assert.deepEqual(at, [], "exactly at the threshold is not yet stale");
  const beyond = observe(t, { sourceEdits: NOTES_STALENESS_THRESHOLD + 1, editsAtLastNotes: 0 });
  assert.equal(beyond.length, 1);
  assert.match(beyond[0], /--append-notes/);
});

test("notes written mid-session reset the staleness window", () => {
  const t = task({ acceptanceCriteria: [] });
  const lines = observe(t, { sourceEdits: 15, editsAtLastNotes: 14 });
  assert.deepEqual(lines, []);
});

test("Done without a final summary is reported; with one it is not", () => {
  const done = task({ status: "Done", acceptanceCriteria: [] });
  assert.match(observe(done, { sourceEdits: 1 })[0], /final summary/i);
  assert.deepEqual(
    observe(task({ status: "Done", acceptanceCriteria: [], finalSummary: "done" }), { sourceEdits: 1 }),
    [],
  );
});

test("several conditions produce several lines", () => {
  const lines = observe(task({ status: "Done" }), { sourceEdits: 20, editsAtLastNotes: 0 });
  assert.equal(lines.length, 3);
});

test("looksLikeBuildIntent recognises building and ignores asking", () => {
  for (const p of [
    "implement the search feature",
    "Add a logout button",
    "fix the failing test",
    "refactor this module",
  ]) {
    assert.equal(looksLikeBuildIntent(p), true, p);
  }
  for (const p of ["what does this function do?", "explain the cascade", "", null]) {
    assert.equal(looksLikeBuildIntent(p), false, String(p));
  }
});
