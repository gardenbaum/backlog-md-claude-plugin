import { run } from "./proc.mjs";

/**
 * @typedef {import("./types.mjs").BacklogOptions} BacklogOptions
 * @typedef {import("./types.mjs").Failure} Failure
 * @typedef {import("./types.mjs").Task} Task
 */

const SCHEMA_VERSION = 1;

/**
 * Map a failed spawn onto the reason callers switch on. `cli-error` carries
 * the CLI's own first line, which is the only part worth showing a person.
 *
 * @param {import("./types.mjs").ProcResult} r
 * @returns {Failure}
 */
function fail(r) {
  if (r.reason === "spawn-failed") return { ok: false, reason: "cli-missing" };
  if (r.reason === "timeout") return { ok: false, reason: "timeout" };
  return { ok: false, reason: "cli-error", message: firstLine(r.stderr) || firstLine(r.stdout) };
}

/**
 * Run a `backlog` subcommand in JSON mode and validate the envelope.
 *
 * The JSON contract is documented as versioned, so it is asserted rather than
 * trusted: any `schemaVersion` other than 1 yields `schema-drift` and callers
 * degrade to a no-op instead of acting on a contract they do not understand.
 *
 * `prefixArgs` exists so tests can run a stand-in script through `node`.
 * Production callers pass neither `bin` nor `prefixArgs`.
 *
 * @param {string[]} args
 * @param {BacklogOptions} [options]
 * @returns {Promise<{ ok: true, doc: any } | Failure>}
 */
export async function backlogJson(args, { cwd, timeoutMs, bin = "backlog", prefixArgs = [] } = {}) {
  const r = await run(bin, [...prefixArgs, ...args, "--json"], { cwd, timeoutMs });
  if (!r.ok) return fail(r);
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (doc?.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: "schema-drift", found: doc?.schemaVersion ?? null };
  }
  return { ok: true, doc };
}

/**
 * @param {string | number} id
 * @param {BacklogOptions} [opts]
 * @returns {Promise<{ ok: true, task: Task } | Failure>}
 */
export async function taskView(id, opts = {}) {
  const r = await backlogJson(["task", String(id)], opts);
  if (!r.ok) return r;
  if (!r.doc.task) return { ok: false, reason: "unparseable" };
  return { ok: true, task: r.doc.task };
}

/**
 * @param {string[]} [args]
 * @param {BacklogOptions} [opts]
 * @returns {Promise<{ ok: true, tasks: Task[] } | Failure>}
 */
export async function taskList(args = [], opts = {}) {
  const r = await backlogJson(["task", "list", ...args], opts);
  if (!r.ok) return r;
  if (!Array.isArray(r.doc.tasks)) return { ok: false, reason: "unparseable" };
  return { ok: true, tasks: r.doc.tasks };
}

/**
 * Read one Backlog.md config value as plain text.
 *
 * `config get` does not emit the JSON envelope, so this does not go through
 * `backlogJson`. An unknown key gets its own reason: "this Backlog.md has no
 * such setting" and "the read failed" call for different lines, and the CLI
 * answers exit 1 for both.
 *
 * @param {string} key
 * @param {BacklogOptions} [options]
 * @returns {Promise<{ ok: true, value: string } | Failure>}
 */
export async function configValue(key, { cwd, timeoutMs, bin = "backlog", prefixArgs = [] } = {}) {
  const r = await run(bin, [...prefixArgs, "config", "get", key], { cwd, timeoutMs });
  if (!r.ok) {
    if (r.reason === "exit-nonzero" && /unknown config key/i.test(`${r.stdout}\n${r.stderr}`)) {
      return { ok: false, reason: "unknown-key" };
    }
    return fail(r);
  }
  const value = r.stdout.trim();
  if (!value || value === "(not set)") return { ok: false, reason: "unset" };
  return { ok: true, value };
}

/**
 * A config value that is a comma-separated list — `statuses`, `priorities`
 * and `defaultAssignee` all share that shape. Brackets are stripped: 1.50.1
 * prints priorities bracketed under `config list` but not under `config get`.
 *
 * An unset key is an empty list, not a failure. Reading `statuses` matters
 * because a project that renamed its columns answers an unknown status with
 * an empty list and exit 0, indistinguishable from "no tasks".
 *
 * @param {string} key
 * @param {BacklogOptions} [options]
 * @returns {Promise<{ ok: true, list: string[] } | Failure>}
 */
export async function configList(key, options = {}) {
  const r = await configValue(key, options);
  if (!r.ok) return r.reason === "unset" ? { ok: true, list: [] } : r;
  return {
    ok: true,
    list: r.value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Read the configured priority names, in the order that defines their rank.
 *
 * @param {BacklogOptions} [options]
 * @returns {Promise<{ ok: true, priorities: string[] } | Failure>}
 */
export async function priorities(options = {}) {
  const r = await configList("priorities", options);
  if (!r.ok) return r;
  return r.list.length === 0 ? { ok: false, reason: "unparseable" } : { ok: true, priorities: r.list };
}

/**
 * The to-do column: the column new tasks land in, or the first configured
 * status when nothing says otherwise.
 *
 * One definition on purpose. brief.mjs used to take `statuses[0]` while
 * next.mjs resolved `defaultStatus` first, so in a project where the two
 * differ the SessionStart brief and /backlog-md:next proposed tasks from
 * different columns (BCC-9).
 *
 * @param {BacklogOptions} [options]
 * @returns {Promise<{ ok: true, status: string } | Failure>}
 */
export async function resolveTodoStatus(options = {}) {
  const configured = await configValue("defaultStatus", options);
  if (configured.ok) return { ok: true, status: configured.value };
  const all = await configList("statuses", options);
  if (!all.ok) return all;
  if (all.list.length === 0) return { ok: false, reason: "unparseable" };
  return { ok: true, status: all.list[0] };
}

/**
 * Replace a task's modified-file list.
 *
 * `--modified-file` REPLACES rather than appends — verified by experiment and
 * pinned by an integration test — so every caller must read, union, and write
 * the whole list. This does not go through `backlogJson`: `task edit` does not
 * emit the JSON envelope, so there is no `schemaVersion` to assert.
 *
 * @param {string | number} id
 * @param {string[]} files
 * @param {BacklogOptions} [options]
 * @returns {Promise<{ ok: true } | Failure>}
 */
export async function setModifiedFiles(id, files, { cwd, timeoutMs, bin = "backlog", prefixArgs = [] } = {}) {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, reason: "nothing-to-write" };

  const args = ["task", "edit", String(id)];
  for (const file of files) args.push("--modified-file", file);

  const r = await run(bin, [...prefixArgs, ...args], { cwd, timeoutMs });
  return r.ok ? { ok: true } : fail(r);
}

function firstLine(text) {
  return String(text || "")
    .split("\n")[0]
    .trim();
}
