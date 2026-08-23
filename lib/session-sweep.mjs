import { resolveActiveTask } from "./active-task.mjs";
import { setModifiedFiles } from "./backlog.mjs";
import { clearCache, clearJournal, clearSnapshot, deriveSession, listSessions, sessionKey } from "./cache.mjs";

/**
 * Write one ending session's edited files onto the task, then discard its state.
 *
 * Runs in a detached child: Claude Code aborts a hook still running while it
 * shuts down, and the two CLI calls this needs (~450ms measured) do not fit in
 * that window (BCC-46).
 *
 * Fail closed, like the sweep: an unresolvable or ambiguous task writes
 * nothing. The snapshot goes either way — the session is over — but the
 * journal goes only on a terminal outcome: nothing pending, or the write
 * landed. A failed resolve or write is transient, and keeping the journal
 * hands the next sweep a second chance at no cost, because the flush writes
 * the union (BCC-47). Hence no `finally`: an unexpected throw is the strongest
 * reason to keep the journal, not to eat it.
 *
 * Accepted cost, shared with `sweepAbandoned`: in a repository where no task
 * is ever active, journals accumulate instead of being flushed and removed.
 *
 * @param {{ repoRoot: string, sessionId?: string }} options
 * @returns {Promise<{ files: string[], reason?: string }>}
 */
export async function flushSession({ repoRoot, sessionId }) {
  const pending = deriveSession(repoRoot, sessionId).pendingModifiedFiles;
  clearSnapshot(repoRoot, sessionId);

  if (pending.length === 0) {
    clearJournal(repoRoot, sessionId);
    return { files: [] };
  }

  const active = await resolveActiveTask({ cwd: repoRoot });
  if (active.state !== "branch" && active.state !== "status") return { files: [], reason: active.state };

  // resolveActiveTask already returns the full task for these two states,
  // so the existing list is in hand without a second CLI call.
  const union = [...new Set([...(active.task.modifiedFiles || []), ...pending])].sort();
  const written = await setModifiedFiles(active.task.id, union, { cwd: repoRoot });
  if (!written.ok) return { files: [], reason: written.reason };

  clearJournal(repoRoot, sessionId);
  return { files: pending };
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
 * One resolution and one write covers all of them: the union is what gets
 * written either way, and a session start cannot afford a CLI call per
 * abandoned journal.
 *
 * Fail closed, exactly as the flush does: an unresolvable or ambiguous task
 * writes nothing and deletes nothing, so the next session start can try again.
 * A journal is removed once its contents are on a task, or once it turns out
 * to hold nothing to flush.
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
  const discard = (id) => (id === self ? clearJournal(repoRoot, id) : clearCache(repoRoot, id));

  /** @type {{ sessionId: string, files: string[] }[]} */
  const carrying = [];
  /** @type {string[]} */
  const empty = [];
  for (const session of dead) {
    const files = deriveSession(repoRoot, session.sessionId).pendingModifiedFiles;
    if (files.length === 0) empty.push(session.sessionId);
    else carrying.push({ sessionId: session.sessionId, files });
  }

  // A dead session with nothing to flush is litter: clearing it needs no task
  // and can lose nothing.
  for (const id of empty) discard(id);
  if (carrying.length === 0) return { swept: empty, files: [] };

  const active = await resolveActiveTask({ cwd: repoRoot });
  if (active.state !== "branch" && active.state !== "status") {
    return { swept: empty, files: [], reason: active.state };
  }

  const files = [...new Set(carrying.flatMap((session) => session.files))];
  const union = [...new Set([...(active.task.modifiedFiles || []), ...files])].sort();
  const written = await setModifiedFiles(active.task.id, union, { cwd: repoRoot });
  if (!written.ok) return { swept: empty, files: [], reason: written.reason };

  for (const session of carrying) discard(session.sessionId);
  return { swept: [...empty, ...carrying.map((session) => session.sessionId)], files };
}
