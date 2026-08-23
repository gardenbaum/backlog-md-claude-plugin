import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ROOT_CONFIG = "backlog.config.yml";
const BUILTIN_DIRS = ["backlog", ".backlog"];

/**
 * Walk up from `startDir` looking for a Backlog.md project.
 *
 * Two shapes are recognised, matching Backlog.md's own discovery: a root
 * `backlog.config.yml` (which may redirect the folder via `backlog_directory`),
 * or a folder-local `backlog/config.yml` / `.backlog/config.yml`.
 */
export function findProject(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const rootConfig = join(dir, ROOT_CONFIG);
    if (existsSync(rootConfig)) {
      const custom = readBacklogDirectory(rootConfig);
      const candidates = custom ? [custom, ...BUILTIN_DIRS] : BUILTIN_DIRS;
      for (const candidate of candidates) {
        const backlogDir = join(dir, candidate);
        if (existsSync(backlogDir)) {
          return {
            root: dir,
            backlogDir,
            configPath: rootConfig,
            caseInsensitive: isCaseInsensitive(rootConfig),
          };
        }
      }
    }
    for (const candidate of BUILTIN_DIRS) {
      const configPath = join(dir, candidate, "config.yml");
      if (existsSync(configPath)) {
        return {
          root: dir,
          backlogDir: join(dir, candidate),
          configPath,
          caseInsensitive: isCaseInsensitive(configPath),
        };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Extract the `backlog_directory` scalar from a root config file.
 *
 * NOT YAML parsing: exactly one shape is recognised — a top-level key with a
 * single-line scalar — and anything else yields null rather than a guess.
 * Absolute paths and `..` segments are ignored, mirroring Backlog.md's own
 * lexical check.
 */
export function readBacklogDirectory(configPath) {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  const match = text.match(/^backlog_directory:[ \t]*(.+?)[ \t]*$/m);
  if (!match) return null;

  const value = match[1]
    .replace(/[ \t]+#.*$/, "")
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();

  if (!value || value.startsWith("#")) return null;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return null;
  if (value.split(/[\\/]/).includes("..")) return null;
  return value;
}

/**
 * Does this filesystem treat paths case-insensitively?
 *
 * Probed, because guessing wrong is expensive both ways: folding on a
 * case-sensitive filesystem would deny a source directory genuinely named
 * BACKLOG, and not folding on macOS lets a real hand-edit through.
 * `realpathSync` cannot answer it — it preserves the casing it is given.
 * Anything other than a positive detection leaves comparison case-sensitive.
 */
function isCaseInsensitive(existingPath) {
  try {
    const flipped = join(dirname(existingPath), flipCase(basename(existingPath)));
    return flipped !== existingPath && existsSync(flipped);
  } catch {
    return false;
  }
}

function flipCase(segment) {
  const upper = segment.toUpperCase();
  return upper === segment ? segment.toLowerCase() : upper;
}

const MANAGED_DIRECTORIES = {
  tasks: "task",
  drafts: "draft",
  completed: "completed",
  archive: "archive",
  milestones: "milestone",
  docs: "doc",
  decisions: "decision",
};

const ID_PATTERN = /^([A-Za-z]+-\d+(?:\.\d+)*)/;

const UNMANAGED = { managed: false, kind: null, taskId: null };

/**
 * Decide whether a path belongs to Backlog.md, and what kind of thing it is.
 *
 * Fails open by design: this gates the plugin's only `deny`, so anything not
 * positively identified — an unknown subdirectory included — comes back
 * unmanaged rather than blocked on suspicion. A relative path is resolved
 * against the project root; hook payloads may carry either.
 */
export function classifyBacklogPath(targetPath, project) {
  if (!project || !targetPath) return UNMANAGED;

  const absolute = isAbsolute(targetPath) ? resolve(targetPath) : resolve(project.root, targetPath);
  // One folding rule for every comparison below. The original casing is never
  // lost — only the comparison copies are folded.
  const fold = project.caseInsensitive ? (s) => s.toLowerCase() : (s) => s;

  if (fold(absolute) === fold(join(project.root, ROOT_CONFIG))) {
    return { managed: true, kind: "config", taskId: null };
  }

  const withinBacklog = relative(fold(project.backlogDir), fold(absolute));
  if (!withinBacklog || withinBacklog.startsWith("..") || isAbsolute(withinBacklog)) {
    return UNMANAGED;
  }

  const segments = withinBacklog.split(sep);
  if (segments.length === 1) {
    return segments[0] === "config.yml" ? { managed: true, kind: "config", taskId: null } : UNMANAGED;
  }

  const kind = MANAGED_DIRECTORIES[segments[0]];
  if (!kind) return UNMANAGED;

  // The id comes from the original path, not the folded comparison copy, so
  // BACK-12 does not come back as back-12.
  const match = basename(absolute).match(ID_PATTERN);
  return { managed: true, kind, taskId: match ? match[1] : null };
}
