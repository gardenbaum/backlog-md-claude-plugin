import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliJson } from "../helpers/fixture.mjs";

test("fixture reports a timed-out Backlog CLI result before parsing its output", () => {
  assert.throws(
    () => parseCliJson({ ok: false, reason: "timeout", stdout: '{"tasks":', stderr: "" }, "task list --json"),
    /backlog task list --json failed \(timeout\)/,
  );
});

test("fixture reports malformed Backlog CLI JSON after a successful command", () => {
  assert.throws(
    () => parseCliJson({ ok: true, reason: null, stdout: '{"tasks":', stderr: "" }, "task list --json"),
    /backlog task list --json returned malformed JSON/,
  );
});
