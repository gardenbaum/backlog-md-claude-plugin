import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginRootCandidates, resolvePluginRoot } from "../../lib/plugin-root.mjs";

/** A directory that looks like an installed copy of this plugin. */
function fakePlugin(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "backlog-cc.mjs"), "// stand-in\n");
  return root;
}

function tempHome(versions = []) {
  const home = mkdtempSync(join(tmpdir(), "bcc-home-"));
  const cache = join(home, ".claude", "plugins", "cache", "gardenbaum", "backlog-md");
  mkdirSync(cache, { recursive: true });
  for (const version of versions) fakePlugin(cache, version);
  return home;
}

test("an explicit git config entry outranks the baked hint and the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "bcc-roots-"));
  try {
    const configured = fakePlugin(dir, "configured");
    const hint = fakePlugin(dir, "hint");
    const env = { CLAUDE_PLUGIN_ROOT: fakePlugin(dir, "env") };
    assert.equal(resolvePluginRoot({ configured, hint, env, home: "" }), configured);
    assert.equal(resolvePluginRoot({ hint, env, home: "" }), hint);
    assert.equal(resolvePluginRoot({ env, home: "" }), env.CLAUDE_PLUGIN_ROOT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The hint is a literal placeholder in the template that lives in this
// repository. Treating it as a path would be harmless but confusing in a
// candidate list someone is reading to work out why a hook did nothing.
test("the unsubstituted template placeholder is not a candidate", () => {
  const candidates = pluginRootCandidates({ hint: "@@PLUGIN_ROOT@@", env: {}, home: "" });
  assert.deepEqual(candidates, []);
});

test("the nearest project-scoped OMP install outranks user installs", () => {
  const workspace = mkdtempSync(join(tmpdir(), "bcc-omp-project-"));
  const home = mkdtempSync(join(tmpdir(), "bcc-omp-home-"));
  try {
    const projectPlugin = fakePlugin(join(workspace, ".omp", "plugins", "node_modules"), "backlog-md");
    fakePlugin(join(home, ".omp", "plugins", "node_modules"), "backlog-md");
    assert.equal(resolvePluginRoot({ env: {}, home, cwd: join(workspace, "src") }), projectPlugin);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("OMP user installs resolve from XDG and custom config roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "bcc-omp-roots-"));
  try {
    const xdgPlugin = fakePlugin(join(dir, "xdg", "omp", "plugins", "node_modules"), "backlog-md");
    assert.equal(resolvePluginRoot({ env: { XDG_DATA_HOME: join(dir, "xdg") }, home: join(dir, "home") }), xdgPlugin);

    const customPlugin = fakePlugin(join(dir, "custom", "plugins", "node_modules"), "backlog-md");
    assert.equal(
      resolvePluginRoot({ env: { PI_CONFIG_DIR: join(dir, "custom") }, home: join(dir, "home") }),
      customPlugin,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The case the whole module exists for: the plugin moved, nothing was
// reinstalled, and the hook has to find it anyway.
test("a plugin found only in the marketplace cache still resolves", () => {
  const home = tempHome(["0.1.0"]);
  try {
    const resolved = resolvePluginRoot({ hint: "/gone/backlog-md/0.0.9", env: {}, home });
    assert.equal(resolved, join(home, ".claude", "plugins", "cache", "gardenbaum", "backlog-md", "0.1.0"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// An update leaves the previous version directory in place, so "first match
// wins" would pin the hook to the version it was installed against forever.
test("the newest cached version wins when an update left the old one behind", () => {
  const home = tempHome(["0.1.0", "0.2.0"]);
  try {
    assert.match(resolvePluginRoot({ env: {}, home }), /0\.2\.0$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A candidate directory that exists but holds no entry point is not a plugin —
// an emptied cache directory, or someone else's `backlog-md`.
test("a candidate without scripts/backlog-cc.mjs is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "bcc-roots-"));
  try {
    mkdirSync(join(dir, "empty"), { recursive: true });
    assert.equal(resolvePluginRoot({ hint: join(dir, "empty"), env: {}, home: "" }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Null is the answer the hooks depend on: the plugin can be uninstalled while
// its hooks stay in .git/hooks, and they must do nothing rather than fail.
test("nothing resolvable is null, not a throw", () => {
  assert.equal(resolvePluginRoot({ env: {}, home: "/nonexistent/home" }), null);
});

// Lexically 0.9.0 sorts above 0.10.0, so a string sort would have resolved
// every hook to the older install from version 0.10.0 on (BCC-38).
test("0.10.0 outranks 0.9.0 — version segments compare as numbers", () => {
  const home = tempHome(["0.9.0", "0.10.0"]);
  try {
    assert.match(resolvePluginRoot({ env: {}, home }), /0\.10\.0$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Claude Code writes `unknown` when a marketplace carries no version, and that
// is the install a developer is currently running. It outranked every number
// under the string sort; the numeric comparison must not demote it to zero.
test("a non-numeric version directory still outranks every number", () => {
  const home = tempHome(["0.9.0", "unknown", "0.10.0"]);
  try {
    assert.match(resolvePluginRoot({ env: {}, home }), /unknown$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
