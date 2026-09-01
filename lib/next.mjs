import { taskList, priorities, resolveTodoStatus } from "./backlog.mjs";

const UNKNOWN_RANK = Number.MAX_SAFE_INTEGER;

/**
 * Order ready tasks by configured priority, then due date, then ordinal, then
 * id. `--sort` takes one field, so this cannot be delegated to the CLI. Pure.
 *
 * Due date below priority (a deadline says when, priority says whether) and
 * above ordinal (a date somebody committed to outranks a position somebody
 * dragged). A missing date sorts last. The tier is inert on Backlog.md 1.50.1,
 * which has no due date at all (measured) — one comparison, and it starts
 * working the day a CLI emits the field (BCC-42).
 */
export function rankReady(tasks, priorityOrder = []) {
  const rank = new Map(priorityOrder.map((p, i) => [p.toLowerCase(), i]));
  const priorityRank = (task) => rank.get(String(task.priority ?? "").toLowerCase()) ?? UNKNOWN_RANK;
  const ordinalRank = (task) => (typeof task.ordinal === "number" ? task.ordinal : UNKNOWN_RANK);
  const dueRank = (task) => {
    const parsed = Date.parse(String(task.dueDate ?? ""));
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };
  return [...tasks].sort(
    (a, b) =>
      priorityRank(a) - priorityRank(b) ||
      compare(dueRank(a), dueRank(b)) ||
      ordinalRank(a) - ordinalRank(b) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/**
 * Subtraction is not usable: two missing due dates are both `Infinity`, and
 * `Infinity - Infinity` is `NaN`.
 *
 * @param {number} a @param {number} b @returns {number}
 */
function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Ready work from the to-do column. `--ready` is the CLI's own definition of
 * unblocked (measured: it excludes a task whose dependency is still open), so
 * dependency logic is not reimplemented here.
 *
 * @param {import("./types.mjs").BacklogOptions & { limit?: number }} [options]
 * @returns {Promise<{ ok: true, status: string, tasks: import("./types.mjs").Task[], total?: number } | { ok: false, reason: import("./types.mjs").FailureReason }>}
 */
export async function findNext({ cwd, limit = 3, ...opts } = {}) {
  const options = { cwd, ...opts };
  const [pool, order] = await Promise.all([resolveTodoStatus(options), priorities(options)]);
  if (!pool.ok) return { ok: false, reason: pool.reason };

  const list = await taskList(["-s", pool.status, "--ready"], options);
  if (!list.ok) return { ok: false, reason: list.reason };

  const tasks = rankReady(list.tasks, order.ok ? order.priorities : []).slice(0, limit);
  // Nothing ready is two different situations with two different next steps:
  // work exists but is blocked, or the backlog is empty and the first task has
  // yet to be written. A session told the first thing about the second one
  // spent its turns looking for the blockage (BCC-6). Counted only on that
  // path, and a failed count simply leaves `total` absent.
  const all = tasks.length === 0 ? await taskList([], options) : null;

  return {
    ok: true,
    status: pool.status,
    tasks,
    ...(all?.ok ? { total: all.tasks.length } : {}),
  };
}
