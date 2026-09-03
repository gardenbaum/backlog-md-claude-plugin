// Acceptance criteria, and the one thing that keeps a checkbox meaningful:
// one assertion behind it. The check used to live inside `backlog_task_create`
// and so only ever saw a task's first draft. Criteria are rewritten far more
// often than they are created — a run split four compound criteria by hand and
// wrote a fifth compound one on the way, `--ac 'Der Pfad … folgt der Konvention
// …; die Datei selbst wird später ausserhalb dieser Aufgabe befuellt'`, which
// asserts a path and excuses a missing file in the same sentence. It was ticked
// (BCC-10, measured in edgemaker). Every writing surface shares this file now.

/**
 * The 1-based indices of criteria that carry more than one assertion.
 *
 * One checkbox over several requirements cannot record that some of them hold,
 * and the one that fails is the one that gets waved through: a criterion
 * reading "3-5 inhaltliche Hauptabschnitte" was ticked over a post with six,
 * and another asserted a title image "liegt unter public/images/posts/" while
 * excusing its absence in the same sentence (BCC-9, measured in edgemaker).
 *
 * Parentheticals are dropped first: "(nicht engineering, nicht gesellschaft)"
 * clarifies one assertion rather than adding three.
 *
 * @param {string[]} criteria
 * @returns {number[]}
 */
export function compoundCriteria(criteria) {
  return criteria.flatMap((text, i) => {
    const bare = String(text).replace(/\([^)]*\)/g, "");
    const joins = /\s(?:und|and|sowie)\s/i.test(bare) || bare.includes(";");
    return joins || (bare.match(/,/g) || []).length >= 3 ? [i + 1] : [];
  });
}

/**
 * What to say about criteria that carry more than one assertion.
 *
 * `positions` are indices in the task when they are known, and the position
 * within the call otherwise — a warning fired before the command runs cannot
 * know what number a criterion will end up with.
 *
 * The two ways out are named because both have a cost the CLI does not
 * mention: `--ac` appends to the end of the list, so a split reorders it, and
 * the replacement form clears every checkmark (both verified on 1.50.1).
 *
 * @param {number[]} positions
 * @param {{ id?: string, inTask?: boolean }} [options]
 */
export function compoundNotice(positions, { id = "<id>", inTask = true } = {}) {
  const one = positions.length === 1;
  const label = inTask
    ? `Criteri${one ? "on" : "a"} ${positions.map((n) => `#${n}`).join(", ")} carr${one ? "ies" : "y"}`
    : `${one ? "One" : `${positions.length}`} of the criteria in this command carr${one ? "ies" : "y"}`;
  return (
    `${label} more than one assertion. A criterion whose evidence needs an "and" cannot record that ` +
    "half of it holds, and the half that fails is the half that gets waved through. Split them now, while " +
    "nothing has been measured against them:\n" +
    `  backlog_edit_ac { taskId: "${id}", remove: [<n>], add: ["<one assertion>", "<the other>"] }\n` +
    `  backlog task edit ${id} --remove-ac <n> --ac '<one assertion>' --ac '<the other>'\n` +
    "Removing renumbers every criterion after it, so work from the highest index down. Added criteria land " +
    "at the end of the list rather than in the removed one's place; to keep the order, pass the whole list " +
    "as `criteria` instead — `--clear-ac` plus `--acceptance-criteria` does the same through the CLI and " +
    "clears every checkmark on the way, which the native tool restores and the CLI does not.\n" +
    // The check reads "und" as a join, and a bound is written with one. A run
    // split "mindestens 80 und höchstens 200 Zeichen" into two criteria and
    // measured the same string twice (BCC-11, measured in edgemaker).
    "One measurement is one assertion however its bounds are written: a range, a span, a minimum with a maximum " +
    "stay a single criterion. Split what needs two separate measurements, not what needs two numbers."
  );
}

// `--ac` and `--acceptance-criteria` take one value each and are repeatable.
// Only the quoted forms are captured: an unquoted criterion is a single word,
// which is not the shape this warning is about.
const CRITERION_FLAG = /--(?:ac|acceptance-criteria)[=\s]+(?:'([^']*)'|"([^"]*)")/g;
const CRITERION_COMMAND = /\bbacklog(?:\.md)?\s+task\s+(?:edit|create)\b/;

/**
 * Every acceptance criterion a shell command would write.
 *
 * Empty for anything that is not a `backlog task edit|create`, so a criterion
 * quoted inside an unrelated command is never read as one.
 *
 * @param {unknown} command
 * @returns {string[]}
 */
export function criteriaInCommand(command) {
  if (typeof command !== "string" || !CRITERION_COMMAND.test(command)) return [];
  return [...command.matchAll(CRITERION_FLAG)].map((match) => match[1] ?? match[2]).filter((value) => value.trim());
}
