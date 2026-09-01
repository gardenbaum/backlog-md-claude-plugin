export const NOTES_STALENESS_THRESHOLD = 10;

const BUILD_INTENT = /\b(implement|build|add|create|write|fix|refactor|migrate|rename|remove|delete|wire|hook up)\b/i;

// The same heuristic in German, which the English word list missed entirely:
// a German request produced silence, so no task was ever proposed (BCC-2).
// Stems plus the endings an imperative or infinitive actually takes — `\w*`
// would be shorter and would also match `Baum`. The boundaries are letter
// lookarounds rather than `\b`, which is ASCII-only and so refuses to open a
// match on `ändere`.
const BUILD_INTENT_DE =
  /(?<!\p{L})(erstell|erzeug|anleg|einricht|entwickel|programmier|implementier|integrier|konfigurier|generier|bau|schreib|ergänz|erweiter|entfern|lösch|beheb|reparier|änder|anpass|umbenenn|migrier|refaktorier|aktualisier|umsetz|füg)(e|en|n|st|t|te|ten)?(?!\p{L})/iu;

/**
 * Turn task and session state into things worth telling the agent.
 *
 * These were going to be `Stop`-hook gates. A gate whose only escape hatch is
 * the agent mutating task state produces checked boxes, not verified work — so
 * the wording asks for evidence and always offers leaving a criterion open as
 * a legitimate answer. Nothing here treats a checked box as success.
 */
export function observe(task, session = {}) {
  if (!task) return [];
  const edits = session.sourceEdits ?? 0;
  const lines = [];

  const open = (task.acceptanceCriteria || []).filter((c) => !c.checked);
  if (edits > 0 && open.length > 0) {
    const indices = open.map((c) => c.index).join(", ");
    const verb = open.length === 1 ? "is" : "are";
    lines.push(
      `${task.id}: acceptance criteria ${indices} ${verb} unchecked after ${edits} source edit${edits === 1 ? "" : "s"}. ` +
        `For each, name the file:line and the test that demonstrates it, then check it with ` +
        `\`backlog task edit ${task.id} --check-ac <n>\` — or say why it cannot be verified and leave it open.`,
    );
  }

  const sinceNotes = edits - (session.editsAtLastNotes ?? 0);
  if (sinceNotes > NOTES_STALENESS_THRESHOLD) {
    lines.push(
      `${task.id}: implementation notes have not been updated in ${sinceNotes} source edits. ` +
        `Record what changed with \`backlog task edit ${task.id} --append-notes '...'\`, one call per line.`,
    );
  }

  if (task.status === "Done" && !task.finalSummary) {
    lines.push(
      `${task.id} is Done with no final summary. Add one with \`backlog task edit ${task.id} --final-summary '...'\`.`,
    );
  }

  return lines;
}

/**
 * Does this prompt look like a request to change code? A keyword heuristic,
 * safe as one: a miss produces silence, the same as the plugin not existing.
 */
export function looksLikeBuildIntent(prompt) {
  if (typeof prompt !== "string") return false;
  return BUILD_INTENT.test(prompt) || BUILD_INTENT_DE.test(prompt);
}
