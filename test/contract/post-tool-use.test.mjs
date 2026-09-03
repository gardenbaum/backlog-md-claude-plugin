import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { run } from "../../lib/proc.mjs";
import { deriveSession } from "../../lib/cache.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "post-tool-use.mjs");

function shQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`;
}

function project(sources = ["a.ts", "b.ts"]) {
  const root = mkdtempSync(join(tmpdir(), "bcc-post-"));
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(root, "backlog", "config.yml"), "\n");
  mkdirSync(join(root, "src"), { recursive: true });
  // PostToolUse fires after the write, so the files these payloads name are on
  // disk by the time the hook sees them. That is what tells a path apart from a
  // display label the payload also carries (BCC-11).
  for (const file of sources) writeFileSync(join(root, "src", file), "export const x = 1;\n");
  return root;
}

async function feed(payload, cwd) {
  return run(
    "/bin/sh",
    ["-c", `printf %s ${shQuote(JSON.stringify(payload))} | ${shQuote(process.execPath)} ${shQuote(HOOK)}`],
    { cwd, timeoutMs: 10000 },
  );
}

test("a source edit is counted and its path recorded, relative to the repo", async () => {
  const root = project();
  const r = await feed(
    { session_id: "s1", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "src", "a.ts") } },
    root,
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "", "PostToolUse must never emit anything");
  const derived = deriveSession(root, "s1");
  assert.equal(derived.sourceEdits, 1);
  assert.deepEqual(derived.pendingModifiedFiles, ["src/a.ts"]);
});

test("repeated edits accumulate and deduplicate", async () => {
  const root = project();
  for (const f of ["src/a.ts", "src/b.ts", "src/a.ts"]) {
    await feed({ session_id: "s2", cwd: root, tool_name: "Write", tool_input: { file_path: join(root, f) } }, root);
  }
  const derived = deriveSession(root, "s2");
  assert.equal(derived.sourceEdits, 3, "every edit counts");
  assert.deepEqual(derived.pendingModifiedFiles.sort(), ["src/a.ts", "src/b.ts"], "paths are a set");
});

test("an edit to a backlog task file is not a source edit", async () => {
  const root = project();
  await feed(
    {
      session_id: "s3",
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: join(root, "backlog", "tasks", "BACK-1 - X.md") },
    },
    root,
  );
  const derived = deriveSession(root, "s3");
  assert.equal(derived.sourceEdits, 0);
  assert.deepEqual(derived.pendingModifiedFiles, []);
});

// A non-notes mutation appends only `stale`; `editsAtLastNotes` — which
// tracks the notes-specific event — is unaffected.
test("a non-notes mutating backlog command marks the session stale, leaving editsAtLastNotes alone", async () => {
  const root = project();
  await feed(
    { session_id: "s4", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "src", "a.ts") } },
    root,
  );
  await feed(
    {
      session_id: "s4",
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "backlog task edit BACK-1 --check-ac 1" },
    },
    root,
  );
  const derived = deriveSession(root, "s4");
  assert.equal(derived.stale, true);
  assert.equal(derived.sourceEdits, 1, "a backlog command is not a source edit");
  assert.equal(derived.editsAtLastNotes, 0, "no notes event was ever appended");
});

// A notes-only command appends *both* events: `stale`, because it is still
// a mutation whose effect on other task facts is not known, and `notes`, so
// `editsAtLastNotes` tracks when notes were last touched. The two are not
// mutually exclusive — an earlier version of this hook treated them as such,
// which meant a command that wrote notes and changed status in the same
// call (`--append-notes ... -s Done`) produced no `stale` event at all.
test("writing notes marks the session stale AND records the edit count at that moment", async () => {
  const root = project();
  for (const f of ["src/a.ts", "src/b.ts"]) {
    await feed({ session_id: "s5", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, f) } }, root);
  }
  await feed(
    {
      session_id: "s5",
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "backlog task edit 1 --append-notes 'x'" },
    },
    root,
  );
  const derived = deriveSession(root, "s5");
  assert.equal(derived.editsAtLastNotes, 2);
  assert.equal(
    derived.stale,
    true,
    "a notes-writing mutation is still a mutation, and must also mark the session stale",
  );
});

// The combined case the correction exists for: a single command that both
// writes notes and changes another task fact.
test("a command that both writes notes and changes status marks stale and records the notes edit count", async () => {
  const root = project(["a.ts", "b.ts", "c.ts"]);
  for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
    await feed({ session_id: "s5b", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, f) } }, root);
  }
  await feed(
    {
      session_id: "s5b",
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "backlog task edit 1 --append-notes 'x' -s Done" },
    },
    root,
  );
  const derived = deriveSession(root, "s5b");
  assert.equal(
    derived.stale,
    true,
    "the status change makes the cached identity/facts suspect, same as any other mutation",
  );
  assert.equal(derived.editsAtLastNotes, 3);
});

test("a read-only backlog command changes nothing", async () => {
  const root = project();
  await feed(
    { session_id: "s6", cwd: root, tool_name: "Bash", tool_input: { command: "backlog task list --json" } },
    root,
  );
  const derived = deriveSession(root, "s6");
  assert.equal(derived.sourceEdits, 0);
  assert.equal(derived.stale, false);
});

test("outside a project the hook does nothing and exits 0", async () => {
  const empty = mkdtempSync(join(tmpdir(), "bcc-none-"));
  const r = await feed(
    { session_id: "s7", cwd: empty, tool_name: "Edit", tool_input: { file_path: join(empty, "x.ts") } },
    empty,
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("malformed input does not fail the hook", async () => {
  const root = project();
  const r = await run("/bin/sh", ["-c", `printf garbage | ${shQuote(process.execPath)} ${shQuote(HOOK)}`], {
    cwd: root,
    timeoutMs: 10000,
  });
  assert.equal(r.code, 0);
});

// `readCache` -> mutate -> `updateCache` is a non-atomic read-modify-write.
// Claude Code dispatches independent tool calls in parallel as a matter of
// routine, so six concurrent PostToolUse invocations is the ordinary case,
// not an edge one — and against the prior snapshot-based implementation this
// lost between a third and two-thirds of the edits (measured: 2-4 of 6
// landing, across repeated trials). The append-only journal must not lose any.
test("N concurrent invocations each record their own edit — none are lost to a clobbered read-modify-write", async () => {
  const N = 6;
  const root = project(Array.from({ length: N }, (_, i) => `f${i}.ts`));
  const runs = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      feed(
        { session_id: "s8", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "src", `f${i}.ts`) } },
        root,
      ),
    ),
  );
  for (const r of runs) assert.equal(r.code, 0);

  const derived = deriveSession(root, "s8");
  assert.equal(derived.sourceEdits, N, `expected all ${N} concurrent edits to be counted, got ${derived.sourceEdits}`);
  assert.equal(
    derived.pendingModifiedFiles.length,
    N,
    `expected all ${N} distinct paths to be recorded, got ${derived.pendingModifiedFiles.length}`,
  );
});

// A `backlog task edit` rejected by Backlog.md's per-task lock changed nothing,
// and twelve of them in one run were each recorded as a mutation that had
// landed, marking the cache stale twelve times over (BCC-10, edgemaker).
test("a backlog command that failed is not recorded as a mutation", async () => {
  const root = project();
  const payload = (session_id, tool_response) => ({
    session_id,
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "backlog task edit BCC-1 --ac 'one'" },
    tool_response,
  });
  await feed(payload("s-failed", { exitCode: 1, stderr: "is being modified by another process" }), root);
  assert.equal(deriveSession(root, "s-failed").stale, false, "a rejected command mutated nothing");

  await feed(payload("s-ok", { exitCode: 0, stdout: "Updated task BCC-1" }), root);
  assert.equal(deriveSession(root, "s-ok").stale, true, "a command that ran still marks the cache stale");
});
