#!/usr/bin/env node
import { findProject, classifyBacklogPath } from "../lib/paths.mjs";
import { resolveActiveTask, describeActiveTask, IN_PROGRESS } from "../lib/active-task.mjs";
import { taskView, configList, configValue } from "../lib/backlog.mjs";
import { findNext } from "../lib/next.mjs";
import { renderBrief, renderNext } from "../lib/render.mjs";
import {
  cachePath,
  debugLog,
  debugPath,
  deriveSession,
  listSessions,
  listSessionSummaries,
  readCache,
  readRuntimeFailures,
} from "../lib/cache.mjs";
import { activeBacklogInstallations, resolvePluginRoot } from "../lib/plugin-root.mjs";
import { run, workerNodeExecutable } from "../lib/proc.mjs";
import { sweepAbandoned, flushSession } from "../lib/session-sweep.mjs";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_MARKER = "# backlog-md-plugin-hook v1";
export const HOOK_NAMES = ["prepare-commit-msg", "pre-commit"];
/** What `--force` renames somebody else's hook to before replacing it. */
export const BACKUP_SUFFIX = ".backlog-md.bak";

/**
 * Copy the hook templates into the repository, substituting the plugin root.
 * A hook we did not write is never overwritten — it is reported instead, so
 * the caller can chain it by hand.
 *
 * `shared: true` writes to `.githooks`, which is meant to be committed, so no
 * plugin-root hint is baked in there: a committed file must carry no path that
 * exists only on the installer's machine (BCC-14).
 *
 * Where to write is git's answer, not a string this function builds — the old
 * `repo + "/.git/hooks"` ignored `core.hooksPath` and threw ENOTDIR inside a
 * worktree, both silently (BCC-50). A `core.hooksPath` this installer did not
 * set is refused rather than used: it is usually another tool's directory, and
 * writing there can put a machine-local path into a tracked file. `--force`
 * overrides, as it does for a foreign hook file.
 */
export async function installHooks({ cwd = process.cwd(), shared = false, force = false } = {}) {
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const project = findProject(cwd);
  const repo = project?.root || cwd;

  if (!existsSync(join(repo, ".git"))) {
    return {
      ok: false,
      written: [],
      skipped: [],
      backedUp: [],
      hooksPath: null,
      configured: "",
      reason: "not-a-git-repository",
    };
  }

  const gitHooksPath = await resolveHooksPath(repo);
  const configured = await configuredHooksPath(repo);
  // Ownership by evidence rather than by convention: a directory holding our
  // marker is one we wrote, whatever it is called, and an empty configured
  // directory is still somebody's decision to point git elsewhere.
  const foreign = Boolean(configured) && !HOOK_NAMES.some((name) => isOurHook(join(gitHooksPath, name)));

  if (foreign && !force) {
    return {
      ok: false,
      written: [],
      skipped: [
        {
          path: gitHooksPath,
          reason:
            `git runs hooks from here, because core.hooksPath is set to '${configured}' — another tool's, by the ` +
            "look of it. Nothing was written and core.hooksPath was left alone: chain our templates by hand from " +
            `the hooks already there (${join(pluginRoot, "git")}), or re-run with --force to install into that ` +
            "directory anyway (a hook that is not ours is kept as <name>" +
            `${BACKUP_SUFFIX})`,
        },
      ],
      backedUp: [],
      hooksPath: gitHooksPath,
      configured,
      reason: "foreign-hooks-path",
    };
  }

  const hooksPath = shared ? join(repo, ".githooks") : gitHooksPath;
  const written = [];
  const skipped = [];
  const backedUp = [];

  mkdirSync(hooksPath, { recursive: true });
  for (const name of HOOK_NAMES) {
    const target = join(hooksPath, name);
    if (existsSync(target)) {
      const current = readFileSync(target, "utf8");
      if (!current.includes(HOOK_MARKER)) {
        if (!force) {
          skipped.push({
            path: target,
            reason:
              "a hook that is not ours is already installed — chain it by hand: add a call to our template " +
              `(${join(pluginRoot, "git", name)}) from your own hook, or re-run with --force to replace your ` +
              `hook outright (the replaced hook is kept as ${name}${BACKUP_SUFFIX})`,
          });
          continue;
        }
        // --force is the one irreversible thing the installer can do. Only a
        // hook that is not ours is backed up, so a second --force cannot bury
        // the first backup under our own template (BCC-15).
        const backup = `${target}${BACKUP_SUFFIX}`;
        writeFileSync(backup, current, { mode: 0o755 });
        chmodSync(backup, 0o755);
        backedUp.push({ path: target, backup });
      }
    }
    // chmod separately: writeFileSync's mode only applies to a file it
    // creates, so a reinstall over a hook that lost its exec bit would
    // otherwise report success while git still never runs it.
    const template = readFileSync(join(pluginRoot, "git", name), "utf8");
    writeFileSync(target, template.replace(/@@PLUGIN_ROOT@@/g, shared ? "" : pluginRoot), { mode: 0o755 });
    chmodSync(target, 0o755);
    written.push(target);
  }

  return { ok: skipped.length === 0, written, skipped, backedUp, hooksPath, configured };
}

/**
 * A throwaway project holding the staged bytes of the given task files.
 *
 * The check used to read the working tree while git was about to commit the
 * index. Measured both ways; the direction that matters is staged-corrupt then
 * repaired in the tree, which passed and committed the corrupt content
 * (BCC-13).
 *
 * A mirror rather than `git stash --keep-index`: a hook that moves somebody's
 * uncommitted work can lose it. The real config file comes along at its own
 * relative path, because it decides where tasks live and what the statuses are.
 *
 * Returns null when the mirror cannot be built — one more fail-open path.
 *
 * @param {{ root: string, configPath: string }} project
 * @param {{ line: string, content: string }[]} files
 * @returns {string | null}
 */
function mirrorStaged(project, files) {
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "backlog-md-staged-"));
    const config = relative(project.root, project.configPath);
    mkdirSync(dirname(join(dir, config)), { recursive: true });
    copyFileSync(project.configPath, join(dir, config));
    for (const { line, content } of files) {
      const target = join(dir, line);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return dir;
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

/**
 * The rule both checks apply: a task file the CLI cannot read is broken.
 *
 * Only a positive parse failure counts. `cli-missing` and `timeout` say
 * nothing about the file itself, so they pass — a check that blocks whenever
 * the CLI is unreachable would block every commit on a machine where a version
 * manager keeps `backlog` out of non-interactive shells.
 *
 * `deadline` stops the walk and reports what was left; here the remainder only
 * ever means "not looked at".
 *
 * @param {{ line: string, taskId: string }[]} files
 * @param {string} cwd project to read them in
 * @param {{ deadline?: number }} [options] epoch ms after which to stop
 * @returns {Promise<{ broken: { path: string, taskId: string, message: string }[], skipped: number }>}
 */
async function unreadable(files, cwd, { deadline = Number.POSITIVE_INFINITY } = {}) {
  const broken = [];
  for (const [index, file] of files.entries()) {
    if (Date.now() > deadline) return { broken, skipped: files.length - index };
    const view = await taskView(file.taskId, { cwd });
    if (!view.ok && (view.reason === "cli-error" || view.reason === "unparseable")) {
      broken.push({ path: file.line, taskId: file.taskId, message: view.message || view.reason });
    }
  }
  return { broken, skipped: 0 };
}

/**
 * Every task file in the checkout, readable or not.
 *
 * The pre-commit hook is a tripwire: local, only what is being committed, and
 * `--no-verify` walks past it. This is the same rule where a gate belongs
 * instead — CI, over the branch as it actually stands (BCC-12).
 *
 * @param {{ cwd?: string }} [options]
 */
export async function checkTasks({ cwd = process.cwd() } = {}) {
  const project = findProject(cwd);
  if (!project) return { ok: true, checked: [], broken: [] };

  const dir = join(project.backlogDir, "tasks");
  /** @type {{ line: string, taskId: string }[]} */
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { ok: true, checked: [], broken: [] }; // no tasks directory, nothing to check
  }
  for (const entry of entries.sort()) {
    const classified = classifyBacklogPath(join(dir, entry), project);
    if (!classified.managed || classified.kind !== "task" || !classified.taskId) continue;
    files.push({ line: relative(project.root, join(dir, entry)), taskId: classified.taskId });
  }

  // No deadline: this is the gate, and a gate that gives up early is not one.
  // Nobody is waiting on it either — it runs in CI, not in front of a commit.
  const { broken } = await unreadable(files, project.root);
  return { ok: broken.length === 0, checked: files.map((f) => f.line), broken };
}

/**
 * The one pre-commit check: every staged task file must still be readable
 * through the CLI, judged on the staged bytes rather than the working tree
 * (see `mirrorStaged`). `classifyBacklogPath` decides what counts as a task
 * file — the same decision the PreToolUse guard makes, not a second copy.
 *
 * Bounded in total, not just per file: a commit that migrates the backlog can
 * stage dozens of task files, and dozens of sequential 3s worst cases is a
 * hook that appears to have hung. Past the budget the rest pass unchecked and
 * the skip is reported.
 */
export const STAGED_BUDGET_MS = 10_000;

/**
 * @param {{ cwd?: string, budgetMs?: number }} [options]
 */
export async function checkStaged({ cwd = process.cwd(), budgetMs = STAGED_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  const project = findProject(cwd);
  if (!project) return { ok: true, checked: [], broken: [], skipped: 0 };

  const staged = await run("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { cwd: project.root });
  if (!staged.ok) return { ok: true, checked: [], broken: [], skipped: 0 }; // fail open

  /** @type {{ line: string, taskId: string, content: string }[]} */
  const files = [];
  const checked = [];
  for (const line of staged.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const classified = classifyBacklogPath(join(project.root, line), project);
    if (!classified.managed || classified.kind !== "task" || !classified.taskId) continue;
    checked.push(line);
    // `:<path>` is the index entry. An unreadable blob says nothing about the
    // file's content, so it passes like every other uncertainty here.
    const blob = await run("git", ["show", `:${line}`], { cwd: project.root });
    if (blob.ok) files.push({ line, taskId: classified.taskId, content: blob.stdout });
  }
  if (files.length === 0) return { ok: true, checked, broken: [], skipped: 0 };

  const mirror = mirrorStaged(project, files);
  if (!mirror) return { ok: true, checked, broken: [], skipped: 0 }; // fail open

  /** @type {{ broken: { path: string, taskId: string, message: string }[], skipped: number }} */
  let result = { broken: [], skipped: 0 };
  try {
    result = await unreadable(files, mirror, { deadline });
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
  return { ok: result.broken.length === 0, checked, broken: result.broken, skipped: result.skipped };
}

/**
 * Where git actually runs hooks from — `.git/hooks` unless `core.hooksPath`
 * says otherwise. `--shared` sets it to `.githooks`, and a foreign value
 * (husky's `.husky`, say) means git never runs `.git/hooks` at all, so a
 * marker left there must read as inactive rather than installed. Any failure
 * falls back to the default rather than erroring.
 */
async function resolveHooksPath(repoRoot) {
  const answer = await run("git", ["rev-parse", "--git-path", "hooks"], { cwd: repoRoot });
  const value = answer.ok ? answer.stdout.trim() : "";
  if (!value) return join(repoRoot, ".git", "hooks");
  return isAbsolute(value) ? value : join(repoRoot, value);
}

/**
 * The `core.hooksPath` somebody configured, or "" when nobody did. Separate
 * from `resolveHooksPath`: that one says where hooks run from, this one says
 * whether that location is somebody's decision. A worktree moves the first
 * without touching the second.
 *
 * @param {string} repoRoot
 * @returns {Promise<string>}
 */
async function configuredHooksPath(repoRoot) {
  const configured = await run("git", ["config", "--get", "core.hooksPath"], { cwd: repoRoot });
  return configured.ok ? configured.stdout.trim() : "";
}

/** @param {string} path @returns {boolean} */
function isOurHook(path) {
  try {
    return readFileSync(path, "utf8").includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

/**
 * Which of our hooks are installed, and what they resolve to when they run.
 *
 * The hooks resolve at run time, so the question worth answering is whether
 * that resolution finds anything: `resolvedRoot` null means the installed
 * hooks do nothing, and that is the only case a person has to act on (BCC-14).
 */
export async function gitHookState({ repoRoot, pluginRoot }) {
  const hooksPath = await resolveHooksPath(repoRoot);
  const hooks = HOOK_NAMES.map((name) => {
    const path = join(hooksPath, name);
    if (!existsSync(path)) return { name, installed: false, ours: false, hint: null };
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return { name, installed: true, ours: false, hint: null };
    }
    const ours = text.includes(HOOK_MARKER);
    return { name, installed: true, ours, hint: ours ? (text.match(/^PLUGIN_ROOT_HINT='(.*)'$/m)?.[1] ?? null) : null };
  });

  // Both hooks are written in one pass and carry the same hint, so resolving
  // once answers for both. Read the same git config key the hooks read.
  const configured = await run("git", ["config", "--get", "backlog-md.pluginroot"], { cwd: repoRoot });
  const resolvedRoot = hooks.some((h) => h.ours)
    ? resolvePluginRoot({
        configured: configured.ok ? configured.stdout.trim() : null,
        hint: hooks.find((h) => h.ours)?.hint,
        cwd: repoRoot,
      })
    : null;

  // Ours sitting where git does not look — an install predating this
  // resolution, or one done before somebody set core.hooksPath. "not
  // installed" was true of the live path and hid two dead files (BCC-50).
  const standard = join(repoRoot, ".git", "hooks");
  const stranded =
    hooksPath === standard ? [] : HOOK_NAMES.filter((name) => isOurHook(join(standard, name))).map((name) => name);

  return { hooksPath, hooks, stranded, resolvedRoot, resolvesHere: resolvedRoot === pluginRoot };
}

/**
 * Backlog.md settings that change what this plugin does. Read-only — doctor
 * reports them and never writes config.
 *
 * `onStatusChange` is read from the project's `config.yml` rather than through
 * `backlog config get`, which answers `Unknown config key` for it on 1.50.1
 * although the setting is parsed and honoured (measured).
 */
const CONFIG_KEYS = ["autoCommit", "bypassGitHooks", "checkActiveBranches", "remoteOperations"];

/** @param {string | null} configPath @returns {string | null} */
function statusChangeCallback(configPath) {
  if (!configPath) return null;
  try {
    const match = readFileSync(configPath, "utf8").match(/^\s*(?:onStatusChange|on_status_change)\s*:\s*(.+?)\s*$/m);
    return match ? match[1].replace(/^['"]|['"]$/g, "") : null;
  } catch {
    return null;
  }
}

function supportedNodeVersion(version) {
  const major = Number(String(version).match(/^v?(\d+)/)?.[1]);
  return Number.isInteger(major) && major >= 18;
}

/**
 * `sessionId` is the host's own session identity, and its absence is a
 * finding: only Claude Code names a session in the environment, so a report
 * without one is running under a host whose hooks do not exist — under OMP the
 * extension replaces them. A placeholder id here would read the cache of a
 * session nobody writes and fail every hook check by construction (BCC-2).
 *
 * @param {{ cwd?: string, sessionId?: string, home?: string }} [options]
 */
export async function collectDoctor({ cwd = process.cwd(), sessionId, home } = {}) {
  const project = findProject(cwd);
  const version = await run("backlog", ["--version"], { timeoutMs: 8000 });
  const workerCommand = workerNodeExecutable();
  const workerVersion = await run(workerCommand, ["--version"], { timeoutMs: 3000 });
  const report = {
    node: { version: process.version, execPath: process.execPath },
    workerNode: workerVersion.ok
      ? {
          command: workerCommand,
          reachable: true,
          version: workerVersion.stdout.trim(),
          supported: supportedNodeVersion(workerVersion.stdout.trim()),
        }
      : { command: workerCommand, reachable: false, reason: workerVersion.reason },
    backlog: version.ok
      ? { reachable: true, version: version.stdout.trim() }
      : { reachable: false, reason: version.reason },
    project: project
      ? { found: true, root: project.root, backlogDir: project.backlogDir, configPath: project.configPath }
      : { found: false },
    statuses: /** @type {{ list: string[], hasInProgress: boolean } | { error: string } | null} */ (null),
    active: /** @type {ReturnType<typeof describeActiveTask> | null} */ (null),
    git: /** @type {any} */ (null),
    cache: { path: /** @type {string | null} */ (null), snapshot: /** @type {any} */ (null) },
    hooks: { host: sessionId ? "claude-code" : "extension", runs: {}, everRan: false },
    extension: /** @type {{ active: boolean, ageMs: number | null }} */ ({ active: false, ageMs: null }),
    ompFailures: [],
    config: /** @type {Record<string, { value: string | null, reason: string | null }> | null} */ (null),
    guard: { enabled: process.env.BACKLOG_MD_GUARD !== "0" },
    debug: { enabled: Boolean(process.env.BACKLOG_MD_DEBUG) && process.env.BACKLOG_MD_DEBUG !== "0", log: debugPath() },
    installations:
      /** @type {{ paths: { installPath: string, versions: string[], sources: string[], present: boolean }[], duplicate: boolean }} */ ({
        paths: [],
        duplicate: false,
      }),
    sessionMetrics: /** @type {{ sessionId: string, metrics: any }[]} */ ([]),
  };

  const installPaths = new Map();
  for (const installation of activeBacklogInstallations({ cwd, home })) {
    const known = installPaths.get(installation.installPath) ?? {
      installPath: installation.installPath,
      versions: [],
      sources: [],
      // Registry entries outlive their directory: `omp plugin uninstall`
      // removes the shared marketplace copy even while a second scope still
      // points at it, and reports the survivor as installed (BCC-5).
      present: existsSync(installation.installPath),
    };
    if (!known.versions.includes(installation.version)) known.versions.push(installation.version);
    if (!known.sources.includes(installation.source)) known.sources.push(installation.source);
    installPaths.set(installation.installPath, known);
  }
  report.installations = {
    paths: [...installPaths.values()],
    duplicate: installPaths.size > 1,
  };

  if (!project) return report;

  if (sessionId) {
    report.cache.path = cachePath(project.root, sessionId);
    const snapshot = readCache(project.root, sessionId);
    report.cache.snapshot = snapshot;
    report.hooks.runs = snapshot?.hookRuns || {};
    report.hooks.everRan = Object.keys(report.hooks.runs).length > 0;
  }
  report.ompFailures = readRuntimeFailures(project.root);
  // Still-open sessions are read from their journals, finished ones from the
  // summary their shutdown froze — without both, the report shows counters
  // only for sessions that never cleaned up after themselves.
  const live = listSessions(project.root).map(({ sessionId: id, mtimeMs }) => ({
    sessionId: id,
    at: mtimeMs,
    metrics: deriveSession(project.root, id).metrics,
  }));
  const open = new Set(live.map((session) => session.sessionId));
  const ended = listSessionSummaries(project.root)
    .filter((session) => !open.has(session.sessionId))
    .map(({ sessionId: id, endedAt, metrics }) => ({ sessionId: id, at: endedAt, metrics }));
  // Merged by time, not by source: a handful of journals left behind by
  // crashed sessions would otherwise fill the report and hide every session
  // that ended properly.
  const recent = [...live, ...ended].sort((a, b) => b.at - a.at);
  report.sessionMetrics = recent.slice(0, 5).map(({ sessionId: id, metrics }) => ({ sessionId: id, metrics }));
  // The stand-in for the hook check on a host that has no hooks: session state
  // exists only because the extension wrote it.
  const newest = recent[0]?.at ?? 0;
  report.extension = { active: newest > 0, ageMs: newest > 0 ? Math.max(0, Date.now() - newest) : null };

  report.git = await gitHookState({
    repoRoot: project.root,
    pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))),
  });

  if (report.backlog.reachable) {
    const configured = await configList("statuses", { cwd: project.root });
    report.statuses = configured.ok
      ? { list: configured.list, hasInProgress: configured.list.includes(IN_PROGRESS) }
      : { error: configured.reason };
    const active = await resolveActiveTask({ cwd: project.root });
    report.active = describeActiveTask(active);

    /** @type {Record<string, { value: string | null, reason: string | null }>} */
    const config = {};
    for (const key of CONFIG_KEYS) {
      const r = await configValue(key, { cwd: project.root, timeoutMs: 8000 });
      config[key] = r.ok ? { value: r.value, reason: null } : { value: null, reason: r.reason };
    }
    const callback = statusChangeCallback(project.configPath);
    config.onStatusChange = { value: callback, reason: callback ? null : "unset" };
    report.config = config;
  }
  return report;
}

/**
 * One line per config interaction, each naming its consequence.
 *
 * `warn` rather than `FAIL`: every one of these is somebody's deliberate
 * setting, not a broken install. An unreadable value never escalates either —
 * it reports the default line and names the reason.
 *
 * @param {Record<string, { value: string | null, reason: string | null }>} config
 * @returns {string[]}
 */
function configLines(config) {
  const state = (key) => config[key] ?? { value: null, reason: "unread" };
  const describe = (s) => s.value ?? `not set (${s.reason})`;
  const lines = [];

  const autoCommit = state("autoCommit");
  lines.push(
    autoCommit.value === "true"
      ? "warn autoCommit: true — Backlog.md commits every task write itself, so the SessionEnd flush of modified files lands as a commit nobody reviewed, with a Task: trailer attached by prepare-commit-msg"
      : `ok   autoCommit: ${describe(autoCommit)} — task writes stay in the working tree for you to commit`,
  );

  const bypass = state("bypassGitHooks");
  lines.push(
    bypass.value === "true"
      ? "warn bypassGitHooks: true — Backlog.md commits with --no-verify, so the pre-commit tripwire never runs on a commit it makes and a corrupt task file can land unnoticed"
      : `ok   bypassGitHooks: ${describe(bypass)} — commits Backlog.md makes still run the pre-commit tripwire`,
  );

  const callback = state("onStatusChange");
  // Capped: the value is a command line out of the repository's config.
  const command = callback.value && callback.value.length > 80 ? `${callback.value.slice(0, 79)}…` : callback.value;
  lines.push(
    callback.value
      ? `warn onStatusChange: ${command} — an arbitrary shell command runs on every status change, including the one /backlog-md:start performs, so the latency and side effects of 'task edit -s' are not this plugin's to predict`
      : "ok   onStatusChange: not set — no shell callback runs on the status change /backlog-md:start performs",
  );

  const branches = state("checkActiveBranches");
  const remote = state("remoteOperations");
  lines.push(
    branches.value === "true" && remote.value === "true"
      ? "ok   checkActiveBranches: true with remoteOperations: true — the defaults; 'task list' may reach the remote, which on a large repository can outlast the hooks' 3s budget and degrade the brief to unavailable"
      : `ok   checkActiveBranches: ${describe(branches)} with remoteOperations: ${describe(remote)} — no remote read is added to 'task list'`,
  );

  return lines;
}

/** Coarse age for one report line: seconds, then minutes, then hours. */
function age(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

export function formatDoctor(r) {
  const lines = ["backlog-md-cc diagnosis", ""];
  const mark = (ok) => (ok ? "ok  " : "FAIL");

  lines.push(`${mark(true)} node ${r.node.version} (${r.node.execPath})`);
  lines.push(
    r.workerNode.reachable && r.workerNode.supported
      ? `${mark(true)} worker node ${r.workerNode.version} via ${r.workerNode.command}`
      : r.workerNode.reachable
        ? `${mark(false)} worker node ${r.workerNode.version} via ${r.workerNode.command} — Node 18 or newer is required`
        : `${mark(false)} worker node '${r.workerNode.command}' not reachable (${r.workerNode.reason}) — set BACKLOG_MD_NODE to a Node 18+ executable reachable by OMP and git hooks`,
  );
  lines.push(
    r.guard.enabled
      ? `${mark(true)} guard enabled — hand-edits of Backlog.md files are denied`
      : `${mark(true)} guard disabled (BACKLOG_MD_GUARD=0) — hand-edits are warned about, not blocked`,
  );
  lines.push(
    r.backlog.reachable
      ? `${mark(true)} backlog ${r.backlog.version}`
      : `${mark(false)} backlog not reachable (${r.backlog.reason}) — the plugin is a no-op without it`,
  );
  lines.push(
    r.project.found
      ? `${mark(true)} project ${r.project.root} (backlog dir: ${r.project.backlogDir})`
      : `${mark(false)} no Backlog.md project found from here — run 'backlog init' first`,
  );

  const installs = r.installations?.paths ?? [];
  const gone = (install) =>
    install.present === false ? " — registered but the directory is gone; reinstall with --force" : "";
  if (r.installations?.duplicate) {
    lines.push(
      `${mark(false)} Backlog.md is active from ${installs.length} distinct plugin paths — use the same marketplace name in Claude Code and OMP so OMP can replace Claude's matching plugin id`,
    );
    for (const install of installs) {
      lines.push(
        `${mark(false)} ${install.sources.join(", ")}: ${install.installPath} (version ${install.versions.join(", ")})${gone(install)}`,
      );
    }
  } else if (installs.length === 1) {
    const install = installs[0];
    lines.push(
      `${mark(install.present !== false)} Backlog.md plugin ${install.installPath} (version ${install.versions.join(", ")}) via ${install.sources.join(", ")}${gone(install)}`,
    );
  }
  if (r.statuses) {
    lines.push(
      r.statuses.error
        ? `${mark(false)} statuses unreadable (${r.statuses.error})`
        : `${mark(r.statuses.hasInProgress)} statuses [${r.statuses.list.join(", ")}]${
            r.statuses.hasInProgress ? "" : " — no 'In Progress' column, so status resolution is disabled"
          }`,
    );
  }

  if (r.active) {
    const detail =
      r.active.state === "ambiguous"
        ? ` candidates: ${r.active.candidates.map((c) => c.id).join(", ")}`
        : r.active.taskId
          ? ` ${r.active.taskId} via ${r.active.source}`
          : r.active.reason
            ? ` (${r.active.reason})`
            : "";
    lines.push(`${mark(r.active.state !== "unavailable")} active task: ${r.active.state}${detail}`);
  }

  if (r.cache.path) lines.push(`${mark(true)} cache ${r.cache.path}`);
  for (const failure of r.ompFailures ?? []) {
    const operation = String(failure.operation).replace(/^OMP\s+/, "");
    const scope = failure.scope ? ` [session ${failure.scope}]` : "";
    lines.push(`${mark(false)} OMP ${operation}${scope} failed at ${failure.at}: ${failure.message}`);
  }

  if (r.project.found) {
    const sessions = r.sessionMetrics ?? [];
    const label = sessions.length === 1 ? "session" : "sessions";
    lines.push(`${mark(true)} recent behavior counters (last ${sessions.length} ${label}):`);
    for (const { sessionId, metrics } of sessions) {
      const toolCalls = Object.entries(metrics.toolCalls)
        .map(([name, count]) => `${name} ×${count}`)
        .join(", ");
      lines.push(
        `  ${sessionId}: guards ${metrics.guards}; tool calls ${toolCalls || "none"}; acceptance checks ${
          metrics.acceptanceChecks
        }; unplanned starts ${metrics.unplannedStarts}; unfinished sessions ${metrics.unfinishedSessions}; steering messages ${
          metrics.steeringMessages
        }; taskless continuations ${metrics.tasklessContinues ?? 0}`,
      );
    }
  }

  if (r.config) lines.push(...configLines(r.config));

  if (r.git) {
    const ours = r.git.hooks.filter((h) => h.ours);
    const foreign = r.git.hooks.filter((h) => h.installed && !h.ours);
    if (ours.length === 0) {
      lines.push(`${mark(true)} git hooks not installed — optional; '/backlog-md:setup' offers them`);
    } else if (!r.git.resolvedRoot) {
      lines.push(
        `${mark(false)} git hooks installed but they resolve to no plugin, so they do nothing — re-run '/backlog-md:setup'`,
      );
    } else if (!r.git.resolvesHere) {
      lines.push(
        `${mark(true)} git hooks installed: ${ours.map((h) => h.name).join(", ")} — they run ${r.git.resolvedRoot}, not this copy of the plugin`,
      );
    } else {
      lines.push(`${mark(true)} git hooks installed: ${ours.map((h) => h.name).join(", ")}`);
    }
    if (foreign.length > 0) {
      lines.push(`${mark(true)} not ours, left alone: ${foreign.map((h) => h.name).join(", ")}`);
    }
    if (r.git.stranded?.length > 0) {
      lines.push(
        `${mark(false)} our hooks sit in .git/hooks (${r.git.stranded.join(", ")}) but git runs hooks from ${r.git.hooksPath} — they never run; delete them, or chain them from the hooks that do run`,
      );
    }
  }

  // Hook executions are separate processes. Their cache record proves they
  // ran; its absence does not identify a cause, so keep it distinct from the
  // worker-node probe above. Only Claude Code runs them at all: elsewhere the
  // in-process extension is what has to have run, and session state is the
  // proof of that (BCC-2).
  if (r.project.found) {
    if (r.hooks.host === "extension") {
      lines.push(
        r.extension.active
          ? `${mark(true)} extension active — newest session state ${age(r.extension.ageMs)} old`
          : `${mark(false)} no session state recorded — the extension has not run in this repository`,
      );
    } else {
      lines.push(
        r.hooks.everRan
          ? `${mark(true)} hooks have run: ${Object.entries(r.hooks.runs)
              .map(([k, v]) => `${k} at ${v}`)
              .join(", ")}`
          : `${mark(false)} no hook has recorded a run for this session — after a fresh session, inspect host hook configuration and the worker-node result above`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * The Backlog.md CLI's own commands. Agents that meet this wrapper in a command
 * template read it as "the way to call Backlog.md here" and address it with
 * `task list` or `instructions overview` (BCC-2, measured). The bare usage line
 * never named the CLI that does own those, so the guess was repeated.
 */
const BACKLOG_CLI_COMMANDS = new Set([
  "task",
  "draft",
  "doc",
  "decision",
  "milestone",
  "search",
  "board",
  "instructions",
  "overview",
  "sequence",
  "cleanup",
  "config",
  "browser",
  "init",
  "agents",
]);

/** Single-quote what a shell would otherwise reinterpret, so the hint is runnable as printed. */
function shellArg(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** `""` unless the args name a Backlog.md command, in which case the command to run instead. */
export function backlogCliHint(args) {
  if (!BACKLOG_CLI_COMMANDS.has(args[0])) return "";
  return (
    `\nbacklog-cc is the backlog-md plugin's own helper, not the Backlog.md CLI.\n` +
    `Run this instead:\n  backlog ${args.map(shellArg).join(" ")}\n`
  );
}

async function main() {
  const [command = "doctor", argument] = process.argv.slice(2);

  if (command === "doctor") {
    process.stdout.write(formatDoctor(await collectDoctor({ sessionId: process.env.CLAUDE_CODE_SESSION_ID })) + "\n");
    return;
  }

  if (command === "setup") {
    const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const cli = join(pluginRoot, "scripts", "backlog-cc.mjs");
    const workerNode = JSON.stringify(workerNodeExecutable());
    const quotedCli = JSON.stringify(cli);
    process.stdout.write(formatDoctor(await collectDoctor({ sessionId: process.env.CLAUDE_CODE_SESSION_ID })) + "\n\n");
    process.stdout.write(
      "Git hooks — optional, local to this clone, nothing changes for teammates:\n" +
        `  ${workerNode} ${quotedCli} install-hooks\n` +
        `  ${workerNode} ${quotedCli} install-hooks --shared   # writes .githooks/ and sets core.hooksPath\n`,
    );
    return;
  }

  if (command === "active") {
    const project = findProject(process.cwd());
    if (!project) {
      process.stdout.write(JSON.stringify({ state: "unavailable", reason: "no-project" }) + "\n");
      return;
    }
    const active = await resolveActiveTask({ cwd: project.root });
    process.stdout.write(JSON.stringify(describeActiveTask(active)) + "\n");
    return;
  }

  if (command === "active-id") {
    const project = findProject(process.cwd());
    if (!project) return;
    const active = await resolveActiveTask({ cwd: project.root });
    // Only a positively resolved task earns a trailer — fail closed.
    if ((active.state === "branch" || active.state === "status") && active.task?.id) {
      process.stdout.write(active.task.id + "\n");
    }
    return;
  }

  if (command === "install-hooks") {
    const args = process.argv.slice(3);
    const shared = args.includes("--shared");
    const result = await installHooks({ shared, force: args.includes("--force") });
    if (result.reason === "not-a-git-repository") {
      process.stdout.write("not a git repository — nothing installed\n");
      return;
    }
    for (const b of result.backedUp) process.stdout.write(`kept      ${b.backup} (the hook that was there)\n`);
    for (const path of result.written) process.stdout.write(`installed ${path}\n`);
    for (const s of result.skipped) process.stdout.write(`skipped   ${s.path} — ${s.reason}\n`);
    // Naming the casualties, because "--shared sets core.hooksPath" does not
    // read as "and every hook the old value pointed at stops running".
    if (shared && result.configured && result.hooksPath) {
      const others = existsSync(result.hooksPath)
        ? readdirSync(result.hooksPath).filter((n) => !n.endsWith(".sample") && !isOurHook(join(result.hooksPath, n)))
        : [];
      const verb = result.written.length > 0 ? "no longer runs" : "would stop running";
      process.stdout.write(
        `warning   core.hooksPath is '${result.configured}'; git ${verb} the ${others.length} hook(s) there` +
          `${others.length > 0 ? `: ${others.join(", ")}` : ""}\n`,
      );
    }
    if (result.written.length > 0) {
      // Local to this clone and never committed, so it can name this machine's
      // path: it is the one answer a hook does not have to search for, and the
      // place to point a hook at a development checkout (BCC-14).
      const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
      await run("git", ["config", "backlog-md.pluginRoot", pluginRoot], { cwd: process.cwd() });
    }
    if (shared && result.written.length > 0) {
      await run("git", ["config", "core.hooksPath", ".githooks"], { cwd: process.cwd() });
      process.stdout.write("set core.hooksPath=.githooks\n");
      process.stdout.write(
        "note: the committed hooks carry no machine-specific path — a teammate needs the\n" +
          "plugin installed, not a second run of this installer\n",
      );
    }
    return;
  }

  if (command === "check-staged") {
    const result = await checkStaged();
    // Printed whether or not anything was found: a check that quietly stopped
    // halfway reads exactly like a check that found nothing.
    if (result.skipped > 0) {
      process.stderr.write(
        `backlog-md: stopped after ${STAGED_BUDGET_MS / 1000}s — ${result.skipped} staged task file(s) not checked\n`,
      );
    }
    if (result.ok) return;
    process.stderr.write("backlog-md: staged task files the CLI can no longer read:\n");
    for (const b of result.broken) {
      process.stderr.write(`  ${b.path} (${b.taskId}) — ${b.message}\n`);
    }
    process.stderr.write(
      "\nThis is usually a hand-edit that broke the frontmatter. Restore it with 'git checkout -- <path>'\n" +
        "and make the change through 'backlog task edit' instead. To commit anyway: git commit --no-verify\n",
    );
    process.exitCode = 1;
    return;
  }

  if (command === "sweep") {
    // Spawned detached by the SessionStart hook, so nothing reads this output;
    // it is here for running the recovery by hand.
    const project = findProject(process.cwd());
    if (!project) return;
    const result = await sweepAbandoned({
      repoRoot: project.root,
      sessionId: argument,
      includeSelf: process.argv.includes("--include-self"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "flush") {
    // Spawned detached by the SessionEnd hook, so nothing reads this output;
    // it is here for running the flush by hand.
    const project = findProject(process.cwd());
    if (!project) return;
    const result = await flushSession({ repoRoot: project.root, sessionId: argument });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "check-tasks") {
    const result = await checkTasks();
    process.stdout.write(`checked ${result.checked.length} task file(s)\n`);
    if (result.ok) return;
    process.stderr.write("backlog-md: task files the CLI cannot read:\n");
    for (const b of result.broken) {
      process.stderr.write(`  ${b.path} (${b.taskId}) — ${b.message}\n`);
    }
    process.stderr.write(
      "\nA task file that the CLI cannot read is broken for every tool that reads it.\n" +
        "Repair the frontmatter, or restore the file and redo the change through 'backlog task edit'.\n",
    );
    process.exitCode = 1;
    return;
  }

  if (command === "brief") {
    const project = findProject(process.cwd());
    if (!project) return;
    if (argument) {
      const view = await taskView(argument, { cwd: project.root });
      if (view.ok) process.stdout.write(renderBrief(view.task) + "\n");
      return;
    }
    const active = await resolveActiveTask({ cwd: project.root });
    if ("task" in active) process.stdout.write(renderBrief(active.task) + "\n");
    return;
  }

  if (command === "next") {
    const project = findProject(process.cwd());
    if (!project) return;
    const result = await findNext({ cwd: project.root, limit: Number(argument) || 3 });
    if (!result.ok) return;
    process.stdout.write(renderNext(result.tasks, { status: result.status }) + "\n");
    return;
  }

  // The hint comes last on purpose. A host that shows only the tail of a long
  // output — eleven of these from one loop is 84 lines — hid it behind the
  // usage line, leaving the model with the one line that names no way forward
  // (BCC-5).
  process.stderr.write(
    `unknown command: ${command}\nusage: backlog-cc [doctor|setup|active|active-id|brief [id]|next [limit]|install-hooks [--shared] [--force]|check-staged|check-tasks|sweep <session-id> [--include-self]|flush <session-id>]\n${backlogCliHint(process.argv.slice(2))}`,
  );
}

// Only run as a program, not when imported by tests. Compared as real paths:
// Node realpath-resolves import.meta.url for the main module, so a symlink
// anywhere in the invocation path would otherwise silently skip main().
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // The same record guard() writes for a hook, plus one line on stderr:
  // `install-hooks` inside a worktree threw ENOTDIR and exited 0 in silence
  // (BCC-50). The sh hooks are unaffected — `active-id` discards stderr, and
  // `check-staged` blocks only on its own marker line.
  main().catch((error) => {
    process.stderr.write(`backlog-cc ${process.argv[2] ?? ""}: ${String(error?.message ?? error)}\n`);
    debugLog({
      hook: "backlog-cc",
      event: process.argv[2] ?? null,
      ok: false,
      message: String(error?.message ?? error),
      stack: error?.stack ?? null,
    });
  });
}
