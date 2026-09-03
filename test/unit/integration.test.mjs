import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { advisoryForToolCall, failedToolResponse, spawnFlush } from "../../lib/integration.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A project shell — just enough for findProject, with no Backlog CLI involved. */
function projectDir() {
  const root = mkdtempSync(join(tmpdir(), "bcc-flush-"));
  mkdirSync(join(root, "backlog"), { recursive: true });
  writeFileSync(join(root, "backlog", "config.yml"), "");
  return root;
}

/** Run `spawnFlush` against a state directory that cannot hold a summary. */
async function flushWithBrokenState() {
  const project = projectDir();
  const blocked = join(mkdtempSync(join(tmpdir(), "bcc-state-")), "not-a-directory");
  writeFileSync(blocked, "");

  const seen = { errors: [], summaries: [], spawned: false };
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = blocked;
  try {
    await spawnFlush({
      cwd: project,
      sessionId: "blocked-summary",
      pluginRoot: PLUGIN_ROOT,
      nodeExecutable: process.execPath,
      onError: (error) => seen.errors.push(error),
      onSummary: (error) => seen.summaries.push(error),
      onSpawn: () => {
        seen.spawned = true;
      },
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
  return seen;
}

// The counters frozen at shutdown are diagnostics; the pending modified-file
// list the worker writes is the work. An unwritable state directory has to
// cost the first and never the second.
test("a summary that cannot be written still lets the flush worker start", async () => {
  const seen = await flushWithBrokenState();

  assert.equal(seen.spawned, true);
  assert.equal(seen.summaries.length, 1);
  assert.match(String(seen.summaries[0]), /ENOTDIR|ENOENT|EEXIST/);
});

// Sharing `onError` with the worker made the summary's failure unreportable:
// the spawn that follows clears every failure recorded at or before its own
// attempt, so the entry was deleted microseconds after it was written.
test("a failed summary is reported apart from the worker that would clear it", async () => {
  const seen = await flushWithBrokenState();

  assert.deepEqual(seen.errors, []);
  assert.equal(seen.summaries.length, 1);
});

// The create-time check only ever saw a task's first draft. A run split four
// compound criteria by hand and wrote a fifth compound one on the way, through
// `backlog task edit --ac`, where nothing was looking (BCC-10, edgemaker).
test("a shell command that writes a compound criterion is warned about before it runs", () => {
  const cwd = projectDir();
  const advisory = advisoryForToolCall({
    cwd,
    toolName: "Bash",
    toolInput: { command: "backlog task edit EDG-2 --ac 'Der Pfad folgt der Konvention; die Datei kommt spaeter.'" },
  });
  assert.ok(advisory, "no warning for a criterion carrying two assertions");
  assert.match(advisory, /One of the criteria in this command carries/);
  assert.match(advisory, /backlog_edit_ac \{ taskId: "EDG-2"/, "the warning must name the task it is about");
});

test("nothing is said about an atomic criterion, a read, or a command outside a project", () => {
  const cwd = projectDir();
  const atomic = { command: "backlog task edit EDG-2 --ac 'Die Datei existiert.'" };
  assert.equal(advisoryForToolCall({ cwd, toolName: "Bash", toolInput: atomic }), null);
  assert.equal(advisoryForToolCall({ cwd, toolName: "Bash", toolInput: { command: "backlog task list" } }), null);
  assert.equal(advisoryForToolCall({ cwd, toolName: "Read", toolInput: { file_path: "x" } }), null);
  const outside = mkdtempSync(join(tmpdir(), "bcc-nonproject-"));
  const compound = { command: "backlog task edit EDG-2 --ac 'a and b'" };
  assert.equal(advisoryForToolCall({ cwd: outside, toolName: "Bash", toolInput: compound }), null);
});

// Twelve rejected `backlog task edit` calls were recorded as mutations that had
// happened, because the Claude Code hook hard-coded `isError: false` (BCC-10).
test("a tool response is read as failed only on evidence, never on a guess", () => {
  for (const response of [{ is_error: true }, { isError: true }, { success: false }, { exitCode: 1 }, { code: 2 }]) {
    assert.equal(failedToolResponse(response), true, JSON.stringify(response));
  }
  for (const response of [{ exitCode: 0 }, { stdout: "Updated task BCC-1" }, {}, undefined, "text", null]) {
    assert.equal(failedToolResponse(response), false, JSON.stringify(response));
  }
});
