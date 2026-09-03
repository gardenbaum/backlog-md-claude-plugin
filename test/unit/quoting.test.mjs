import { test } from "node:test";
import assert from "node:assert/strict";
import { QUOTING_RULES, QUOTING_SHORT } from "../../lib/quoting.mjs";
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

// "repeated `--append-*` flags" left the agent to guess which ones exist. One
// guessed `--append-ac`, which does not — the CLI answered "unknown option"
// and the split it was in the middle of stalled (BCC-10, edgemaker).
test("the append rule names the flags that exist instead of globbing at them", () => {
  const [multiline] = QUOTING_RULES;
  assert.doesNotMatch(multiline, /--append-\*/, "a glob is an invitation to invent a fourth flag");
  for (const flag of ["--append-plan", "--append-notes", "--append-final-summary"]) {
    assert.ok(multiline.includes(flag), `the append rule never names ${flag}`);
  }
  assert.match(multiline, /--ac/, "the rule has to say how criteria are written, since no append flag does it");
});

// Twelve `backlog task edit` calls in one run were rejected by Backlog.md's
// per-task lock because they were issued as parallel batches, and the retries
// re-applied what had already landed (BCC-10). The native tools have declared
// `concurrency: "exclusive"` since 0.3.6; nothing said it to an agent reaching
// for the CLI.
test("a rule tells agents to send one backlog command at a time", () => {
  const rule = QUOTING_RULES.find((text) => /one .*command at a time/i.test(text));
  assert.ok(rule, "no rule about issuing commands one at a time");
  assert.match(rule, /is being modified by another process/, "the rule must name the error it prevents");
  assert.match(QUOTING_SHORT, /one `backlog` command at a time/, "the deny reason drops the rule");
});
