import { existsSync } from "node:fs";
import { resolveActiveTask } from "./active-task.mjs";
import { setModifiedFiles, taskView } from "./backlog.mjs";
import {
  clearCache,
  clearJournal,
  clearSnapshot,
  deriveSession,
  journalPath,
  listSessions,
  sessionKey,
  writeSessionSummary,
} from "./cache.mjs";

/**
 * Write one ending session's edited files onto the task, then discard its state.
 *
 * Runs in a detached child: Claude Code aborts a hook still running while it
 * shuts down, and the two CLI calls this needs (~450ms measured) do not fit in
 * that window (BCC-46).
 *
 * Fail closed, like the sweep: an unresolvable or ambiguous task writes
 * nothing. The snapshot goes either way — the session is over — but the
 * journal goes only on a terminal outcome: nothing pending, the write landed,
 * or no task is active at all. `unavailable` and `ambiguous` are transient —
 * the CLI was unreachable, the column was crowded — and keeping the journal
 * hands the next sweep a second chance at no cost, because the flush writes
 * the union (BCC-47). Hence no `finally`: an unexpected throw is the strongest
 * reason to keep the journal, not to eat it.
 *
 * `none` has two readings, and the journal turns on which one it is. A session
 * that never had a task keeps it: BCC-47's second chance, for the resume that
 * starts one later. A session that *did* have a task and reached `none` by
 * finishing it has no second chance to wait for — no sweep will ever find that
 * task In Progress again — so its files go onto the task it worked on, by id
 * rather than by resolution, and the journal goes with them. Left as one case,
 * the session that followed the workflow to the end was the only one that
 * leaked its journal, permanently (BCC-7).
 *
 * Accepted cost: in a repository where no task is ever active, journals
 * accumulate instead of being flushed and removed.
 *
 * @param {{ repoRoot: string, sessionId?: string }} options
 * @returns {Promise<{ files: string[], reason?: string }>}
 */
export async function flushSession({ repoRoot, sessionId }) {
  const derived = deriveSession(repoRoot, sessionId);
  const pending = derived.pendingModifiedFiles;
  clearSnapshot(repoRoot, sessionId);

  if (pending.length === 0) {
    clearJournal(repoRoot, sessionId);
    return { files: [] };
  }

  const active = await resolveActiveTask({ cwd: repoRoot });
  if (active.state === "none" && derived.taskId) {
    const view = await taskView(derived.taskId, { cwd: repoRoot });
    if (!view.ok) return { files: [], reason: view.reason };
    const written = await write(derived.taskId, view.task.modifiedFiles, pending, repoRoot);
    if (!written.ok) return { files: [], reason: written.reason };
    clearJournal(repoRoot, sessionId);
    return { files: pending };
  }
  if (active.state !== "branch" && active.state !== "status") return { files: [], reason: active.state };

  // resolveActiveTask already returns the full task for these two states,
  // so the existing list is in hand without a second CLI call.
  const written = await write(active.task.id, active.task.modifiedFiles, pending, repoRoot);
  if (!written.ok) return { files: [], reason: written.reason };

  clearJournal(repoRoot, sessionId);
  return { files: pending };
}

/** The union, sorted: a flush adds to what the task already records, never replaces it. */
function write(taskId, recorded, pending, repoRoot) {
  return setModifiedFiles(taskId, [...new Set([...(recorded || []), ...pending])].sort(), { cwd: repoRoot });
}

/**
 * How long a session's state has to sit untouched before it counts as dead.
 *
 * A guess, and a cheap one to get wrong (BCC-18): sweeping a merely-idle
 * session cannot lose its pending files — the sweep writes them to the task
 * before removing the journal — it only restarts the derived edit counters.
 * Every hook run touches these files, so the mtime is a real heartbeat.
 */
export const ABANDONED_AFTER_MS = 30 * 60 * 1000;

/**
 * Whether a SessionStart of this kind may sweep its own session id.
 *
 * `startup` and `resume` mean a process is beginning, so anything filed under
 * that id was left by one that is gone. `clear` and `compact` are the same
 * process carrying on, still writing to that journal.
 *
 * @param {string} [source] the hook payload's `source`
 */
export function includesSelf(source) {
  return source === "startup" || source === "resume";
}

/**
 * Flush the edited-file lists of sessions that never ran SessionEnd — a crash,
 * a kill, or the interrupt Claude Code reports as a cancelled hook (BCC-16).
 *
 * One write per task the dead sessions were working on, not one per journal:
 * a session start cannot afford a CLI call per abandoned journal, and several
 * journals left behind by the same task cost one write between them.
 *
 * Fail closed, exactly as the flush does: an unresolvable or ambiguous task
 * writes nothing and deletes nothing, so the next session start can try again.
 * A journal is removed once its contents are on a task, or once it turns out
 * to hold nothing to flush. One task failing to resolve no longer holds up the
 * rest: `reason` reports the first failure and the sessions behind it keep
 * their journals, while the tasks that did resolve are written.
 *
 * `includeSelf` covers the resumed session (BCC-18): a resume keeps the id, so
 * a killed predecessor's journal sits under the live one and the age rule
 * would never reach it — but a SessionStart for an id that already has state
 * *is* the proof that the process holding it is gone.
 *
 * @param {{ repoRoot: string, sessionId?: string, now?: number, olderThanMs?: number, includeSelf?: boolean }} options
 * @returns {Promise<{ swept: string[], files: string[], reason?: string }>}
 */
export async function sweepAbandoned({
  repoRoot,
  sessionId,
  now = Date.now(),
  olderThanMs = ABANDONED_AFTER_MS,
  includeSelf = false,
}) {
  // listSessions reports the sanitised id the files are named with, which is
  // what this session's own id sanitises to — so comparing the two is enough
  // to tell the live session apart.
  const self = sessionKey(sessionId);
  const dead = listSessions(repoRoot).filter((s) =>
    s.sessionId === self ? includeSelf : now - s.mtimeMs > olderThanMs,
  );
  if (dead.length === 0) return { swept: [], files: [] };

  // The live session's snapshot was written by the SessionStart that called
  // this: only the inherited journal is spent, the snapshot is this session's.
  //
  // A dead session never reached the shutdown that freezes its counters, so
  // they are frozen here instead, one statement before the journal they are
  // derived from is removed — a crashed session is the one worth having
  // numbers for. `endedAt` is the session's last heartbeat rather than the
  // time this sweep happened to find it, which can be half an hour later. The
  // live id is left alone: it writes its own summary at shutdown, and one
  // written here would only be overwritten by it.
  const discard = (id, endedAt) => {
    if (id !== self && existsSync(journalPath(repoRoot, id))) writeSessionSummary(repoRoot, id, endedAt);
    return id === self ? clearJournal(repoRoot, id) : clearCache(repoRoot, id);
  };

  const lastTouched = new Map(dead.map((session) => [session.sessionId, session.mtimeMs]));

  /** @type {{ sessionId: string, files: string[], taskId: string | null }[]} */
  const carrying = [];
  /** @type {string[]} */
  const empty = [];
  for (const session of dead) {
    const derived = deriveSession(repoRoot, session.sessionId);
    if (derived.pendingModifiedFiles.length === 0) empty.push(session.sessionId);
    else
      carrying.push({
        sessionId: session.sessionId,
        files: derived.pendingModifiedFiles,
        taskId: derived.taskId,
      });
  }

  // A dead session with nothing to flush is litter: clearing it needs no task
  // and can lose nothing.
  for (const id of empty) discard(id, lastTouched.get(id));
  if (carrying.length === 0) return { swept: empty, files: [] };

  // Each session's files go to the task that session was working on, the way
  // `flushSession` has always resolved its own. The active task used to be the
  // only rule here, and it wrote a dead session's blog post onto EDG-4 — the
  // task that happened to be In Progress when the sweep ran, which had never
  // touched that file (BCC-12). A session that never named a task has nothing
  // else to go on and still falls back to it.
  /** @type {Map<string, typeof carrying>} */
  const byTask = new Map();
  /** @type {typeof carrying} */
  const homeless = [];
  for (const session of carrying) {
    if (!session.taskId) homeless.push(session);
    else byTask.set(session.taskId, [...(byTask.get(session.taskId) ?? []), session]);
  }

  // What a task already records, where it came free with the resolution.
  /** @type {Map<string, string[]>} */
  const recorded = new Map();
  /** @type {string | undefined} */
  let reason;
  if (homeless.length > 0) {
    const active = await resolveActiveTask({ cwd: repoRoot });
    if (active.state === "branch" || active.state === "status") {
      byTask.set(active.task.id, [...(byTask.get(active.task.id) ?? []), ...homeless]);
      recorded.set(active.task.id, active.task.modifiedFiles || []);
    } else reason = active.state;
  }

  /** @type {string[]} */
  const flushed = [];
  /** @type {string[]} */
  const files = [];
  for (const [taskId, sessions] of byTask) {
    let existing = recorded.get(taskId);
    if (existing === undefined) {
      const view = await taskView(taskId, { cwd: repoRoot });
      if (!view.ok) {
        reason ??= view.reason;
        continue;
      }
      existing = view.task.modifiedFiles;
    }
    const pending = [...new Set(sessions.flatMap((session) => session.files))];
    const written = await write(taskId, existing, pending, repoRoot);
    if (!written.ok) {
      reason ??= written.reason;
      continue;
    }
    files.push(...pending);
    for (const session of sessions) {
      discard(session.sessionId, lastTouched.get(session.sessionId));
      flushed.push(session.sessionId);
    }
  }

  const swept = [...empty, ...flushed];
  return reason ? { swept, files: [...new Set(files)], reason } : { swept, files: [...new Set(files)] };
}
