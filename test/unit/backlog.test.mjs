import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  backlogJson,
  taskView,
  taskList,
  configList,
  priorities,
  resolveTodoStatus,
  setModifiedFiles,
} from "../../lib/backlog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "..", "helpers", "fake-backlog.mjs");

// The wrapper spawns `bin` with `prefixArgs` in front of the real arguments,
// so the stand-in is addressed as: bin = this node binary, prefixArgs = [script].
function withMode(mode, fn) {
  const previous = process.env.FAKE_BACKLOG_MODE;
  process.env.FAKE_BACKLOG_MODE = mode;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.FAKE_BACKLOG_MODE;
    else process.env.FAKE_BACKLOG_MODE = previous;
  });
}

const opts = { bin: process.execPath, prefixArgs: [FAKE] };

test("taskView returns the task on a well-formed response", () =>
  withMode("task-view", async () => {
    const r = await taskView("BACK-1", opts);
    assert.equal(r.ok, true);
    assert.equal(r.task.id, "BACK-1");
  }));

test("taskList returns an array, empty included", () =>
  withMode("task-list-empty", async () => {
    const r = await taskList(["-s", "In Progress"], opts);
    assert.equal(r.ok, true);
    assert.deepEqual(r.tasks, []);
  }));

test("a malformed task-list document (tasks missing) is reported as unavailable, not as an empty list", () =>
  withMode("task-list-malformed", async () => {
    const r = await taskList(["-s", "In Progress"], opts);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unparseable");
  }));

test("a non-1 schemaVersion is reported as schema-drift, not used", () =>
  withMode("schema-drift", async () => {
    const r = await taskView("BACK-1", opts);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "schema-drift");
    assert.equal(r.found, 2);
  }));

test("unparseable stdout is reported, not thrown", () =>
  withMode("garbage", async () => {
    const r = await taskView("BACK-1", opts);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unparseable");
  }));

test("a non-zero exit is reported as cli-error with the first stderr line", () =>
  withMode("error", async () => {
    const r = await taskView("BACK-9", opts);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "cli-error");
    assert.match(r.message, /^Task BACK-9 not found\./);
  }));

test("a missing binary is reported as cli-missing", async () => {
  const r = await taskView("BACK-1", { bin: "definitely-not-a-real-binary-xyzzy" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "cli-missing");
});

test("a hanging CLI is reported as timeout", () =>
  withMode("hang", async () => {
    const r = await taskView("BACK-1", { ...opts, timeoutMs: 150 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "timeout");
  }));

test("configList splits the comma-separated plain-text status list", () =>
  withMode("statuses", async () => {
    const r = await configList("statuses", opts);
    assert.equal(r.ok, true);
    assert.deepEqual(r.list, ["To Do", "In Progress", "Done"]);
  }));

test("configList reads the default assignees the same way", () =>
  withMode("default-assignees", async () => {
    const r = await configList("defaultAssignee", opts);
    assert.equal(r.ok, true);
    assert.deepEqual(r.list, ["alice", "bob"]);
  }));

test("configList is an empty list, not an error, when nothing is configured", () =>
  withMode("default-assignees-empty", async () => {
    const r = await configList("defaultAssignee", opts);
    assert.equal(r.ok, true);
    assert.deepEqual(r.list, []);
  }));

test("priorities splits the comma-separated plain-text list, in configured order", () =>
  withMode("priorities", async () => {
    const r = await priorities(opts);
    assert.equal(r.ok, true);
    assert.deepEqual(r.priorities, ["High", "Medium", "Low"]);
  }));

test("priorities is reported unparseable, not an empty list, when nothing is configured", () =>
  withMode("priorities-empty", async () => {
    const r = await priorities(opts);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unparseable");
  }));

test("priorities maps a CLI failure to cli-error, not a thrown exception", () =>
  withMode("error", async () => {
    const r = await priorities(opts);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "cli-error");
  }));

test("resolveTodoStatus reads the configured column new tasks land in", () =>
  withMode("default-status", async () => {
    const r = await resolveTodoStatus(opts);
    assert.equal(r.ok, true);
    assert.equal(r.status, "To Do");
  }));

test("resolveTodoStatus is unparseable, not used literally, when neither source answers", () =>
  withMode("default-status-not-set", async () => {
    const r = await resolveTodoStatus(opts);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unparseable");
  }));

test("backlogJson appends --json exactly once", () =>
  withMode("task-view", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-backlog-argv-"));
    const argvFile = join(dir, "argv.json");
    process.env.FAKE_BACKLOG_ARGV_FILE = argvFile;
    try {
      const r = await backlogJson(["task", "BACK-1"], opts);
      assert.equal(r.ok, true);
      const argv = JSON.parse(readFileSync(argvFile, "utf8"));
      assert.deepEqual(
        argv.filter((a) => a === "--json"),
        ["--json"],
      );
      assert.equal(argv[argv.length - 1], "--json");
    } finally {
      delete process.env.FAKE_BACKLOG_ARGV_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  }));

test("setModifiedFiles refuses an empty list rather than calling the CLI", async () => {
  const r = await setModifiedFiles("BACK-1", [], opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "nothing-to-write");
});

test("setModifiedFiles passes one flag per path", () =>
  withMode("task-view", async () => {
    const argvFile = join(mkdtempSync(join(tmpdir(), "bcc-argv-")), "argv.json");
    process.env.FAKE_BACKLOG_ARGV_FILE = argvFile;
    try {
      const r = await setModifiedFiles("BACK-1", ["src/a.ts", "src/b.ts"], opts);
      assert.equal(r.ok, true);
      const argv = JSON.parse(readFileSync(argvFile, "utf8"));
      assert.deepEqual(argv, ["task", "edit", "BACK-1", "--modified-file", "src/a.ts", "--modified-file", "src/b.ts"]);
      assert.ok(!argv.includes("--json"), "task edit does not emit the JSON envelope");
    } finally {
      delete process.env.FAKE_BACKLOG_ARGV_FILE;
    }
  }));

test("setModifiedFiles maps a CLI failure without throwing", () =>
  withMode("error", async () => {
    const r = await setModifiedFiles("BACK-9", ["src/a.ts"], opts);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "cli-error");
  }));
