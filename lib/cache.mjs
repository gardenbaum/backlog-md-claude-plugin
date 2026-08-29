import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const NAMESPACE = "backlog-md-cc";

function resolvedHome() {
  try {
    return homedir() || "";
  } catch {
    return "";
  }
}

/**
 * Base directory for per-user state: `$XDG_STATE_HOME`, else `~/.local/state`.
 *
 * `os.tmpdir()` is the last resort only: on a shared /tmp this path is fully
 * predictable from the repository root, which invites squatting and leaks
 * which files a session edited. Per-user state belongs under the user's own
 * home, at mode 0700. The parameters exist for the tests — the tmpdir branch
 * is unreachable through the environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {() => string} [home]
 */
export function stateBase(env = process.env, home = resolvedHome) {
  if (env.XDG_STATE_HOME) return env.XDG_STATE_HOME;
  const dir = home();
  return dir ? join(dir, ".local", "state") : tmpdir();
}

/**
 * Session state is keyed by the canonical repository root. On macOS, Node
 * canonicalizes a spawned child's cwd (`/var` becomes `/private/var`) even
 * when the parent passed the lexical path. Hashing the lexical spelling made
 * the detached shutdown child look in a different journal directory.
 */
export function cacheDir(repoRoot) {
  let identity = String(repoRoot);
  try {
    identity = realpathSync(identity);
  } catch {
    // The repository can disappear during shutdown; retain the lexical key.
  }
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return join(stateBase(), NAMESPACE, key);
}

/** Where swallowed errors and hook timings land when BACKLOG_MD_DEBUG is set. */
export function debugPath() {
  return join(stateBase(), NAMESPACE, "debug.jsonl");
}

/**
 * Append one debug record — or, with the knob unset, do nothing whatsoever.
 *
 * The trace for errors guard() swallows. Best-effort by construction: an
 * unwritable state directory must cost the hook nothing. One record per line,
 * so a crashed hook cannot corrupt earlier ones. Not per-session — guard() has
 * neither a repository root nor a session id.
 *
 * @param {Record<string, any>} entry
 * @returns {boolean} whether a line was written
 */
export function debugLog(entry) {
  const knob = process.env.BACKLOG_MD_DEBUG;
  if (!knob || knob === "0") return false;
  try {
    const target = debugPath();
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    return true;
  } catch {
    // A debug knob that can break a hook is worse than no knob at all.
    return false;
  }
}

export function cachePath(repoRoot, sessionId) {
  return join(cacheDir(repoRoot), `${sessionKey(sessionId)}.json`);
}

export function readCache(repoRoot, sessionId) {
  try {
    return JSON.parse(readFileSync(cachePath(repoRoot, sessionId), "utf8"));
  } catch {
    return null;
  }
}

/** Write via a temp file and rename, so a concurrent reader never sees a torn file. */
export function writeCache(repoRoot, sessionId, data) {
  const target = cachePath(repoRoot, sessionId);
  mkdirSync(cacheDir(repoRoot), { recursive: true, mode: 0o700 });
  const staging = `${target}.${process.pid}.tmp`;
  writeFileSync(staging, JSON.stringify(data));
  renameSync(staging, target);
  return target;
}

export function updateCache(repoRoot, sessionId, patch) {
  const merged = { ...(readCache(repoRoot, sessionId) || {}), ...patch };
  writeCache(repoRoot, sessionId, merged);
  return merged;
}

export function clearCache(repoRoot, sessionId) {
  clearSnapshot(repoRoot, sessionId);
  clearJournal(repoRoot, sessionId);
}

/**
 * Drop the snapshot but keep the journal. The two halves have different
 * lifetimes: the snapshot is spent the moment a session ends, the journal is
 * unflushed work that may only go once the flush landed (BCC-47).
 */
export function clearSnapshot(repoRoot, sessionId) {
  try {
    rmSync(cachePath(repoRoot, sessionId), { force: true });
  } catch {
    // nothing to remove
  }
}

/**
 * Drop the journal but keep the snapshot. For the live session: the journal it
 * inherited from a killed predecessor is spent once flushed, but its own
 * snapshot is not (BCC-18).
 */
export function clearJournal(repoRoot, sessionId) {
  try {
    rmSync(journalPath(repoRoot, sessionId), { force: true });
  } catch {
    // nothing to remove
  }
}

export function journalPath(repoRoot, sessionId) {
  return join(cacheDir(repoRoot), `${sessionKey(sessionId)}.jsonl`);
}

/**
 * Every session this repository has state for, newest write first.
 *
 * The id returned is the sanitised one the files are named with, so it can be
 * passed straight back in. `mtimeMs` is the newer of the snapshot and the
 * journal — how a caller tells an idle session from a dead one (BCC-16).
 *
 * @param {string} repoRoot
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
export function listSessions(repoRoot) {
  const dir = cacheDir(repoRoot);
  /** @type {Map<string, number>} */
  const seen = new Map();
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const id = entry.replace(/\.(json|jsonl)$/, "");
    if (id === entry) continue; // not one of ours
    try {
      const { mtimeMs } = statSync(join(dir, entry));
      seen.set(id, Math.max(seen.get(id) ?? 0, mtimeMs));
    } catch {
      // vanished between readdir and stat — nothing to report about it
    }
  }
  return [...seen].map(([sessionId, mtimeMs]) => ({ sessionId, mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Append one event to the session's journal.
 *
 * A read-modify-write of the snapshot loses updates under the parallel tool
 * calls Claude Code dispatches routinely (measured: 3-4 of 6 concurrent edits
 * landed). A single small `appendFileSync` is atomic on POSIX.
 */
export function appendEvent(repoRoot, sessionId, event) {
  mkdirSync(cacheDir(repoRoot), { recursive: true, mode: 0o700 });
  appendFileSync(journalPath(repoRoot, sessionId), `${JSON.stringify(event)}\n`);
}

/** Read the session's journal. A malformed line is skipped, never thrown. */
export function readJournal(repoRoot, sessionId) {
  let text;
  try {
    text = readFileSync(journalPath(repoRoot, sessionId), "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // one malformed line (e.g. a torn final write) must not discard the rest
    }
  }
  return events;
}

/**
 * Fold the journal into the derived fields the hooks used to store directly
 * in the session snapshot via a read-modify-write.
 *
 * Event shapes, one JSONL line each:
 *   { t: "edit", p: "<repo-relative path>" }  — a source-file edit
 *   { t: "notes" }                            — a `--append-notes|--notes` mutation
 *   { t: "stale" }                            — any other backlog mutation
 *   { t: "identity", id: "TASK-1" }           — UserPromptSubmit re-derived the active task
 *
 * Reads the whole journal every time and never rotates it, so the cost is
 * linear in the session's history. Measured: 0.55ms at 1_000 events, 5.4ms at
 * 10_000 — against a 4s hook budget where one backlog CLI call costs ~100ms.
 * No cap needed. If one is ever wanted, compact the edit events into a counter
 * plus the distinct paths.
 */
export function deriveSession(repoRoot, sessionId) {
  const events = readJournal(repoRoot, sessionId);

  let sourceEdits = 0;
  const pendingOrder = [];
  const pendingSeen = new Set();
  let lastNotesIdx = -1;
  let lastStaleIdx = -1;
  let lastIdentityIdx = -1;
  let taskId = null;

  events.forEach((event, i) => {
    if (event.t === "edit") {
      sourceEdits += 1;
      if (event.p && !pendingSeen.has(event.p)) {
        pendingSeen.add(event.p);
        pendingOrder.push(event.p);
      }
    } else if (event.t === "notes") {
      lastNotesIdx = i;
    } else if (event.t === "stale") {
      lastStaleIdx = i;
    } else if (event.t === "identity") {
      lastIdentityIdx = i;
      taskId = event.id ?? null;
    }
  });

  // editsAtLastNotes: how many edits had happened by the time notes were last
  // written — 0 if notes were never written this session.
  const editsAtLastNotes = lastNotesIdx < 0 ? 0 : events.slice(0, lastNotesIdx).filter((e) => e.t === "edit").length;

  // stale: a mutation was observed after the last time identity was
  // re-derived (or one was observed and identity has never been re-derived).
  const stale = lastStaleIdx > lastIdentityIdx;

  return { sourceEdits, pendingModifiedFiles: pendingOrder, editsAtLastNotes, stale, taskId };
}

/**
 * The file-name form of a session id — also what `listSessions` reports.
 * @param {string} [sessionId]
 */
export function sessionKey(sessionId) {
  return String(sessionId || "nosession")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 128);
}
