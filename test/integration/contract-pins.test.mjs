import { test, before } from "node:test";
import assert from "node:assert/strict";
import { makeProject, backlogAvailable } from "../helpers/fixture.mjs";
import { taskView, configList } from "../../lib/backlog.mjs";

let available = false;
before(async () => {
  available = await backlogAvailable();
});

test("the JSON envelope is still schemaVersion 1", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Envelope check");
    const raw = await p.cli(["task", id, "--json"]);
    const doc = JSON.parse(raw.stdout);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.kind, "task-view");
  } finally {
    p.cleanup();
  }
});

test("--modified-file REPLACES the list rather than appending", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Modified files");
    await p.cli(["task", "edit", id, "--modified-file", "src/a.ts", "--modified-file", "src/b.ts"]);
    let view = await taskView(id, { cwd: p.root, timeoutMs: 20000 });
    assert.deepEqual(view.task.modifiedFiles, ["src/a.ts", "src/b.ts"]);

    await p.cli(["task", "edit", id, "--modified-file", "src/c.ts"]);
    view = await taskView(id, { cwd: p.root, timeoutMs: 20000 });
    assert.deepEqual(view.task.modifiedFiles, ["src/c.ts"], "replacement semantics: any writer must read-union-write");
  } finally {
    p.cleanup();
  }
});

test("an unknown status returns exit 0 with an empty list", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    await p.createTask("Anything");
    const r = await p.cli(["task", "list", "-s", "NoSuchStatus", "--json"]);
    assert.equal(r.ok, true, "exit code cannot distinguish an unknown status");
    assert.deepEqual(JSON.parse(r.stdout).tasks, []);
  } finally {
    p.cleanup();
  }
});

test("the default status list contains the exact name the cascade matches", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const r = await configList("statuses", { cwd: p.root, timeoutMs: 20000 });
    assert.equal(r.ok, true);
    // The literal is intentional, not a missed import: this test exists to pin
    // that Backlog.md's own default matches the exact string the cascade
    // matches against. Importing IN_PROGRESS here would make the pin compare
    // the constant to itself, unable to detect a rename of that constant.
    assert.ok(r.list.includes("In Progress"), `got ${JSON.stringify(r.list)}`);
  } finally {
    p.cleanup();
  }
});
