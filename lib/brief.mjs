import { findProject } from "./paths.mjs";
import { resolveActiveTask, IN_PROGRESS } from "./active-task.mjs";
import { taskList, resolveTodoStatus } from "./backlog.mjs";
import { renderBrief, renderNoTask, renderAmbiguous } from "./render.mjs";
import { readCache, updateCache } from "./cache.mjs";

const NEXT_CANDIDATE_LIMIT = 3;

/**
 * Produce the context a session needs and record what was found.
 *
 * Returns `context: null` whenever there is nothing worth injecting — outside a
 * project, or when the CLI is unavailable. Silence is the correct output in
 * those cases, not an explanation nobody asked for.
 */
export async function buildBrief({ cwd, sessionId, event, ...cliOpts }) {
  const project = findProject(cwd || process.cwd());
  if (!project) return { context: null, snapshot: null };

  // No `identities`: resolveActiveTask resolves them lazily. Passing an empty
  // array would make narrowing permanently dead code.
  const opts = { cwd: project.root, ...cliOpts };
  const resolved = await resolveActiveTask(opts);

  // `updateCache` merges shallowly, so a plain `hookRuns: { [event]: ... }`
  // patch would replace the whole key and erase any other hook's timestamp
  // already recorded for this session. Merge on top of what is there.
  const previous = readCache(project.root, sessionId) || {};

  // "unavailable" is a transient CLI failure and establishes nothing about
  // which task is active, unlike "none" and "ambiguous". Overwriting `taskId`
  // with null there threw away a good cached id to infrastructure noise.
  const resolvedId = "task" in resolved ? (resolved.task.id ?? null) : null;
  const taskId = resolved.state === "unavailable" ? (previous.taskId ?? null) : resolvedId;

  const snapshot = {
    repoRoot: project.root,
    backlogDir: project.backlogDir,
    state: resolved.state,
    taskId,
    updatedAt: new Date().toISOString(),
    hookRuns: { ...(previous.hookRuns || {}), [event]: new Date().toISOString() },
  };

  if (resolved.state === "unavailable") {
    updateCache(project.root, sessionId, snapshot);
    return { context: null, snapshot };
  }

  if (resolved.state === "ambiguous") {
    updateCache(project.root, sessionId, snapshot);
    return { context: renderAmbiguous(resolved.candidates), snapshot };
  }

  if (resolved.state === "none") {
    const [todo, pool] = await Promise.all([taskList([], opts), resolveTodoStatus(opts)]);
    /** @type {Record<string, number>} */
    const counts = {};
    /** @type {import("./types.mjs").Task[]} */
    const candidates = [];
    if (todo.ok) {
      for (const t of todo.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
      const todoStatus = pool.ok ? pool.status : null;
      candidates.push(
        ...todo.tasks
          .filter((t) => (todoStatus ? t.status === todoStatus : t.status !== IN_PROGRESS))
          .slice(0, NEXT_CANDIDATE_LIMIT),
      );
    }
    updateCache(project.root, sessionId, snapshot);
    return { context: renderNoTask({ counts, candidates }), snapshot };
  }

  const task = resolved.task;
  const acceptance = task.acceptanceCriteria || [];
  updateCache(project.root, sessionId, {
    ...snapshot,
    taskTitle: task.title,
    taskStatus: task.status,
    acceptanceTotal: acceptance.length,
    acceptanceChecked: acceptance.filter((c) => c.checked).length,
    dodTotal: (task.definitionOfDone || []).length,
    dodChecked: (task.definitionOfDone || []).filter((d) => d.checked).length,
    source: resolved.source,
  });
  return { context: renderBrief(task), snapshot };
}
