import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { run } from "../../lib/proc.mjs";
import { makeProject, backlogAvailable } from "../helpers/fixture.mjs";
import { installHooks, HOOK_MARKER, HOOK_NAMES, BACKUP_SUFFIX } from "../../scripts/backlog-cc.mjs";

const isExecutable = (path) => (statSync(path).mode & 0o111) !== 0;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function commit(cwd, message, env) {
  return run("git", ["commit", "-m", message], { cwd, timeoutMs: 15000, ...(env ? { env } : {}) });
}

/**
 * A HOME with no plugin cache under it. The hooks fall back to scanning
 * `~/.claude/plugins/cache` (BCC-14), so a test about a hook that resolves
 * *nothing* has to say which home it is scanning — otherwise it passes or
 * fails on whether whoever runs the suite happens to have the plugin
 * installed.
 */
function emptyHome(t) {
  const home = mkdtempSync(join(tmpdir(), "bcc-empty-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: "" };
}

test("installing writes both hooks, executable, with the plugin path baked in", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    const result = await installHooks({ cwd: project.root });
    assert.equal(result.ok, true, JSON.stringify(result));
    for (const name of ["prepare-commit-msg", "pre-commit"]) {
      const path = join(project.root, ".git", "hooks", name);
      assert.ok(existsSync(path), `not written: ${name}`);
      const text = readFileSync(path, "utf8");
      assert.ok(text.includes(HOOK_MARKER), `${name}: no marker`);
      assert.ok(!text.includes("@@PLUGIN_ROOT@@"), `${name}: placeholder not substituted`);
      assert.ok(text.includes(root), `${name}: plugin root not baked in`);
      assert.ok(isExecutable(path), `${name}: not executable`);
    }
  } finally {
    project.cleanup();
  }
});

test("an existing foreign hook is never overwritten", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    const path = join(project.root, ".git", "hooks", "pre-commit");
    writeFileSync(path, "#!/bin/sh\n# someone else's hook\nexit 0\n", { mode: 0o755 });
    const result = await installHooks({ cwd: project.root });
    assert.equal(readFileSync(path, "utf8").includes("someone else's hook"), true);
    const skip = result.skipped.find((s) => s.path.endsWith("pre-commit"));
    assert.ok(skip, JSON.stringify(result));
    // An existing hook has to be chained or aborted with instructions — the
    // old message named neither remedy, leaving --force undiscoverable
    // outside the usage string.
    assert.match(skip.reason, /chain/i);
    assert.match(skip.reason, /--force/);
  } finally {
    project.cleanup();
  }
});

test("reinstalling over our own hook is allowed", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    await installHooks({ cwd: project.root });
    const result = await installHooks({ cwd: project.root });
    assert.equal(result.ok, true);
    assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped));
  } finally {
    project.cleanup();
  }
});

test("reinstalling our own hook rewrites its content and repairs a lost exec bit", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    await installHooks({ cwd: project.root });
    const path = join(project.root, ".git", "hooks", "prepare-commit-msg");

    // Tampered but still carrying the marker: a reinstall must still treat it
    // as ours and overwrite it with the real template, not skip it.
    writeFileSync(path, `${HOOK_MARKER}\n# tampered\nexit 1\n`, { mode: 0o755 });
    let result = await installHooks({ cwd: project.root });
    assert.equal(result.ok, true, JSON.stringify(result));
    const text = readFileSync(path, "utf8");
    assert.ok(!text.includes("# tampered"), "tampered body was not overwritten");
    assert.ok(text.includes(root), "plugin root not re-baked in");

    // A lost exec bit (chmod, an archive extraction, a Windows checkout) is
    // exactly what a reinstall must repair.
    chmodSync(path, 0o644);
    assert.ok(!isExecutable(path), "setup: exec bit should be off before reinstalling");
    result = await installHooks({ cwd: project.root });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(isExecutable(path), "reinstall did not restore the exec bit");
  } finally {
    project.cleanup();
  }
});

test("the trailer is appended when a task is In Progress", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    const id = await project.createTask("Trailer task");
    await project.cli(["task", "edit", id, "-s", "In Progress"]);
    await installHooks({ cwd: project.root });

    writeFileSync(join(project.root, "file.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: project.root });
    const c = await commit(project.root, "chore: touch a file");
    assert.equal(c.ok, true, c.stderr);

    const log = await run("git", ["log", "-1", "--pretty=%B"], { cwd: project.root });
    assert.match(log.stdout, new RegExp(`^Task: ${id}$`, "m"), log.stdout);
  } finally {
    project.cleanup();
  }
});

// commit.verbose (and -v, and cleanup=scissors) make git discard everything
// from its scissors line onward when the message is read back. The old hook
// appended below that line, so the trailer was silently lost in exactly the
// configuration commit.verbose=true is documented to produce. `git log
// --pretty` reformats and can hide this; `cat-file -p` reads the stored
// object as git wrote it.
test("the trailer survives commit.verbose=true, where git discards everything after the scissors line", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  const editorDir = mkdtempSync(join(tmpdir(), "bcc-editor-"));
  try {
    const id = await project.createTask("Verbose trailer task");
    await project.cli(["task", "edit", id, "-s", "In Progress"]);
    await installHooks({ cwd: project.root });

    // A non-interactive stand-in for $EDITOR: prepend a real subject line so
    // the message isn't empty, then leave the rest of the file — the hook's
    // own insertion and the scissors-delimited diff git appended — untouched.
    // This exercises the hook exactly as git drives it, without a real editor.
    const editorPath = join(editorDir, "editor.sh");
    writeFileSync(
      editorPath,
      '#!/bin/sh\nTMP="$1.prepend"\n{ printf \'feat: verbose commit\\n\'; cat "$1"; } > "$TMP"\nmv "$TMP" "$1"\n',
      { mode: 0o755 },
    );

    writeFileSync(join(project.root, "file.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: project.root });
    await run("git", ["config", "commit.verbose", "true"], { cwd: project.root });
    const c = await run("git", ["commit", "-q"], {
      cwd: project.root,
      timeoutMs: 15000,
      env: { ...process.env, GIT_EDITOR: editorPath },
    });
    assert.equal(c.ok, true, `${c.stdout}${c.stderr}`);

    const stored = await run("git", ["cat-file", "-p", "HEAD"], { cwd: project.root });
    assert.match(stored.stdout, new RegExp(`^Task: ${id}$`, "m"), stored.stdout);
    assert.equal((stored.stdout.match(/^Task:/gm) || []).length, 1, stored.stdout);
  } finally {
    rmSync(editorDir, { recursive: true, force: true });
    project.cleanup();
  }
});

test("the trailer is not duplicated when the message already has one", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    const id = await project.createTask("Idempotent task");
    await project.cli(["task", "edit", id, "-s", "In Progress"]);
    await installHooks({ cwd: project.root });

    writeFileSync(join(project.root, "file.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: project.root });
    await commit(project.root, `feat: thing\n\nTask: ${id}`);

    const log = await run("git", ["log", "-1", "--pretty=%B"], { cwd: project.root });
    assert.equal((log.stdout.match(/^Task:/gm) || []).length, 1, log.stdout);
  } finally {
    project.cleanup();
  }
});

test("no task means no trailer and a successful commit", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    await installHooks({ cwd: project.root });
    writeFileSync(join(project.root, "file.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: project.root });
    const c = await commit(project.root, "chore: no task");
    assert.equal(c.ok, true, c.stderr);
    const log = await run("git", ["log", "-1", "--pretty=%B"], { cwd: project.root });
    assert.ok(!/^Task:/m.test(log.stdout), log.stdout);
  } finally {
    project.cleanup();
  }
});

// The "no task" test above cannot tell an actual `none` state from a bug that
// appends a trailer for *any* state — the `none` state carries no task field
// either way. Two candidates in In Progress, unassigned to anyone matching
// git's identity, forces `ambiguous`, which genuinely needs active-id's
// branch/status whitelist to stay silent.
test("an ambiguous active task means no trailer either", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    const first = await project.createTask("Ambiguous task one");
    const second = await project.createTask("Ambiguous task two");
    await project.cli(["task", "edit", first, "-s", "In Progress"]);
    await project.cli(["task", "edit", second, "-s", "In Progress"]);
    await installHooks({ cwd: project.root });

    writeFileSync(join(project.root, "file.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: project.root });
    const c = await commit(project.root, "chore: ambiguous active task");
    assert.equal(c.ok, true, c.stderr);

    const log = await run("git", ["log", "-1", "--pretty=%B"], { cwd: project.root });
    assert.ok(!/^Task:/m.test(log.stdout), log.stdout);
  } finally {
    project.cleanup();
  }
});

// A hook that can find no plugin at all — uninstalled, or a cache that was
// emptied. It must not block a commit.
test("a hook that resolves no plugin at all still lets the commit through", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    await installHooks({ cwd: project.root });
    for (const name of ["prepare-commit-msg", "pre-commit"]) {
      const path = join(project.root, ".git", "hooks", name);
      writeFileSync(path, readFileSync(path, "utf8").replace(root, "/nonexistent/plugin/root"));
      chmodSync(path, 0o755);
    }
    writeFileSync(join(project.root, "file.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: project.root });
    const c = await commit(project.root, "chore: unresolvable hooks", emptyHome(t));
    assert.equal(c.ok, true, c.stderr);
  } finally {
    project.cleanup();
  }
});

// The failure this resolution exists to remove (BCC-14): a plugin update moves
// the install directory, the baked hint rots, and the hooks used to go quiet
// for good. The plugin is reachable only through the marketplace cache here,
// and nothing was reinstalled.
test("a hook whose hint is gone finds the plugin again in the marketplace cache", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  const home = mkdtempSync(join(tmpdir(), "bcc-cache-home-"));
  try {
    const cached = join(home, ".claude", "plugins", "cache", "gardenbaum", "backlog-md", "0.1.0");
    mkdirSync(dirname(cached), { recursive: true });
    symlinkSync(root, cached, "dir");

    await installHooks({ cwd: project.root });
    for (const name of ["prepare-commit-msg", "pre-commit"]) {
      const path = join(project.root, ".git", "hooks", name);
      writeFileSync(path, readFileSync(path, "utf8").replace(root, "/nonexistent/plugin/root"));
      chmodSync(path, 0o755);
    }

    const id = await project.createTask("Cache resolution");
    await project.cli(["task", "edit", id, "-s", "In Progress"]);
    writeFileSync(join(project.root, "file.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: project.root });
    const c = await commit(project.root, "chore: touch a file", {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_ROOT: "",
    });
    assert.equal(c.ok, true, c.stderr);

    const message = await run("git", ["log", "-1", "--pretty=%B"], { cwd: project.root });
    assert.match(message.stdout, new RegExp(`^Task: ${id}$`, "m"), message.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
    project.cleanup();
  }
});

// The test above proves the outcome (commit succeeds) but not the mechanism —
// a hook with the file-existence guard removed also lets the commit through,
// because `node <missing-path>` just fails and the later `[ -n "$ID" ]` check
// catches it. This test pins the guard itself: a stand-in `node` ahead of the
// real one on PATH proves whether the hook ever tried to invoke it.
test("the missing-template guard stops node from ever being invoked", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  const bin = mkdtempSync(join(tmpdir(), "bcc-node-stub-"));
  try {
    await installHooks({ cwd: project.root });
    for (const name of ["prepare-commit-msg", "pre-commit"]) {
      const path = join(project.root, ".git", "hooks", name);
      writeFileSync(path, readFileSync(path, "utf8").replace(root, "/nonexistent/plugin/root"));
      chmodSync(path, 0o755);
    }

    const marker = join(bin, "called");
    writeFileSync(join(bin, "node"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });

    writeFileSync(join(project.root, "file.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: project.root });
    const c = await run("git", ["commit", "-m", "chore: unresolvable hooks, guard check"], {
      cwd: project.root,
      timeoutMs: 15000,
      env: { ...emptyHome(t), PATH: `${bin}:${process.env.PATH}` },
    });

    assert.equal(c.ok, true, c.stderr);
    assert.equal(existsSync(marker), false, "the guard should exit before node is ever invoked");
  } finally {
    rmSync(bin, { recursive: true, force: true });
    project.cleanup();
  }
});

// main() catches checkStaged's own rejections, but an import failure inside
// backlog-cc.mjs (or one of its libs) is hoisted and uncatchable — and the
// `[ -f ... ]` guard only checks that the entry file exists, not that it (or
// anything it imports) still loads. Measured against the old hook: this made
// `git commit` exit 1 with a raw stack trace as the user's only explanation,
// on a commit that stages no task file at all. Independent of `backlog`, so
// no backlogAvailable() skip.
test("a broken import in backlog-cc.mjs lets the commit through, not a raw stack trace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bcc-broken-import-"));
  try {
    await run("git", ["init", "-q", "."], { cwd: dir });
    await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await run("git", ["config", "user.name", "Test"], { cwd: dir });

    const pluginRoot = join(dir, "plugin");
    mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
    writeFileSync(join(pluginRoot, "scripts", "backlog-cc.mjs"), 'import "node:this-module-does-not-exist";\n');

    const hookTemplate = readFileSync(join(root, "git", "pre-commit"), "utf8");
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), hookTemplate.replace(/@@PLUGIN_ROOT@@/g, pluginRoot), {
      mode: 0o755,
    });

    writeFileSync(join(dir, "file.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: dir });
    const c = await commit(dir, "chore: broken import");
    assert.equal(c.ok, true, `${c.stdout}${c.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a staged task file with corrupt frontmatter fails the commit", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    const id = await project.createTask("Corruptible task");
    await installHooks({ cwd: project.root });
    await run("git", ["add", "-A"], { cwd: project.root });
    await commit(project.root, "chore: baseline");

    const view = await run("backlog", ["task", id, "--json"], { cwd: project.root });
    const path = join(project.root, JSON.parse(view.stdout).task.path);
    writeFileSync(path, "status: [unclosed\n---\nbroken\n");
    await run("git", ["add", "-A"], { cwd: project.root });

    const c = await commit(project.root, "chore: commit a broken task");
    assert.equal(c.ok, false, "the commit should have been rejected");
    assert.match(`${c.stdout}${c.stderr}`, new RegExp(id, "i"));
  } finally {
    project.cleanup();
  }
});

test("a healthy staged task file commits normally", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    const id = await project.createTask("Healthy task");
    await project.cli(["task", "edit", id, "--ac", "A criterion"]);
    await installHooks({ cwd: project.root });
    await run("git", ["add", "-A"], { cwd: project.root });
    const c = await commit(project.root, "feat: add a task");
    assert.equal(c.ok, true, `${c.stdout}${c.stderr}`);
  } finally {
    project.cleanup();
  }
});

// The gate direction: uncertainty means pass, never block.
test("a commit that stages no task file is not checked at all", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    await installHooks({ cwd: project.root });
    writeFileSync(join(project.root, "src.txt"), "code\n");
    await run("git", ["add", "src.txt"], { cwd: project.root });
    const c = await commit(project.root, "feat: unrelated");
    assert.equal(c.ok, true, `${c.stdout}${c.stderr}`);
  } finally {
    project.cleanup();
  }
});

test("--no-verify bypasses the check, as documented", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    const id = await project.createTask("Bypassable task");
    await installHooks({ cwd: project.root });
    await run("git", ["add", "-A"], { cwd: project.root });
    await commit(project.root, "chore: baseline");

    const view = await run("backlog", ["task", id, "--json"], { cwd: project.root });
    writeFileSync(join(project.root, JSON.parse(view.stdout).task.path), "broken\n");
    await run("git", ["add", "-A"], { cwd: project.root });

    const c = await run("git", ["commit", "--no-verify", "-m", "chore: bypass"], {
      cwd: project.root,
      timeoutMs: 15000,
    });
    assert.equal(c.ok, true, `${c.stdout}${c.stderr}`);
  } finally {
    project.cleanup();
  }
});

// The direction that mattered and was wrong (BCC-13): the corrupt bytes are
// the ones being committed, and the working tree copy — repaired after
// staging — has nothing to do with what lands in the repository.
test("corrupt staged content is rejected even when the working tree copy is fine", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    const id = await project.createTask("Staged corruption");
    await installHooks({ cwd: project.root });
    await run("git", ["add", "-A"], { cwd: project.root });
    await commit(project.root, "chore: baseline");

    const view = await run("backlog", ["task", id, "--json"], { cwd: project.root });
    const path = join(project.root, JSON.parse(view.stdout).task.path);
    const healthy = readFileSync(path, "utf8");

    writeFileSync(path, "status: [unclosed\n---\nbroken\n");
    await run("git", ["add", "-A"], { cwd: project.root });
    writeFileSync(path, healthy); // repaired in the tree, still corrupt in the index

    const c = await commit(project.root, "chore: commit corrupt staged content");
    assert.equal(c.ok, false, "the commit should have been rejected");
    assert.match(`${c.stdout}${c.stderr}`, new RegExp(id, "i"));
    assert.equal(readFileSync(path, "utf8"), healthy, "the hook must not touch the working tree");
  } finally {
    project.cleanup();
  }
});

// The mirror of it: what is staged is fine, so the commit is fine. Whatever
// the person is still editing in the tree is their business until they stage
// it — and blocking on it would be the old behaviour, reversed.
test("a commit passes when the staged content is valid and only the working tree is corrupt", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  try {
    const id = await project.createTask("Tree corruption");
    await installHooks({ cwd: project.root });
    await run("git", ["add", "-A"], { cwd: project.root });
    await commit(project.root, "chore: baseline");

    const view = await run("backlog", ["task", id, "--json"], { cwd: project.root });
    const path = join(project.root, JSON.parse(view.stdout).task.path);
    writeFileSync(path, `${readFileSync(path, "utf8")}\nA staged edit.\n`);
    await run("git", ["add", "-A"], { cwd: project.root });

    const corrupt = "status: [unclosed\n---\nbroken\n";
    writeFileSync(path, corrupt); // corrupt in the tree only, never staged

    const c = await commit(project.root, "chore: commit valid staged content");
    assert.equal(c.ok, true, `${c.stdout}${c.stderr}`);
    assert.equal(readFileSync(path, "utf8"), corrupt, "the hook must not touch the working tree");
  } finally {
    project.cleanup();
  }
});

/**
 * A HOME whose plugin cache holds 0.9.0 and 0.10.0, each answering with its
 * own marker — so whatever the hook prints names the install it resolved.
 */
function twoCachedVersions(t) {
  const home = mkdtempSync(join(tmpdir(), "bcc-versions-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cache = join(home, ".claude", "plugins", "cache", "gardenbaum", "backlog-md");
  for (const version of ["0.9.0", "0.10.0"]) {
    const scripts = join(cache, version, "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(
      join(scripts, "backlog-cc.mjs"),
      [
        `if (process.argv[2] === "active-id") { process.stdout.write("FROM-${version}"); process.exit(0); }`,
        `process.stderr.write("backlog-md: staged task files — from ${version}\\n");`,
        "process.exit(1);",
        "",
      ].join("\n"),
    );
  }
  return home;
}

// The sh side of BCC-38. Lexically 0.9.0 is the last glob entry, so the old
// "last one wins" loop resolved both hooks to the older install from version
// 0.10.0 on. Neither hook is asked which root it took — the stubs answer
// differently, so the trailer and the refusal say it for them.
test("both sh hooks pick 0.10.0 over 0.9.0 out of the cache", async (t) => {
  const home = twoCachedVersions(t);
  const dir = mkdtempSync(join(tmpdir(), "bcc-sh-pick-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Not a git repository and a temporary HOME: `git config --get` finds no
  // configured root, so resolution reaches the cache scan it is here to test.
  const env = { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: "" };

  const message = join(dir, "COMMIT_EDITMSG");
  writeFileSync(message, "chore: touch a file\n");
  const prepare = await run("sh", [join(root, "git", "prepare-commit-msg"), message], { cwd: dir, env });
  assert.equal(prepare.ok, true, prepare.stderr);
  assert.match(readFileSync(message, "utf8"), /Task: FROM-0\.10\.0/);

  const pre = await run("sh", [join(root, "git", "pre-commit")], { cwd: dir, env });
  assert.equal(pre.ok, false, "the stub's considered verdict has to reach git");
  assert.match(pre.stderr, /from 0\.10\.0/);
});

/** A repository whose hooks git reads from a directory somebody else set. */
async function repoWithForeignHooksPath(t) {
  const dir = mkdtempSync(join(tmpdir(), "bcc-foreign-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await run("git", ["init", "-q", "."], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "T"], { cwd: dir });
  mkdirSync(join(dir, ".other", "hooks"), { recursive: true });
  writeFileSync(join(dir, ".other", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(join(dir, ".other", "hooks", "pre-commit"), 0o755);
  await run("git", ["config", "core.hooksPath", ".other/hooks"], { cwd: dir });
  return dir;
}

// BCC-50, defect 1. The installer used to write into .git/hooks and report
// success while git ran hooks from somewhere else entirely.
test("a foreign core.hooksPath is reported, not written into", async (t) => {
  const dir = await repoWithForeignHooksPath(t);
  const result = await installHooks({ cwd: dir });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "foreign-hooks-path");
  assert.deepEqual(result.written, [], "nothing may be written where git does not look, or where it does");
  assert.match(result.skipped[0].reason, /core\.hooksPath is set to '\.other\/hooks'/);
  assert.ok(!existsSync(join(dir, ".git", "hooks", "pre-commit")), "a dead hook was left in .git/hooks");
  assert.ok(!existsSync(join(dir, ".other", "hooks", "prepare-commit-msg")), "wrote into another tool's directory");
});

// The rule is the one the hook files already had: refused by default,
// overridable with --force, and the replaced hook kept.
test("--force installs into the configured directory and keeps what was there", async (t) => {
  const dir = await repoWithForeignHooksPath(t);
  const result = await installHooks({ cwd: dir, force: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.hooksPath, join(dir, ".other", "hooks"));
  assert.ok(existsSync(join(dir, ".other", "hooks", `pre-commit${BACKUP_SUFFIX}`)), "the foreign hook was not kept");
  assert.ok(readFileSync(join(dir, ".other", "hooks", "pre-commit"), "utf8").includes(HOOK_MARKER));
});

// BCC-50, defect 2. --shared used to overwrite core.hooksPath unconditionally,
// which silently retires every hook the old value pointed at.
test("--shared refuses a foreign core.hooksPath and leaves it alone", async (t) => {
  const dir = await repoWithForeignHooksPath(t);
  const result = await installHooks({ cwd: dir, shared: true });
  assert.equal(result.reason, "foreign-hooks-path");
  const still = await run("git", ["config", "--get", "core.hooksPath"], { cwd: dir });
  assert.equal(still.stdout.trim(), ".other/hooks", "somebody else's core.hooksPath was replaced");
  assert.ok(!existsSync(join(dir, ".githooks")), "a .githooks directory was created for an install that was refused");
});

// BCC-50, defect 3. Inside a worktree `.git` is a file, so building the path
// by hand threw ENOTDIR — swallowed, leaving exit 0 and nothing installed.
test("installing from inside a worktree writes to the hooks directory git uses", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject({ git: true });
  t.after(() => project.cleanup());
  await run("git", ["add", "-A"], { cwd: project.root });
  await run("git", ["commit", "-q", "-m", "init"], { cwd: project.root });
  const worktree = join(project.root, "wt");
  const added = await run("git", ["worktree", "add", "-q", worktree, "-b", "side"], { cwd: project.root });
  assert.equal(added.ok, true, added.stderr);

  const result = await installHooks({ cwd: worktree });
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const name of HOOK_NAMES) {
    assert.ok(existsSync(join(project.root, ".git", "hooks", name)), `${name} not in the shared hooks directory`);
    assert.ok(isExecutable(join(project.root, ".git", "hooks", name)));
  }
});
