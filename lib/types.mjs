/** Shared type shapes, declared once. No runtime code — JSDoc only. */

/**
 * @typedef {object} ProcOptions
 * @property {number} [timeoutMs] Hard kill after this many milliseconds.
 * @property {string} [cwd] Working directory for the child.
 * @property {NodeJS.ProcessEnv} [env] Environment for the child.
 */

/**
 * A finished subprocess. `run()` never throws, so the failure arm is the only
 * error channel there is.
 *
 * @typedef {{ ok: true, reason: null, stdout: string, stderr: string, code: number }} ProcOk
 * @typedef {{ ok: false, reason: "timeout" | "spawn-failed" | "exit-nonzero", stdout: string, stderr: string, code: number | null }} ProcFail
 * @typedef {ProcOk | ProcFail} ProcResult
 */

/**
 * Options for the `backlog` CLI wrappers. `bin` and `prefixArgs` exist so
 * tests can route the call through a stand-in script; production callers pass
 * neither.
 *
 * @typedef {ProcOptions & { bin?: string, prefixArgs?: string[] }} BacklogOptions
 */

/**
 * Why a CLI wrapper could not answer. Switched on instead of caught, which
 * keeps the fail-open/fail-closed split visible at the call site.
 *
 * @typedef {"cli-missing" | "timeout" | "cli-error" | "unparseable" | "schema-drift" | "nothing-to-write" | "no-in-progress-status" | "unknown-key" | "unset"} FailureReason
 * @typedef {{ ok: false, reason: FailureReason, message?: string, found?: number | null }} Failure
 */

/**
 * A task as the CLI's JSON envelope reports it. Deliberately open: the plugin
 * reads a handful of fields and must not break when the CLI adds more.
 *
 * @typedef {Record<string, any>} Task
 * @typedef {{ id: string, title: string, status: string }} TaskShort
 */

/**
 * The states `resolveActiveTask` can report. A task arrives only with `branch`
 * or `status`, so reading `.task` requires narrowing — the point of the union.
 *
 * @typedef {{ state: "branch" | "status", task: Task, source: string }} ActiveResolved
 * @typedef {{ state: "none", source: string }} ActiveNone
 * @typedef {{ state: "ambiguous", candidates: TaskShort[], source: string }} ActiveAmbiguous
 * @typedef {{ state: "unavailable", reason: FailureReason, source: string }} ActiveUnavailable
 * @typedef {ActiveResolved | ActiveNone | ActiveAmbiguous | ActiveUnavailable} ActiveTaskState
 */

/**
 * `resolveActiveTask` also accepts two test-only escape hatches production
 * callers never set.
 *
 * @typedef {BacklogOptions & { identities?: string[], gitBin?: string, gitPrefixArgs?: string[] }} ActiveTaskOptions
 */

export {};
