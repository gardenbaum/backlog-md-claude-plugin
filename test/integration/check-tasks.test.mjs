import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../lib/proc.mjs";
import { makeProject, backlogAvailable } from "../helpers/fixture.mjs";
import { checkTasks } from "../../scripts/backlog-cc.mjs";

/** Where the CLI says a task's file lives, relative to the project root. */
async function taskPath(project, id) {
  const view = await run("backlog", ["task", id, "--json"], { cwd: project.root });
  return join(project.root, JSON.parse(view.stdout).task.path);
}

// The gate CI runs (BCC-12). The pre-commit hook checks what is being
// committed on one machine; this checks the branch as it stands, which is the
// only view that survives `--no-verify` and a teammate with no hooks installed.
test("a task file the CLI cannot read is reported, with its id", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  try {
    const healthy = await project.createTask("Healthy task");
    const id = await project.createTask("Corruptible task");
    writeFileSync(await taskPath(project, id), "status: [unclosed\n---\nbroken\n");

    const result = await checkTasks({ cwd: project.root });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.broken.length, 1, JSON.stringify(result.broken));
    // The id comes from the file name, which carries the case the file was
    // written with — `task-2` where the CLI reports `TASK-2`.
    assert.equal(result.broken[0].taskId.toLowerCase(), id.toLowerCase());
    assert.match(result.broken[0].path, /tasks/);
    // The healthy one was checked and stayed out of the verdict.
    assert.equal(result.checked.length, 2, JSON.stringify(result.checked));
    assert.ok(!result.broken.some((b) => b.taskId.toLowerCase() === healthy.toLowerCase()));
  } finally {
    project.cleanup();
  }
});

test("a project whose task files are all readable passes", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  try {
    const id = await project.createTask("Healthy task");
    // Prove the check really read it, rather than passing on an empty list.
    assert.match(readFileSync(await taskPath(project, id), "utf8"), /Healthy task/);

    const result = await checkTasks({ cwd: project.root });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checked.length, 1);
    assert.deepEqual(result.broken, []);
  } finally {
    project.cleanup();
  }
});

// A branch that touches no task at all still runs this job, so "nothing to
// check" has to be a pass rather than an error about a missing directory.
test("a project with no task files passes with nothing checked", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  try {
    const result = await checkTasks({ cwd: project.root });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.checked, []);
  } finally {
    project.cleanup();
  }
});

test("no Backlog.md project at all is not a failure", async () => {
  const result = await checkTasks({ cwd: "/" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.checked, []);
});
