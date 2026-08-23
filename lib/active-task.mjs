import { run } from "./proc.mjs";
import { taskView, taskList, configList } from "./backlog.mjs";

/**
 * @typedef {import("./types.mjs").ActiveTaskOptions} ActiveTaskOptions
 * @typedef {import("./types.mjs").ActiveTaskState} ActiveTaskState
 * @typedef {import("./types.mjs").Task} Task
 */

export const IN_PROGRESS = "In Progress";

const CANDIDATE_PATTERN = /[A-Za-z]+-\d+(?:\.\d+)*/g;
const UNAVAILABLE_REASONS = new Set(["cli-missing", "timeout", "schema-drift", "unparseable"]);

/** Every plausible task id in a string. Guesses — the caller validates them against `backlog`. */
export function taskIdCandidates(text) {
  if (!text) return [];
  const seen = new Set();
  for (const match of String(text).matchAll(CANDIDATE_PATTERN)) seen.add(match[0]);
  return [...seen];
}

/**
 * @param {Task} task
 * @returns {import("./types.mjs").TaskShort}
 */
export function shortOf(task) {
  return { id: task.id, title: task.title, status: task.status };
}

// Destructured on purpose: `opts` may carry the test-only `bin`/`prefixArgs`
// keys meant for the backlog CLI, and they must never reach a git spawn.
/**
 * @param {import("./types.mjs").ProcOptions} [options]
 * @returns {Promise<string | null>}
 */
async function currentBranch({ cwd, timeoutMs } = {}) {
  const r = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs });
  if (!r.ok) return null;
  const branch = r.stdout.trim();
  return branch && branch !== "HEAD" ? branch : null;
}

/**
 * Best-effort identities for narrowing an ambiguous In Progress column to
 * "assigned to me". Every source is independent and a failure contributes
 * nothing rather than throwing: fewer identities means less narrowing, never
 * an error. `gitBin`/`gitPrefixArgs` are a test-only override.
 *
 * @param {ActiveTaskOptions} [options]
 * @returns {Promise<string[]>}
 */
export async function resolveIdentities({ cwd, timeoutMs, gitBin = "git", gitPrefixArgs = [], ...backlogOpts } = {}) {
  const identities = [];
  const gitConfig = async (key) => {
    const r = await run(gitBin, [...gitPrefixArgs, "config", key], { cwd, timeoutMs });
    return r.ok ? r.stdout.trim() : "";
  };

  const email = await gitConfig("user.email");
  if (email) identities.push(email);

  const name = await gitConfig("user.name");
  if (name) identities.push(name);

  const configured = await configList("defaultAssignee", { cwd, timeoutMs, ...backlogOpts });
  if (configured.ok) identities.push(...configured.list);

  return identities;
}

/**
 * Resolve which task this session is working on. Returns a discriminated state
 * rather than a task, so the fail-closed/fail-open decision is visible at
 * every call site instead of implicit.
 *
 * @param {ActiveTaskOptions} [opts]
 * @returns {Promise<ActiveTaskState>}
 */
export async function resolveActiveTask(opts = {}) {
  // 1. Branch name, validated against the backlog.
  const branch = await currentBranch({ cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  for (const candidate of taskIdCandidates(branch)) {
    const r = await taskView(candidate, opts);
    if (r.ok) return { state: "branch", task: r.task, source: `branch:${branch}` };
    if (UNAVAILABLE_REASONS.has(r.reason)) {
      return { state: "unavailable", reason: r.reason, source: "branch" };
    }
    // "cli-error" means this candidate is not a task; try the next one. It
    // conflates that with an uncovered CLI failure on purpose — falling
    // through beats reporting "unavailable" for a branch that is not a task.
  }

  // 2. Exactly one task in the In Progress column.
  const configured = await configList("statuses", opts);
  if (!configured.ok) return { state: "unavailable", reason: configured.reason, source: "statuses" };
  if (!configured.list.includes(IN_PROGRESS)) {
    // A project that renamed its columns returns an empty list with exit 0 for
    // an unknown status, which is indistinguishable from "no tasks". Rather
    // than interpret the column layout, this step reports itself unusable.
    return { state: "unavailable", reason: "no-in-progress-status", source: "statuses" };
  }

  const list = await taskList(["-s", IN_PROGRESS], opts);
  if (!list.ok) return { state: "unavailable", reason: list.reason, source: "status" };
  if (list.tasks.length === 0) return { state: "none", source: "status" };

  // Lazy: the common path (zero or one In Progress task) must pay nothing for
  // a git spawn it does not need. `opts.identities` is the test override.
  let chosen = list.tasks;
  if (list.tasks.length > 1) {
    const identities = opts.identities ?? (await resolveIdentities(opts));
    chosen = narrowToSelf(list.tasks, identities);
  }
  if (chosen.length === 1) {
    const full = await taskView(chosen[0].id, opts);
    if (!full.ok) return { state: "unavailable", reason: full.reason, source: "status" };
    return {
      state: "status",
      task: full.task,
      source: list.tasks.length === 1 ? "status" : "status:assignee",
    };
  }
  return { state: "ambiguous", candidates: chosen.map(shortOf), source: "status" };
}

/**
 * Flatten a resolution into the field set the CLI's JSON surfaces print, so
 * the union narrowing happens once rather than in every caller.
 *
 * @param {ActiveTaskState} resolved
 * @returns {{ state: string, taskId: string | null, source: string, reason: string | null, candidates: import("./types.mjs").TaskShort[] | null }}
 */
export function describeActiveTask(resolved) {
  return {
    state: resolved.state,
    taskId: "task" in resolved ? (resolved.task.id ?? null) : null,
    source: resolved.source,
    reason: "reason" in resolved ? resolved.reason : null,
    candidates: "candidates" in resolved ? resolved.candidates : null,
  };
}

export function narrowToSelf(tasks, identities) {
  if (!identities || identities.length === 0) return tasks;
  const wanted = identities.map(normaliseAssignee);
  const mine = tasks.filter((t) => (t.assignees || []).some((a) => wanted.includes(normaliseAssignee(a))));
  return mine.length > 0 ? mine : tasks;
}

export function normaliseAssignee(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}
