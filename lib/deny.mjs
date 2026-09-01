import { QUOTING_SHORT } from "./quoting.mjs";

const GENERIC = ["backlog task edit --help"];

/** @type {Array<[RegExp, (id: string) => string[]]>} */
const SECTIONS = [
  [/acceptance criteria/i, (id) => [`backlog task edit ${id} --ac 'new criterion'`, "# to tick one: --check-ac <n>"]],
  [/implementation notes/i, (id) => [`backlog task edit ${id} --append-notes '...'`, "# one call per line"]],
  [/implementation plan/i, (id) => [`backlog task edit ${id} --append-plan '...'`]],
  [/definition of done/i, (id) => [`backlog task edit ${id} --dod 'new item'`, "# to tick one: --check-dod <n>"]],
  [/^[ \t]*status[ \t]*:/im, (id) => [`backlog task edit ${id} -s '<status>'`]],
];

/**
 * Join a command's lines under a shared indent, matching the "Use instead:\n  "
 * prefix each `*Reason` function prints before it.
 */
function formatCommand(lines) {
  return lines.join("\n  ");
}

/**
 * `task edit` covers every section a hand-edit might be attempting, so
 * inference is worthwhile here. Every other kind has a narrower or absent
 * command surface and gets its own function.
 */
function taskReason(id, text) {
  const generic = id ? [`backlog task edit ${id} --help`] : GENERIC;
  const command = id ? (SECTIONS.find(([pattern]) => pattern.test(text))?.[1]?.(id) ?? generic) : generic;
  return (
    `${id ? `${id} is a Backlog.md task file` : "This is a Backlog.md task file, but its id could not be parsed from the filename"}. ` +
    "Its frontmatter, checklist indices and relationships are maintained by the CLI, " +
    "so a hand-edit can silently corrupt metadata that later reads depend on.\n\n" +
    `Use instead:\n  ${formatCommand(command)}\n\n` +
    QUOTING_SHORT
  );
}

/**
 * A draft has no in-place edit command: `backlog task edit <draftId>` answers
 * "not found" (verified), so no flavour of it is named. `draft promote` works
 * but reassigns a new id, so no follow-up command is printed either.
 */
function draftReason(id) {
  const lines = ["backlog draft --help"];
  if (id) lines.push(`backlog draft promote ${id}`);
  return (
    `${id ? `${id} is a Backlog.md draft` : "This is a Backlog.md draft"}. ` +
    "Backlog.md has no command that edits a draft's content in place — " +
    "'backlog draft' only lists, creates, archives, promotes or views.\n\n" +
    `Use instead:\n  ${formatCommand(lines)}` +
    (id
      ? "\n\nPromoting assigns it a new task id (not this one), which then becomes editable with `backlog task edit`."
      : "")
  );
}

/**
 * A closed record, not a live task: `task edit` answers "not found" for it and
 * no reactivate command exists (verified). No command is offered — reopening a
 * closed record is a decision only a person should make.
 */
function historicalReason(kind, id) {
  const label = kind === "completed" ? "a completed task" : "an archived task";
  return (
    `${id ? `${id} is ${label}` : `This is ${label}`}, kept as a historical record. ` +
    "Backlog.md's task lookups only see the active working copy, so `backlog task edit` cannot reach it here, " +
    "and there is no CLI command to reactivate it.\n\n" +
    "Whether to reopen or amend a closed record is a decision for a person, not an automatic redirect."
  );
}

/** There is no `milestone edit`; `rename` is the only command that changes its content. */
function milestoneReason(id) {
  const target = id ?? "'<current name>'";
  return (
    `${id ? `${id} is a Backlog.md milestone file` : "This is a Backlog.md milestone file"}. ` +
    "There is no 'milestone edit' — 'rename' is the only command that changes its content.\n\n" +
    `Use instead:\n  backlog milestone rename ${target} '<new name>'\n\n` +
    "Reassigning or clearing the tasks under it goes through `backlog milestone remove`, not a hand-edit."
  );
}

/** The CLI verb is `doc update`, not `doc edit`. */
function docReason(id) {
  const command = id
    ? [`backlog doc update ${id} --content '...'`, "# also --title, --tags, -p; see 'backlog doc update --help'"]
    : ["backlog doc update --help"];
  return (
    `${id ? `${id} is a Backlog.md document` : "This is a Backlog.md document"}. ` +
    "Its id, path and tags are maintained by the CLI, so a hand-edit can desynchronise them from what " +
    "`backlog doc list` reports.\n\n" +
    `Use instead:\n  ${formatCommand(command)}`
  );
}

/**
 * Only reached for a decision file that does not exist yet — the guard lets a
 * hand-edit of an existing one through, because `backlog decision` creates and
 * lists but never edits, and refusing the only way to fill in the template it
 * writes left the record permanently empty (BCC-5).
 */
function decisionReason(id) {
  return (
    `${id ? `${id} would be a new Backlog.md decision record` : "This would be a new Backlog.md decision record"}. ` +
    "The CLI assigns its id and filename, so one written by hand is invisible to `backlog decision list`.\n\n" +
    "Use instead:\n  backlog decision create '<title>' -s proposed --plain\n\n" +
    "It writes a template with no command to fill it in, so editing that file afterwards is allowed."
  );
}

function configReason() {
  return (
    "Backlog.md owns its configuration file. Editing it by hand can desynchronise " +
    "the values the CLI validates.\n\n" +
    "Use instead:\n  backlog config set '<key>' '<value>'\n  # or, interactively:\n  backlog config"
  );
}

function unknownKindReason(id) {
  return (
    `${id ? `${id} is a Backlog.md-managed file` : "This is a Backlog.md-managed file"}. ` +
    "Its content is maintained by the CLI.\n\nUse instead:\n  backlog --help"
  );
}

const HANDLERS = {
  config: () => configReason(),
  draft: (id) => draftReason(id),
  completed: (id) => historicalReason("completed", id),
  archive: (id) => historicalReason("archive", id),
  milestone: (id) => milestoneReason(id),
  doc: (id) => docReason(id),
  decision: (id) => decisionReason(id),
};

/**
 * Explain a blocked write and name the command that should have been run,
 * scoped to the file's kind. Only `task` infers from the edit's content, and
 * only when it unambiguously names a section — an index is never guessed,
 * because a wrong command carries the plugin's authority, which is worse than
 * no command at all. Kinds with no suitable command name none.
 */
export function denyReason(classification, toolInput) {
  const text = [toolInput?.new_string, toolInput?.content, toolInput?.old_string]
    .filter((v) => typeof v === "string")
    .join("\n");

  const { kind, taskId: id } = classification;
  if (kind === "task") return taskReason(id, text);
  return (HANDLERS[kind] ?? unknownKindReason)(id);
}

/**
 * `backlog init` is not a hand-edit, but it ends the same way: the existing
 * configuration is replaced by defaults, and with it the project name,
 * statuses and task prefix. The refusal names both ways forward, because a
 * guard that only says no to a legitimate operation gets worked around
 * instead of followed.
 */
export function initReason(configPath) {
  return (
    `This directory already belongs to a Backlog.md project: ${configPath}. ` +
    "`backlog init` would overwrite that file with defaults, discarding the project name, " +
    "statuses, task prefix and every other setting in it.\n\n" +
    "To change one setting:\n  backlog config set '<key>' '<value>'\n\n" +
    `To start over deliberately: move or delete ${configPath} first, then run \`backlog init\` again.`
  );
}
