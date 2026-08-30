import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../lib/proc.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fakePlugin(pluginRoot) {
  mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
  writeFileSync(
    join(pluginRoot, "scripts", "backlog-cc.mjs"),
    `const command = process.argv[2];
if (command === "active-id") process.stdout.write("OMP-7\\n");
if (command === "check-staged") {
  process.stderr.write("backlog-md: staged task files resolved through OMP\\n");
  process.exit(1);
}
`,
  );
}

async function fixture(t, pluginRootFor) {
  const dir = mkdtempSync(join(tmpdir(), "bcc-omp-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const init = await run("git", ["init", "-q", "."], { cwd: dir });
  assert.equal(init.ok, true, init.stderr || init.stdout);

  const hooks = join(dir, ".git", "hooks");
  for (const name of ["pre-commit", "prepare-commit-msg"]) {
    copyFileSync(join(root, "git", name), join(hooks, name));
    chmodSync(join(hooks, name), 0o755);
  }
  const pluginRoot = pluginRootFor(dir);
  fakePlugin(pluginRoot);
  return { dir, hooks, pluginRoot };
}

async function assertBothHooksResolve({ dir, hooks }, env) {
  const isolatedHome = mkdtempSync(join(tmpdir(), "bcc-omp-hooks-home-"));
  const hookEnv = {
    ...process.env,
    HOME: isolatedHome,
    CLAUDE_PLUGIN_ROOT: "",
    PI_CONFIG_DIR: ".omp",
    ...env,
  };
  try {
    const preCommit = await run(join(hooks, "pre-commit"), [], { cwd: dir, env: hookEnv });
    assert.equal(preCommit.code, 1);
    assert.match(preCommit.stderr, /resolved through OMP/);

    const message = join(dir, "COMMIT_EDITMSG");
    writeFileSync(message, "Subject\n");
    const prepare = await run(join(hooks, "prepare-commit-msg"), [message, "message"], { cwd: dir, env: hookEnv });
    assert.equal(prepare.code, 0, prepare.stderr || prepare.stdout);
    assert.match(readFileSync(message, "utf8"), /Task: OMP-7/);
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

test("both git hooks resolve a project-scoped OMP plugin", async (t) => {
  const project = await fixture(t, (dir) => join(dir, ".omp", "plugins", "node_modules", "backlog-md"));
  await assertBothHooksResolve(project, {});
});

test("both git hooks walk ancestors for a monorepo-scoped OMP plugin", async (t) => {
  const outer = mkdtempSync(join(tmpdir(), "bcc-omp-monorepo-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const dir = join(outer, "packages", "app");
  mkdirSync(dir, { recursive: true });
  const init = await run("git", ["init", "-q", "."], { cwd: dir });
  assert.equal(init.ok, true, init.stderr || init.stdout);

  const hooks = join(dir, ".git", "hooks");
  for (const name of ["pre-commit", "prepare-commit-msg"]) {
    copyFileSync(join(root, "git", name), join(hooks, name));
    chmodSync(join(hooks, name), 0o755);
  }
  const pluginRoot = join(outer, ".omp", "plugins", "node_modules", "backlog-md");
  fakePlugin(pluginRoot);
  await assertBothHooksResolve({ dir, hooks }, {});
});

test("both git hooks resolve an XDG user-scoped OMP plugin", async (t) => {
  const xdg = mkdtempSync(join(tmpdir(), "bcc-omp-xdg-"));
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  const project = await fixture(t, () => join(xdg, "omp", "plugins", "node_modules", "backlog-md"));
  await assertBothHooksResolve(project, { XDG_DATA_HOME: xdg });
});
