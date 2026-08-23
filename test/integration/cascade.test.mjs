import { test, before } from "node:test";
import assert from "node:assert/strict";
import { makeProject, backlogAvailable } from "../helpers/fixture.mjs";
import { resolveActiveTask } from "../../lib/active-task.mjs";
import { run } from "../../lib/proc.mjs";

let available = false;
before(async () => {
  available = await backlogAvailable();
});

const opts = (root) => ({ cwd: root, timeoutMs: 20000 });

test("no In Progress task resolves to state none", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    await p.createTask("Just sitting there");
    const r = await resolveActiveTask(opts(p.root));
    assert.equal(r.state, "none");
  } finally {
    p.cleanup();
  }
});

test("exactly one In Progress task resolves to state status", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("The one");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    const r = await resolveActiveTask(opts(p.root));
    assert.equal(r.state, "status");
    assert.equal(r.task.id, id);
    assert.ok(Array.isArray(r.task.acceptanceCriteria));
  } finally {
    p.cleanup();
  }
});

test("two In Progress tasks resolve to ambiguous, never a guess", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    for (const title of ["First", "Second"]) {
      const id = await p.createTask(title);
      await p.cli(["task", "edit", id, "-s", "In Progress"]);
    }
    const r = await resolveActiveTask(opts(p.root));
    assert.equal(r.state, "ambiguous");
    assert.equal(r.candidates.length, 2);
    assert.equal(r.task, undefined, "an ambiguous result must not carry a task");
  } finally {
    p.cleanup();
  }
});

test("a task id in the branch name wins over the In Progress column", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject({ git: true });
  try {
    const branchTask = await p.createTask("Branch task");
    const otherTask = await p.createTask("Other task");
    await p.cli(["task", "edit", otherTask, "-s", "In Progress"]);
    await run("git", ["add", "-A"], { cwd: p.root });
    await run("git", ["commit", "-qm", "fixture"], { cwd: p.root });
    await run("git", ["checkout", "-qb", `feature/${branchTask}-slug`], { cwd: p.root });

    const r = await resolveActiveTask(opts(p.root));
    assert.equal(r.state, "branch");
    assert.equal(r.task.id, branchTask);
  } finally {
    p.cleanup();
  }
});

test("a branch id that is not a real task falls through to the status step", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject({ git: true });
  try {
    const id = await p.createTask("Real task");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    await run("git", ["add", "-A"], { cwd: p.root });
    await run("git", ["commit", "-qm", "fixture"], { cwd: p.root });
    await run("git", ["checkout", "-qb", "feature/BOGUS-999-nope"], { cwd: p.root });

    const r = await resolveActiveTask(opts(p.root));
    assert.equal(r.state, "status");
    assert.equal(r.task.id, id);
  } finally {
    p.cleanup();
  }
});

test("assignee narrowing resolves an ambiguous column to the task assigned to the fixture's git user", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject({ git: true });
  try {
    // The fixture sets local git user.email to test@example.com (test/helpers/fixture.mjs).
    const mine = await p.createTask("Mine", ["-a", "test@example.com"]);
    await p.cli(["task", "edit", mine, "-s", "In Progress"]);
    const notMine = await p.createTask("Not mine", ["-a", "someone-else"]);
    await p.cli(["task", "edit", notMine, "-s", "In Progress"]);

    const r = await resolveActiveTask(opts(p.root));
    assert.equal(r.state, "status", "narrowing must resolve this to a single task, not ambiguous");
    assert.equal(r.task.id, mine);
    assert.equal(r.source, "status:assignee");
  } finally {
    p.cleanup();
  }
});

test("a missing backlog binary resolves to unavailable, never to none", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const r = await resolveActiveTask({ ...opts(p.root), bin: "definitely-not-a-real-binary-xyzzy" });
    assert.equal(r.state, "unavailable");
    assert.equal(r.reason, "cli-missing");
  } finally {
    p.cleanup();
  }
});
