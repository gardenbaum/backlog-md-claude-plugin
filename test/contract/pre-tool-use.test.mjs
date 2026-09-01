import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { run } from "../../lib/proc.mjs";
import { parseHookOutput } from "../helpers/fixture.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "pre-tool-use.mjs");

function shQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`;
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "bcc-pre-"));
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(root, "backlog", "config.yml"), "\n");
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

// The env prefix belongs on the node invocation only — the hook reads it, not printf.
async function feed(payload, cwd, env = "") {
  return run(
    "/bin/sh",
    ["-c", `printf %s ${shQuote(JSON.stringify(payload))} | ${env} ${shQuote(process.execPath)} ${shQuote(HOOK)}`],
    { cwd, timeoutMs: 10000 },
  );
}

const editTask = (root) => ({
  session_id: "s1",
  cwd: root,
  tool_name: "Edit",
  tool_input: {
    file_path: join(root, "backlog", "tasks", "BACK-12 - Add OAuth.md"),
    new_string: "## Implementation Notes\nstarted",
  },
});

test("editing a task file is denied, with the replacement command in the reason", async () => {
  const root = project();
  const r = await feed(editTask(root), root);
  assert.equal(r.code, 0, "a deny is still a successful hook run");
  const output = parseHookOutput(r, "PreToolUse").hookSpecificOutput;
  assert.equal(output.hookEventName, "PreToolUse");
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /--append-notes/);
  assert.match(output.permissionDecisionReason, /BACK-12/);
  assert.ok(!("reason" in output));
});

test("a NotebookEdit is caught through tool_input.notebook_path, same as tool_input.file_path", async () => {
  const root = project();
  const r = await feed(
    {
      session_id: "s4",
      cwd: root,
      tool_name: "NotebookEdit",
      tool_input: {
        notebook_path: join(root, "backlog", "tasks", "BACK-12 - Add OAuth.md"),
        new_source: "## Implementation Notes\nstarted",
      },
    },
    root,
  );
  assert.equal(r.code, 0);
  const output = parseHookOutput(r, "PreToolUse").hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /BACK-12/);
});

test("editing a source file is not the guard's business", async () => {
  const root = project();
  const r = await feed(
    { session_id: "s2", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "src", "a.ts") } },
    root,
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "", "no decision at all, not an explicit allow");
});

// `backlog decision create` writes a template and no CLI command fills it in,
// so denying the hand-edit made decision records permanently empty — measured:
// a session was refused the write and its audit result exists nowhere (BCC-5).
test("a decision record that already exists may be written by hand", async () => {
  const root = project();
  const file = join(root, "backlog", "decisions", "decision-1 - Image naming.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "---\nid: decision-1\n---\n\n## Context\n");

  const r = await feed(
    { session_id: "s5", cwd: root, tool_name: "Write", tool_input: { file_path: file, content: "filled in" } },
    root,
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "", "the only way to fill in a decision must not be blocked");
});

test("a decision file that does not exist yet is denied, and points at 'decision create'", async () => {
  const root = project();
  const r = await feed(
    {
      session_id: "s6",
      cwd: root,
      tool_name: "Write",
      tool_input: {
        file_path: join(root, "backlog", "decisions", "decision-9 - Written by hand.md"),
        content: "## Context\n",
      },
    },
    root,
  );
  assert.equal(r.code, 0);
  const output = parseHookOutput(r, "PreToolUse").hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /backlog decision create/);
});

test("BACKLOG_MD_GUARD=0 turns the deny into a warning", async () => {
  const root = project();
  const r = await feed(editTask(root), root, "BACKLOG_MD_GUARD=0");
  assert.equal(r.code, 0);
  const output = parseHookOutput(r, "PreToolUse").hookSpecificOutput;
  assert.ok(!("permissionDecision" in output), "the switch means no decision, not a permissive one");
  assert.match(output.additionalContext, /--append-notes/);
});

test("outside a project nothing is denied", async () => {
  const empty = mkdtempSync(join(tmpdir(), "bcc-none-"));
  const r = await feed(
    {
      session_id: "s3",
      cwd: empty,
      tool_name: "Edit",
      tool_input: { file_path: join(empty, "backlog", "tasks", "x.md") },
    },
    empty,
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("malformed input does not deny anything", async () => {
  const root = project();
  const r = await run("/bin/sh", ["-c", `printf garbage | ${shQuote(process.execPath)} ${shQuote(HOOK)}`], {
    cwd: root,
    timeoutMs: 10000,
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

const initCommand = (root) => ({
  session_id: "s5",
  cwd: root,
  tool_name: "Bash",
  tool_input: { command: "backlog init" },
});

// The accident this guards against happened here: an init in a repository
// that already had one replaced backlog/config.yml with defaults (BCC-9).
test("`backlog init` on an existing project is refused, naming the file and both ways forward", async () => {
  const root = project();
  const r = await feed(initCommand(root), root);
  assert.equal(r.code, 0);
  const output = parseHookOutput(r, "PreToolUse").hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /backlog\/config\.yml/);
  assert.match(output.permissionDecisionReason, /backlog config set/);
  assert.match(output.permissionDecisionReason, /move or delete/i);
});

test("`backlog init` where there is no project runs untouched", async () => {
  const empty = mkdtempSync(join(tmpdir(), "bcc-init-"));
  const r = await feed({ ...initCommand(empty), cwd: empty }, empty);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "", "the init that creates a project must not be blocked");
});

test("every other shell command passes the Bash matcher untouched", async () => {
  const root = project();
  for (const command of ["backlog task list --plain", "npm test", "git init"]) {
    const r = await feed({ ...initCommand(root), tool_input: { command } }, root);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "", command);
  }
});
