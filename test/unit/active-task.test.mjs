import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  taskIdCandidates,
  shortOf,
  IN_PROGRESS,
  narrowToSelf,
  normaliseAssignee,
  resolveIdentities,
} from "../../lib/active-task.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_GIT = join(here, "..", "helpers", "fake-git.mjs");
const FAKE_BACKLOG = join(here, "..", "helpers", "fake-backlog.mjs");

function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("taskIdCandidates extracts a plain prefixed id", () => {
  assert.deepEqual(taskIdCandidates("BACK-12"), ["BACK-12"]);
});

test("taskIdCandidates extracts ids from common branch shapes", () => {
  assert.deepEqual(taskIdCandidates("feature/BACK-12-add-oauth"), ["BACK-12"]);
  assert.deepEqual(taskIdCandidates("task/TASK-7"), ["TASK-7"]);
  assert.deepEqual(taskIdCandidates("fix_ABC-3_thing"), ["ABC-3"]);
});

test("taskIdCandidates keeps subtask ids intact", () => {
  assert.deepEqual(taskIdCandidates("BACK-14.1-subtask"), ["BACK-14.1"]);
});

test("taskIdCandidates returns every candidate, deduplicated, in order", () => {
  assert.deepEqual(taskIdCandidates("BACK-1-and-BACK-2-and-BACK-1"), ["BACK-1", "BACK-2"]);
});

test("taskIdCandidates ignores branches with no candidate", () => {
  assert.deepEqual(taskIdCandidates("main"), []);
  assert.deepEqual(taskIdCandidates("release-2024"), ["release-2024"]);
  assert.deepEqual(taskIdCandidates(""), []);
  assert.deepEqual(taskIdCandidates(null), []);
});

test("shortOf reduces a task to the fields a candidate list needs", () => {
  const s = shortOf({ id: "BACK-1", title: "T", status: "In Progress", description: "long" });
  assert.deepEqual(s, { id: "BACK-1", title: "T", status: "In Progress" });
});

test("IN_PROGRESS is the exact configured status name it must match", () => {
  assert.equal(IN_PROGRESS, "In Progress");
});

test("narrowToSelf returns the list unchanged when there are no identities", () => {
  const tasks = [
    { id: "BACK-1", assignees: ["alice"] },
    { id: "BACK-2", assignees: ["bob"] },
  ];
  assert.deepEqual(narrowToSelf(tasks, undefined), tasks);
  assert.deepEqual(narrowToSelf(tasks, []), tasks);
});

test("narrowToSelf narrows to the task whose assignee matches an identity", () => {
  const tasks = [
    { id: "BACK-1", assignees: ["alice"] },
    { id: "BACK-2", assignees: ["bob"] },
  ];
  assert.deepEqual(narrowToSelf(tasks, ["bob"]), [tasks[1]]);
});

test("narrowToSelf returns the full unfiltered list when no identity matches any task", () => {
  const tasks = [
    { id: "BACK-1", assignees: ["alice"] },
    { id: "BACK-2", assignees: ["bob"] },
  ];
  assert.deepEqual(narrowToSelf(tasks, ["carol"]), tasks);
});

test("normaliseAssignee strips a leading @ and lowercases", () => {
  assert.equal(normaliseAssignee("@Alice"), "alice");
});

test("narrowToSelf matches @alice against an assignee stored as alice, case-insensitively", () => {
  const tasks = [
    { id: "BACK-1", assignees: ["Alice"] },
    { id: "BACK-2", assignees: ["bob"] },
  ];
  assert.deepEqual(narrowToSelf(tasks, ["@alice"]), [tasks[0]]);
});

test("resolveIdentities collects the trimmed git email and name plus configured default assignees", () =>
  withEnv("FAKE_GIT_MODE", "identity", () =>
    withEnv("FAKE_BACKLOG_MODE", "default-assignees", async () => {
      const identities = await resolveIdentities({
        gitBin: process.execPath,
        gitPrefixArgs: [FAKE_GIT],
        bin: process.execPath,
        prefixArgs: [FAKE_BACKLOG],
      });
      assert.deepEqual(identities, ["friend@example.com", "Friend Name", "alice", "bob"]);
    }),
  ));

test("resolveIdentities is best-effort: an unset git identity contributes nothing rather than throwing", () =>
  withEnv("FAKE_GIT_MODE", "unset", () =>
    withEnv("FAKE_BACKLOG_MODE", "default-assignees-empty", async () => {
      const identities = await resolveIdentities({
        gitBin: process.execPath,
        gitPrefixArgs: [FAKE_GIT],
        bin: process.execPath,
        prefixArgs: [FAKE_BACKLOG],
      });
      assert.deepEqual(identities, []);
    }),
  ));

test("resolveIdentities is best-effort: a missing backlog binary contributes nothing rather than throwing", () =>
  withEnv("FAKE_GIT_MODE", "identity", async () => {
    const identities = await resolveIdentities({
      gitBin: process.execPath,
      gitPrefixArgs: [FAKE_GIT],
      bin: "definitely-not-a-real-binary-xyzzy",
    });
    assert.deepEqual(identities, ["friend@example.com", "Friend Name"]);
  }));
