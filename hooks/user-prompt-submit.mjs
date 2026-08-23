#!/usr/bin/env node
import { readHookInput, emitAdditionalContext, guard } from "../lib/protocol.mjs";
import { findProject } from "../lib/paths.mjs";
import { taskIdCandidates, resolveActiveTask } from "../lib/active-task.mjs";
import { taskView } from "../lib/backlog.mjs";
import { readCache, updateCache, deriveSession, appendEvent } from "../lib/cache.mjs";
import { observe, looksLikeBuildIntent } from "../lib/observations.mjs";
import { renderForeignTask, renderObservations, renderIntentNudge } from "../lib/render.mjs";

const CANDIDATE_LOOKUP_LIMIT = 3;

// A candidate lookup is a guess — most prompt text that looks like a task id
// is not one — and a backlog CLI call costs ~100ms at best. Three sequential
// misses at the 3s default measured 527ms and scale badly on a slow
// repository, while missing a foreign-task brief costs nothing.
const CANDIDATE_TIMEOUT_MS = 1000;

// Roughly a second of margin under guard()'s 5s hard exit, so the final
// journal write and emitAdditionalContext still run. Degrading to a smaller
// injection is visible; the watchdog discarding everything is not.
const HOOK_BUDGET_MS = 4000;

// Never blocks, never decides. Turning the human's own prompt away would be
// overreach, so this hook only ever adds context.
guard(
  async () => {
    const input = await readHookInput();
    const project = findProject(input.cwd || process.cwd());
    if (!project) return;

    const startedAt = Date.now();
    const overBudget = () => Date.now() - startedAt > HOOK_BUDGET_MS;

    const sessionId = input.session_id;
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const options = { cwd: project.root };
    const snapshot = readCache(project.root, sessionId) || {};
    // sourceEdits, stale and taskId live in the append-only journal, not the
    // snapshot: a read-modify-write there loses concurrent PostToolUse writes.
    const derived = deriveSession(project.root, sessionId);
    const cachedTaskId = snapshot.taskId ? String(snapshot.taskId) : null;
    const edits = derived.sourceEdits ?? 0;
    const blocks = [];

    // Resolve identity once, before anything below consumes it. Steps 1-3
    // used to read a value the re-derivation had already replaced, so one
    // injection could call the active task foreign, report observations about
    // it, and tell the agent to start something else. `derived.taskId` is the
    // freshest thing on record, falling back to SessionStart's snapshot.
    let activeId = derived.taskId ?? cachedTaskId;
    let task = null;
    let identityEvent = null;
    // What resolution actually answered, kept rather than discarded (BCC-48).
    // `null` means the question was never asked this turn. Step 3 needs the
    // difference: "no id" is not the same claim as "no task".
    /** @type {import("../lib/types.mjs").ActiveTaskState["state"] | null} */
    let resolvedState = null;

    // The only unconditional CLI cost on this path, so it stays tightly
    // gated: source edits mean something may have changed, and no cached id at
    // all means step 3 needs a real answer on a session's first prompt.
    if (!overBudget() && (edits > 0 || !cachedTaskId)) {
      if (derived.stale || !cachedTaskId) {
        const resolved = await resolveActiveTask(options);
        resolvedState = resolved.state;
        const found = resolved.state === "branch" || resolved.state === "status" ? resolved.task : null;
        // Only a resolution that carried a task counts as a re-derivation:
        // "unavailable", "none" and "ambiguous" neither confirm nor deny the
        // cached id. Appending `identity` is what clears `stale`, so only a
        // successful re-derivation may append one.
        if (found) {
          task = found;
          activeId = found.id;
          identityEvent = { t: "identity", id: found.id };
        }
      } else {
        // Not stale and a cached id exists: trust it for identity, but still
        // refresh the task facts observations need (title, criteria, notes).
        const view = await taskView(cachedTaskId, options);
        if (view.ok) {
          task = view.task;
          // `activeId` must name the task these observations are about.
          // `derived.taskId` can differ from `cachedTaskId` after a checkout
          // onto another task's branch, which appends no `stale` event.
          activeId = task.id;
        }
      }
    }

    // 1. A task the prompt names that is not the one we are working on.
    //
    // Once per session per task: re-injecting it every prompt costs a CLI
    // call per turn to repeat what the agent already read. The price is that a
    // later status change is not re-announced.
    const injected = new Set(snapshot.injectedTasks || []);
    let looked = 0;
    for (const candidate of taskIdCandidates(prompt)) {
      if (overBudget()) break;
      if (candidate === activeId || injected.has(candidate)) continue;
      if (looked >= CANDIDATE_LOOKUP_LIMIT) break;
      looked += 1;
      const view = await taskView(candidate, { ...options, timeoutMs: CANDIDATE_TIMEOUT_MS });
      if (!view.ok) continue;
      blocks.push(renderForeignTask(view.task));
      injected.add(candidate);
      break; // one foreign brief per prompt is enough to be useful and bounded
    }

    // 2. Observations about the active task, using the facts refreshed above.
    if (edits > 0) {
      const observations = renderObservations(observe(task, derived));
      if (observations) blocks.push(observations);
    }

    // 3. Building something with nothing to review it against.
    //
    // Only `none` is the CLI positively answering that the In Progress column
    // is empty (BCC-48). The gate used to be `!activeId`, true for four
    // situations and claiming "no task is active" for all of them — measured
    // firing against a project whose TASK-1 really was In Progress, on a
    // machine where `backlog` was not on PATH. `ambiguous` is the opposite
    // claim and SessionStart already reports it; with `unavailable` nothing is
    // known and advice to run `backlog` is worthless; `null` means the
    // question was never put.
    if (resolvedState === "none" && !activeId && looksLikeBuildIntent(prompt)) blocks.push(renderIntentNudge());

    if (identityEvent) appendEvent(project.root, sessionId, identityEvent);
    // The last read-modify-write of the snapshot, safe here and only here:
    // UserPromptSubmit fires once per turn, serially. A second writer of
    // `injectedTasks` would make it a journal event instead.
    updateCache(project.root, sessionId, { injectedTasks: [...injected] });
    emitAdditionalContext("UserPromptSubmit", blocks.length > 0 ? blocks.join("\n\n") : null);
  },
  { event: "UserPromptSubmit" },
);
