import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installHooks, BACKUP_SUFFIX, HOOK_MARKER, HOOK_NAMES } from "../../scripts/backlog-cc.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A directory that is enough of a repository for installHooks to write into. */
function repoDir() {
  const root = mkdtempSync(join(tmpdir(), "bcc-install-"));
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  return root;
}

test("a local install keeps the hint, which is this plugin's directory", async () => {
  const repo = repoDir();
  try {
    const result = await installHooks({ cwd: repo });
    assert.equal(result.ok, true, JSON.stringify(result));
    for (const name of HOOK_NAMES) {
      const text = readFileSync(join(repo, ".git", "hooks", name), "utf8");
      assert.ok(text.includes(HOOK_MARKER), `${name}: no marker`);
      assert.match(text, new RegExp(`^PLUGIN_ROOT_HINT='${PLUGIN_ROOT}'$`, "m"), `${name}: hint not substituted`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// `--shared` writes into a directory meant to be committed. A path that only
// exists on the machine that ran the installer made that file a permanent
// no-op for every teammate and churned on every install (BCC-14).
test("a shared install writes no machine-specific path into the committed hook", async () => {
  const repo = repoDir();
  try {
    const result = await installHooks({ cwd: repo, shared: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.hooksPath, join(repo, ".githooks"));
    for (const name of HOOK_NAMES) {
      const text = readFileSync(join(repo, ".githooks", name), "utf8");
      assert.ok(text.includes(HOOK_MARKER), `${name}: no marker`);
      assert.ok(!text.includes(PLUGIN_ROOT), `${name}: still carries this machine's plugin path`);
      assert.ok(!text.includes("@@PLUGIN_ROOT@@"), `${name}: placeholder left unsubstituted`);
      assert.match(text, /^PLUGIN_ROOT_HINT=''$/m, `${name}: hint should be empty`);
      // Not path-free by accident: the resolution the hook falls back to has
      // to still be in the file.
      assert.match(text, /find_plugin_root/, `${name}: no runtime resolution left`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --force was the one irreversible thing this installer could do: replace
// somebody's own pre-commit hook with ours and keep nothing (BCC-15).
test("--force keeps the hook it replaces", async () => {
  const repo = repoDir();
  try {
    const target = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(target, "#!/bin/sh\n# someone else's hook\nexit 3\n", { mode: 0o755 });

    const result = await installHooks({ cwd: repo, force: true });
    assert.equal(result.ok, true, JSON.stringify(result));

    const backup = `${target}${BACKUP_SUFFIX}`;
    assert.deepEqual(
      result.backedUp.map((b) => b.backup),
      [backup],
    );
    assert.match(readFileSync(backup, "utf8"), /someone else's hook/);
    assert.ok(readFileSync(target, "utf8").includes(HOOK_MARKER), "ours was not installed over it");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("replacing one of our own hooks writes no backup", async () => {
  const repo = repoDir();
  try {
    await installHooks({ cwd: repo });
    const result = await installHooks({ cwd: repo, force: true });
    assert.deepEqual(result.backedUp, []);
    for (const name of HOOK_NAMES) {
      assert.equal(existsSync(join(repo, ".git", "hooks", `${name}${BACKUP_SUFFIX}`)), false, `${name}: backed up`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The failure mode a naive "always back up" would ship: run --force twice and
// the backup holds our own template, with the person's hook gone for good.
test("a second --force leaves the first backup intact", async () => {
  const repo = repoDir();
  try {
    const target = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(target, "#!/bin/sh\n# someone else's hook\nexit 3\n", { mode: 0o755 });
    await installHooks({ cwd: repo, force: true });
    await installHooks({ cwd: repo, force: true });
    assert.match(readFileSync(`${target}${BACKUP_SUFFIX}`, "utf8"), /someone else's hook/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
