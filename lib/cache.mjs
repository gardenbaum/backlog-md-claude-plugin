import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
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
const SUMMARY_SUFFIX = ".metrics";
const SESSION_SUMMARY_LIMIT = 20;
const RUNTIME_FAILURE_LIMIT = 16;
const RUNTIME_FAILURE_LOCK_TIMEOUT_MS = 40;
const RUNTIME_FAILURE_LOCK_STALE_MS = 30_000;
const RUNTIME_FAILURE_LOCK_RETRY_MS = 10;
const RUNTIME_FAILURE_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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

/** Unresolved OMP adapter failures, kept outside session-shaped cache files. */
export function runtimeHealthPath(repoRoot) {
  return join(cacheDir(repoRoot), "health", "omp.json");
}

export function readRuntimeFailures(repoRoot) {
  try {
    const parsed = JSON.parse(readFileSync(runtimeHealthPath(repoRoot), "utf8"));
    return Array.isArray(parsed.failures) ? parsed.failures.slice(-RUNTIME_FAILURE_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeRuntimeFailures(repoRoot, failures) {
  const target = runtimeHealthPath(repoRoot);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = `${target}.${process.pid}.tmp`;
  writeFileSync(staging, JSON.stringify({ version: 1, failures: failures.slice(-RUNTIME_FAILURE_LIMIT) }));
  renameSync(staging, target);
}

function runtimeHealthLockPath(repoRoot) {
  return `${runtimeHealthPath(repoRoot)}.lock`;
}

function acquireRuntimeHealthLock(repoRoot) {
  const lockPath = runtimeHealthLockPath(repoRoot);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + RUNTIME_FAILURE_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return { fd: openSync(lockPath, "wx", 0o600), lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > RUNTIME_FAILURE_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError?.code !== "ENOENT") throw lockError;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out acquiring runtime health lock");
      Atomics.wait(RUNTIME_FAILURE_LOCK_WAIT, 0, 0, Math.min(RUNTIME_FAILURE_LOCK_RETRY_MS, remaining));
    }
  }
}

/**
 * Serialize a health mutation across OMP sessions. The state is re-read while
 * the lock is held, so a separately hydrated session cannot overwrite records
 * it has not seen.
 */
function mutateRuntimeFailures(repoRoot, mutate) {
  const lock = acquireRuntimeHealthLock(repoRoot);
  try {
    const current = readRuntimeFailures(repoRoot);
    const next = mutate(current);
    if (!next) return { changed: false, failures: current };
    const failures = next.slice(-RUNTIME_FAILURE_LIMIT);
    if (failures.length === 0) rmSync(runtimeHealthPath(repoRoot), { force: true });
    else writeRuntimeFailures(repoRoot, failures);
    return { changed: true, failures };
  } finally {
    try {
      closeSync(lock.fd);
    } finally {
      rmSync(lock.lockPath, { force: true });
    }
  }
}

/**
 * Keep one bounded runtime-health snapshot in memory. Adapter event handlers
 * call this state object so successful tool events do not synchronously reopen
 * the health file; mutations acquire a short-lived cross-session lock only
 * when an unresolved failure must be written or cleared.
 */
export function createRuntimeFailureState(repoRoot, initialFailures = readRuntimeFailures(repoRoot)) {
  let current = Array.isArray(initialFailures) ? initialFailures.slice(-RUNTIME_FAILURE_LIMIT) : [];

  return {
    record(operation, error, startedAt = Date.now(), scope = "") {
      try {
        const failure = {
          operation: String(operation).slice(0, 100),
          scope: String(scope).slice(0, 100),
          message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          startedAt,
          at: new Date().toISOString(),
        };
        const result = mutateRuntimeFailures(repoRoot, (stored) => {
          const next = stored.filter(
            (entry) => entry.operation !== failure.operation || String(entry.scope ?? "") !== failure.scope,
          );
          next.push(failure);
          return next;
        });
        current = result.failures;
        return result.changed;
      } catch {
        return false;
      }
    },

    clear(operation, startedAt = Date.now(), scope = "") {
      try {
        const matchingFailure = current.some(
          (entry) =>
            entry.operation === operation &&
            String(entry.scope ?? "") === String(scope) &&
            Number(entry.startedAt) <= Number(startedAt),
        );
        if (!matchingFailure) return false;
        const result = mutateRuntimeFailures(repoRoot, (stored) => {
          const next = stored.filter(
            (entry) =>
              entry.operation !== operation ||
              String(entry.scope ?? "") !== String(scope) ||
              Number(entry.startedAt) > Number(startedAt),
          );
          return next.length === stored.length ? null : next;
        });
        current = result.failures;
        return result.changed || matchingFailure;
      } catch {
        return false;
      }
    },
  };
}

/** Keep only the latest unresolved failure per operation and session. */
export function recordRuntimeFailure(repoRoot, operation, error, startedAt = Date.now(), scope = "") {
  return createRuntimeFailureState(repoRoot).record(operation, error, startedAt, scope);
}

/**
 * A newer successful attempt in the same session resolves an older failure;
 * an older async attempt completing late cannot erase a failure from work that
 * started after it.
 */
export function clearRuntimeFailure(repoRoot, operation, startedAt = Date.now(), scope = "") {
  return createRuntimeFailureState(repoRoot).clear(operation, startedAt, scope);
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
function writeAtomic(target, text) {
  const staging = `${target}.${process.pid}.tmp`;
  writeFileSync(staging, text);
  renameSync(staging, target);
  return target;
}

export function writeCache(repoRoot, sessionId, data) {
  mkdirSync(cacheDir(repoRoot), { recursive: true, mode: 0o700 });
  return writeAtomic(cachePath(repoRoot, sessionId), JSON.stringify(data));
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
 * Where a session's behavior counters outlive its journal.
 *
 * The journal is transient by design: `flushSession` removes it on every
 * terminal outcome, so the sessions whose counters vanish are exactly the ones
 * that ended cleanly — and `unfinished-session`, recorded immediately before
 * the same handler spawns the worker that deletes the journal, was never
 * observable at all. The summary is the durable half.
 *
 * The `.metrics` suffix keeps `listSessions` blind to these files: it accepts
 * only `.json` and `.jsonl`, so a summary can never be mistaken for live state
 * the sweep should collect and clear.
 */
export function summaryPath(repoRoot, sessionId) {
  return join(cacheDir(repoRoot), `${sessionKey(sessionId)}${SUMMARY_SUFFIX}`);
}

/**
 * Freeze this session's derived counters beside its journal.
 *
 * @returns {ReturnType<typeof deriveSession>["metrics"]} the stored counters
 */
export function writeSessionSummary(repoRoot, sessionId, now = Date.now()) {
  const { metrics } = deriveSession(repoRoot, sessionId);
  mkdirSync(cacheDir(repoRoot), { recursive: true, mode: 0o700 });
  writeAtomic(summaryPath(repoRoot, sessionId), JSON.stringify({ endedAt: now, metrics }));
  pruneSessionSummaries(repoRoot);
  return metrics;
}

/**
 * Every stored summary, newest first.
 *
 * @param {string} repoRoot
 * @returns {{ sessionId: string, endedAt: number, metrics: ReturnType<typeof deriveSession>["metrics"] }[]}
 */
export function listSessionSummaries(repoRoot) {
  const dir = cacheDir(repoRoot);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const summaries = [];
  for (const entry of entries) {
    if (!entry.endsWith(SUMMARY_SUFFIX)) continue;
    try {
      const stored = JSON.parse(readFileSync(join(dir, entry), "utf8"));
      if (!stored?.metrics) continue;
      summaries.push({
        sessionId: entry.slice(0, -SUMMARY_SUFFIX.length),
        endedAt: Number(stored.endedAt) || 0,
        metrics: stored.metrics,
      });
    } catch {
      // a torn or hand-edited summary is diagnostics, not state: skip it
    }
  }
  return summaries.sort((a, b) => b.endedAt - a.endedAt);
}

/**
 * Keep the newest few and drop the rest.
 *
 * Removing the journal is what bounds this directory; one surviving file per
 * session would put the growth straight back.
 */
function pruneSessionSummaries(repoRoot) {
  for (const { sessionId } of listSessionSummaries(repoRoot).slice(SESSION_SUMMARY_LIMIT)) {
    try {
      rmSync(join(cacheDir(repoRoot), `${sessionId}${SUMMARY_SUFFIX}`), { force: true });
    } catch {
      // already gone
    }
  }
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
 *   { t: "metric", name, tool? }            — native workflow behavior counter
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
  const metrics = {
    guards: 0,
    toolCalls: {},
    acceptanceChecks: 0,
    unplannedStarts: 0,
    unfinishedSessions: 0,
    steeringMessages: 0,
  };

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
    } else if (event.t === "metric") {
      if (event.name === "guard") metrics.guards += 1;
      else if (event.name === "tool" && typeof event.tool === "string") {
        metrics.toolCalls[event.tool] = (metrics.toolCalls[event.tool] ?? 0) + 1;
      } else if (event.name === "acceptance-check") metrics.acceptanceChecks += 1;
      else if (event.name === "unplanned-start") metrics.unplannedStarts += 1;
      else if (event.name === "unfinished-session") metrics.unfinishedSessions += 1;
      else if (event.name === "steering") metrics.steeringMessages += 1;
    }
  });

  // editsAtLastNotes: how many edits had happened by the time notes were last
  // written — 0 if notes were never written this session.
  const editsAtLastNotes = lastNotesIdx < 0 ? 0 : events.slice(0, lastNotesIdx).filter((e) => e.t === "edit").length;

  // stale: a mutation was observed after the last time identity was
  // re-derived (or one was observed and identity has never been re-derived).
  const stale = lastStaleIdx > lastIdentityIdx;

  return { sourceEdits, pendingModifiedFiles: pendingOrder, editsAtLastNotes, stale, taskId, metrics };
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
