import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Where the installed git hooks look for this plugin, in order.
 *
 * The hooks used to carry one baked absolute path. A marketplace install path
 * contains the plugin version, so every update moved that directory and both
 * hooks silently stopped running (BCC-14). Resolving at run time removes the
 * failure mode instead of diagnosing it.
 *
 * The order: an explicit `git config` entry is somebody's decision, the baked
 * hint is the fast path, `CLAUDE_PLUGIN_ROOT` covers a hook invoked from
 * inside Claude Code, project and user OMP installs cover the native host, and
 * the Claude cache scan survives an update nobody announced.
 *
 * `git/pre-commit` and `git/prepare-commit-msg` each implement this same order
 * in POSIX sh — they cannot import this file, since resolving it is the very
 * thing they are doing, and neither may depend on a second file being present.
 * This module is the reference; keep the three in step.
 *
 * @param {{ configured?: string | null, hint?: string | null, env?: NodeJS.ProcessEnv, home?: string, cwd?: string }} [options]
 * @returns {string[]}
 */
export function pluginRootCandidates({ configured, hint, env = process.env, home, cwd } = {}) {
  const explicit = [configured, hint, env.CLAUDE_PLUGIN_ROOT].filter(
    /** @returns {value is string} */ (value) => Boolean(value) && value !== "@@PLUGIN_ROOT@@",
  );
  const resolvedHome = home ?? safeHome();
  return [...new Set([...explicit, ...ompInstalls(resolvedHome, env, cwd), ...cachedInstalls(resolvedHome)])];
}

function ompInstalls(home, env, cwd) {
  const candidates = projectInstalls(cwd);
  if (env.XDG_DATA_HOME) candidates.push(join(env.XDG_DATA_HOME, "omp", "plugins", "node_modules", "backlog-md"));
  if (home) {
    const configName = env.PI_CONFIG_DIR || ".omp";
    const configRoot = isAbsolute(configName) ? configName : join(home, configName);
    candidates.push(join(configRoot, "plugins", "node_modules", "backlog-md"));
  }
  return candidates;
}

function projectInstalls(cwd) {
  if (!cwd) return [];
  const candidates = [];
  let current = resolve(cwd);
  while (true) {
    candidates.push(join(current, ".omp", "plugins", "node_modules", "backlog-md"));
    const parent = dirname(current);
    if (parent === current) return candidates;
    current = parent;
  }
}

function nearestProjectRegistry(cwd) {
  if (!cwd) return null;
  let current = resolve(cwd);
  while (true) {
    const registry = join(current, ".omp", "plugins", "installed_plugins.json");
    if (existsSync(registry)) return registry;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function registryInstalls(path, source) {
  try {
    const plugins = JSON.parse(readFileSync(path, "utf8"))?.plugins;
    if (!plugins || typeof plugins !== "object") return [];
    return Object.entries(plugins).flatMap(([id, entries]) => {
      if (id.split("@", 1)[0] !== "backlog-md" || !Array.isArray(entries)) return [];
      return entries.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || entry.enabled === false || typeof entry.installPath !== "string") {
          return [];
        }
        return [{ installPath: entry.installPath, version: String(entry.version ?? "unknown"), source }];
      });
    });
  } catch {
    return [];
  }
}

/**
 * Active Backlog.md marketplace installs declared by Claude, OMP, and the
 * closest project registry. OMP ignores its duplicate of a Claude plugin only
 * when both registries identify the same marketplace plugin id.
 *
 * @param {{ home?: string, cwd?: string }} [options]
 */
export function activeBacklogInstallations({ home = safeHome(), cwd } = {}) {
  const registries = [];
  if (home) {
    registries.push({ path: join(home, ".claude", "plugins", "installed_plugins.json"), source: "Claude registry" });
    registries.push({ path: join(home, ".omp", "plugins", "installed_plugins.json"), source: "OMP registry" });
  }
  const projectRegistry = nearestProjectRegistry(cwd);
  if (projectRegistry) registries.push({ path: projectRegistry, source: "project registry" });
  return registries.flatMap(({ path, source }) => registryInstalls(path, source));
}

/**
 * Every marketplace-cached install, newest version first. An update leaves the
 * previous version directory in place, so the highest version has to win.
 * Ordered by name, not mtime: a directory copy rewrites mtimes.
 *
 * @param {string} home
 * @returns {string[]}
 */
function cachedInstalls(home) {
  if (!home) return [];
  const cache = join(home, ".claude", "plugins", "cache");
  /** @type {{ version: string, path: string }[]} */
  const found = [];
  for (const marketplace of listDir(cache)) {
    const plugin = join(cache, marketplace, "backlog-md");
    for (const version of listDir(plugin)) found.push({ version, path: join(plugin, version) });
  }
  return found.sort((a, b) => compareVersions(b.version, a.version)).map((entry) => entry.path);
}

/**
 * Compares two version directory names, positive when `a` is the newer one.
 *
 * Segment by segment as numbers, because a string sort puts `0.9.0` above
 * `0.10.0` (BCC-38). A non-numeric segment outranks any number: Claude Code
 * writes `unknown` when a marketplace carries no version, and that install is
 * the one a developer is running. Missing segments count as zero.
 * Both sh hooks repeat this comparison in awk; keep the three in step.
 *
 * @param {string} a @param {string} b @returns {number}
 */
function compareVersions(a, b) {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? "0";
    const y = right[i] ?? "0";
    if (x === y) continue;
    const numeric = /^\d+$/;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (!numeric.test(x) && !numeric.test(y)) return x < y ? -1 : 1;
    return numeric.test(x) ? -1 : 1;
  }
  return 0;
}

/** @param {string} dir @returns {string[]} */
function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function safeHome() {
  try {
    return homedir() || "";
  } catch {
    return "";
  }
}

/**
 * The first candidate that actually holds this plugin's entry point, or null.
 * Null is normal: the plugin can be uninstalled while its hooks remain, and
 * their contract is to do nothing rather than fail a commit.
 *
 * @param {Parameters<typeof pluginRootCandidates>[0]} [options]
 * @returns {string | null}
 */
export function resolvePluginRoot(options) {
  for (const candidate of pluginRootCandidates(options)) {
    if (existsSync(join(candidate, "scripts", "backlog-cc.mjs"))) return candidate;
  }
  return null;
}
