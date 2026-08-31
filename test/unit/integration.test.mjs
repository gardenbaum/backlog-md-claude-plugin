import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnFlush } from "../../lib/integration.mjs";

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
