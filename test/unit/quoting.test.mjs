import { test } from "node:test";
import assert from "node:assert/strict";
import { QUOTING_SHORT } from "../../lib/quoting.mjs";
import { denyReason } from "../../lib/deny.mjs";

// The promise that the rules reach every deny reason. The rules' own contents
// are a literal in lib/quoting.mjs; prompts.test.mjs pins that the skill and
// the agents carry them verbatim.
test("a task deny reason still ends with the short quoting rule", () => {
  const reason = denyReason(
    { managed: true, kind: "task", taskId: "TASK-7" },
    { file_path: "/r/backlog/tasks/task-7 - X.md", new_string: "## Implementation Notes" },
  );
  assert.ok(reason.includes(QUOTING_SHORT), reason);
});
