import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { denyReason, initReason } from "../../lib/deny.mjs";

const task = { managed: true, kind: "task", taskId: "BACK-12" };

// Extracts exactly the lines denyReason means to be pasted or read as a
// command, from between its "Use instead:" header and the next paragraph
// break (or the end of the string) — never the surrounding prose, which is
// free to use contractions and punctuation that would not itself be valid
// shell syntax.
function commandLines(reason) {
  const match = reason.match(/Use instead:\n([\s\S]*?)(?:\n\n|$)/);
  if (!match) return [];
  return match[1].split("\n").map((line) => line.replace(/^ {2}/, ""));
}

function assertPasteable(reason) {
  for (const line of commandLines(reason)) {
    const result = spawnSync("bash", ["-n"], { input: line, encoding: "utf8" });
    assert.equal(result.status, 0, `not valid shell syntax: ${line}\n${result.stderr}`);
  }
}

test("an edit touching acceptance criteria points at --ac and never guesses an index", () => {
  const reason = denyReason(task, { new_string: "## Acceptance Criteria\n- [ ] something new" });
  assert.match(reason, /--ac /);
  assert.ok(!/--check-ac \d/.test(reason), "an inferred index is worse than none");
  assert.match(reason, /--check-ac <n>/, "the flag is named, the number is not invented");
});

test("notes, plan, status and definition of done each get their own command", () => {
  const cases = [
    ["## Implementation Notes\nstarted", /--append-notes/],
    ["## Implementation Plan\n1. do it", /--append-plan/],
    ["status: In Progress", /-s /],
    ["## Definition of Done\n- [ ] tests pass", /--dod/],
  ];
  for (const [text, expected] of cases) {
    assert.match(denyReason(task, { new_string: text }), expected, text);
  }
});

test("an unrecognisable task edit supplies an executable command with its task id", () => {
  const reason = denyReason(task, { new_string: "just some prose" });
  assert.ok(commandLines(reason).includes("backlog task edit BACK-12 --help"));
  assertPasteable(reason);
});

test("a managed file with no parsable id never emits a command with a made-up id", () => {
  const reason = denyReason({ managed: true, kind: "task", taskId: null }, { new_string: "## Implementation Notes" });
  assert.match(reason, /backlog task edit --help/);
  assert.ok(!/BACK-/.test(reason));
});

test("config files point at the config surface, not at task edit", () => {
  const reason = denyReason({ managed: true, kind: "config", taskId: null }, { content: "statuses: [a]" });
  assert.match(reason, /backlog config/);
});

test("the reason always names the file's role and the reason for the redirect", () => {
  const reason = denyReason(task, { new_string: "## Implementation Notes\nx" });
  assert.match(reason, /BACK-12/);
  assert.match(reason, /metadata|consistent|CLI/i);
});

test("denyReason tolerates a missing or odd tool input", () => {
  for (const input of [undefined, null, {}, { new_string: null }]) {
    assert.equal(typeof denyReason(task, input), "string");
  }
});

// Every kind classifyBacklogPath can return, checked for two things at once:
// it must not claim to be a "task file" when it isn't one (the mislabelling
// review caught), and any command it does name must be one that exists in
// the installed CLI (backlog 1.50.1) — verified empirically per kind, not
// assumed from the task's own SECTIONS table.
const NON_TASK_KINDS = ["draft", "completed", "archive", "milestone", "doc", "decision"];

test("no non-task kind is ever called a task file", () => {
  for (const kind of NON_TASK_KINDS) {
    const reason = denyReason({ managed: true, kind, taskId: "X-1" }, {});
    assert.ok(!/is a Backlog\.md task file/.test(reason), `${kind} must not claim to be a task file`);
  }
});

test("a draft names no 'task edit' command line — verified empirically to fail on a draft id", () => {
  const reason = denyReason({ managed: true, kind: "draft", taskId: "DRAFT-1" }, {});
  assert.match(reason, /backlog draft/);
  assert.ok(
    !commandLines(reason).some((line) => /task edit/.test(line)),
    "'backlog task edit DRAFT-1' returns 'not found' — verified by hand, so no such command line may appear",
  );
  assertPasteable(reason);
});

test("a draft with no parsable id still points at 'backlog draft --help', not a guessed id", () => {
  const reason = denyReason({ managed: true, kind: "draft", taskId: null }, {});
  assert.match(reason, /backlog draft --help/);
  assert.ok(
    !commandLines(reason).some((line) => line.includes("promote")),
    "promoting needs a real id to act on, so no promote command line may appear without one",
  );
});

test("completed and archived tasks are historical records, and name no command at all", () => {
  for (const kind of ["completed", "archive"]) {
    const reason = denyReason({ managed: true, kind, taskId: "BACK-9" }, {});
    assert.match(reason, /historical record/i);
    assert.ok(!reason.includes("Use instead:"), `${kind}: no command applies, so none should be offered`);
  }
});

test("a milestone points at 'rename', the only content-changing command, never at task edit", () => {
  const reason = denyReason({ managed: true, kind: "milestone", taskId: "m-1" }, {});
  assert.match(reason, /backlog milestone rename/);
  assert.ok(!/backlog task edit/.test(reason));
  assertPasteable(reason);
});

test("a document points at 'doc update', never at task edit", () => {
  const reason = denyReason({ managed: true, kind: "doc", taskId: "doc-1" }, {});
  assert.match(reason, /backlog doc update doc-1/);
  assert.ok(!/backlog task edit/.test(reason));
  assertPasteable(reason);
});

// Reached only for a decision file that does not exist yet: the guard lets a
// hand-edit of an existing one through, because the CLI has no command that
// fills in the template `decision create` writes (BCC-5).
test("a decision points at 'decision create', and still invents no edit command", () => {
  const reason = denyReason({ managed: true, kind: "decision", taskId: "D-1" }, {});
  assert.match(reason, /backlog decision create/);
  assert.ok(!/backlog decision (edit|update)/.test(reason));
  assert.match(reason, /editing that file afterwards is allowed/i);
  assertPasteable(reason);
});

// Every command line under "Use instead:" must be something an agent can
// paste into a shell and run — not eyeballed, but checked with `bash -n`,
// because a bare parenthetical hint or an unquoted <placeholder> both break
// on the exact syntax error `bash -n` reports.
test("every command line the reason emits survives `bash -n`", () => {
  const cases = [
    denyReason(task, { new_string: "## Acceptance Criteria\n- [ ] x" }),
    denyReason(task, { new_string: "## Implementation Notes\nx" }),
    denyReason(task, { new_string: "## Implementation Plan\nx" }),
    denyReason(task, { new_string: "## Definition of Done\n- [ ] x" }),
    denyReason(task, { new_string: "status: In Progress" }),
    denyReason(task, { new_string: "just some prose" }),
    denyReason({ managed: true, kind: "config", taskId: null }, {}),
    denyReason({ managed: true, kind: "draft", taskId: "DRAFT-1" }, {}),
    denyReason({ managed: true, kind: "milestone", taskId: "m-1" }, {}),
    denyReason({ managed: true, kind: "doc", taskId: "doc-1" }, {}),
  ];
  for (const reason of cases) assertPasteable(reason);
});

// A refusal that only says no gets worked around. The three things it has to
// carry are the file at risk and both ways forward — one setting, or a
// deliberate re-init (BCC-9).
test("initReason names the config file and both ways forward", () => {
  const reason = initReason("backlog/config.yml");
  assert.match(reason, /backlog\/config\.yml/);
  assert.match(reason, /backlog config set/);
  assert.match(reason, /move or delete/i);
  const line = reason.match(/^ {2}(backlog config set.*)$/m)?.[1];
  assert.ok(line, "the config-set form is offered as a pasteable line");
  assert.equal(spawnSync("bash", ["-n"], { input: line, encoding: "utf8" }).status, 0, line);
});
