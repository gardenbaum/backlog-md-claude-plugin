import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSession } from "../../lib/integration.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A project shell — just enough for findProject, with no Backlog CLI involved. */
function projectDir() {
  const root = mkdtempSync(join(tmpdir(), "bcc-flush-"));
  mkdirSync(join(root, "backlog"), { recursive: true });
  writeFileSync(join(root, "backlog", "config.yml"), "");
  return root;
}

// The counters frozen at shutdown are diagnostics; the pending modified-file
// list the worker writes is the work. An unwritable state directory has to
// cost the first and never the second.
test("a summary that cannot be written still lets the flush worker start", async () => {
  const project = projectDir();
  const blocked = join(mkdtempSync(join(tmpdir(), "bcc-state-")), "not-a-directory");
  writeFileSync(blocked, "");

  const errors = [];
  let spawned = false;
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = blocked;
  try {
    await flushSession({
      cwd: project,
      sessionId: "blocked-summary",
      pluginRoot: PLUGIN_ROOT,
      nodeExecutable: process.execPath,
      onError: (error) => errors.push(error),
      onSpawn: () => {
        spawned = true;
      },
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }

  assert.equal(spawned, true);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /ENOTDIR|ENOENT|EEXIST/);
});
