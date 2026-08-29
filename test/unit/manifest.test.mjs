import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));

test("the manifest declares exactly the hooks this plan implements", () => {
  assert.deepEqual(Object.keys(manifest.hooks).sort(), [
    "PostToolUse",
    "PreToolUse",
    "SessionEnd",
    "SessionStart",
    "UserPromptSubmit",
  ]);
});

// 22.08.26 claude: PreCompact is absent on purpose (BCC-37). Measured against
// Claude Code 2.1.238, which refused the hook's output at every /compact:
// "Hook JSON output validation failed — (root): Invalid input". Its schema
// defines hookSpecificOutput for PreToolUse, UserPromptSubmit, PostToolUse,
// PostToolBatch and Stop/SubagentStop only, so a PreCompact hook cannot inject
// anything — it can only fail loudly. Compaction is covered by SessionStart,
// whose matcher includes `compact`.
test("no PreCompact hook is registered, because its output cannot be accepted", () => {
  assert.equal(manifest.hooks.PreCompact, undefined);
  assert.match(manifest.hooks.SessionStart[0].matcher, /\bcompact\b/);
});

// Not a literal restated back: this matcher IS the write protection. Drop a
// tool from it and the PreToolUse guard stops seeing that tool's writes, with
// a green suite (BCC-53). Same for Bash in PostToolUse, which is the only way
// a backlog mutation is ever observed.
test("the guard matchers name every tool whose writes they have to see", () => {
  assert.equal(manifest.hooks.PreToolUse[0].matcher, "Write|Edit|NotebookEdit");
  assert.equal(manifest.hooks.PostToolUse[0].matcher, "Write|Edit|NotebookEdit|Bash");
});

test("every declared hook command points at a file that exists", () => {
  for (const entries of Object.values(manifest.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        const match = hook.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"/);
        assert.ok(match, `command must reference CLAUDE_PLUGIN_ROOT: ${hook.command}`);
        assert.ok(existsSync(join(root, match[1])), `missing hook file: ${match[1]}`);
      }
    }
  }
});

// 22.08.26 claude: the manifest used to declare `commands`, `skills` and
// `agents` as directories. Measured against Claude Code 2.1.238, which refused
// the install outright: "Validation errors: agents: Invalid input". Its schema
// takes a path to an agent *file* there, and says of all three that declaring
// them turns the matching default directory's auto-load off — so the
// declarations bought nothing and cost the install. The directories are
// auto-loaded when nothing is declared, which is what the plugin wants.
test("the asset directories are auto-loaded, not declared", () => {
  for (const key of ["commands", "skills", "agents"]) {
    assert.equal(manifest[key], undefined, `${key} declared: this switches off auto-loading ${key}/`);
    assert.ok(existsSync(join(root, key)), `no ${key}/ directory to auto-load`);
  }
});

const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"));

// 22.08.26 claude: package.json joined the pin at the 0.2.0 bump. It is the
// third place the version is written and the only one no test held, which is
// how a version drifts — the two that are checked move together and the
// unchecked one stays behind.
test("the marketplace and package.json list this plugin at its own version", () => {
  const entry = marketplace.plugins.find((p) => p.name === manifest.name);
  assert.ok(entry, `no marketplace entry for ${manifest.name}`);
  assert.equal(entry.version, manifest.version);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, manifest.version);
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
});
test("package.json exposes the native OMP extension entry point", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.omp?.extensions, ["./omp/index.mjs"]);
  assert.ok(existsSync(join(root, pkg.omp.extensions[0])));
});

test("the marketplace source points at this repository root", () => {
  const entry = marketplace.plugins.find((p) => p.name === manifest.name);
  assert.equal(entry.source, "./");
});

test("the marketplace has an owner, which install requires", () => {
  assert.ok(marketplace.owner?.name, JSON.stringify(marketplace.owner));
});

// Both manifests declared MIT while no licence text existed, which grants
// nothing (BCC-21). The text is the artefact that matters, so it is pinned
// against what the manifests claim rather than merely being present.
test("the declared licence is the one the LICENSE file actually grants", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.license, manifest.license);
  const licence = readFileSync(join(root, "LICENSE"), "utf8");
  assert.match(licence, /^MIT License/);
  assert.match(licence, /Copyright \(c\) \d{4}/);
  assert.match(licence, /WITHOUT WARRANTY OF ANY KIND/);
  assert.equal(manifest.license, "MIT");
});

// A plugin somebody installs from a marketplace has to say who wrote it and
// where it came from; the manifest carried neither (BCC-35).
test("the manifest says who publishes this plugin and where it lives", () => {
  assert.ok(manifest.author?.name, JSON.stringify(manifest.author));
  for (const field of ["repository", "homepage"]) {
    assert.match(manifest[field] ?? "", /^https:\/\/\S+$/, `${field} must be an absolute https URL`);
  }
});
