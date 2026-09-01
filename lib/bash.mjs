// `complete\b` does not match inside "completed": both the "e" ending
// "complete" and the "d" that follows are word characters, so `\b` finds no
// boundary there and the alternative simply fails to match. `completed` is a
// real, read-only subcommand (it lists completed tasks), so this must stay
// true rather than incidentally true.
const MUTATION =
  /\bbacklog(?:\.md)?\s+(?:task|draft|milestone|doc|decision)\s+(?:edit|create|archive|promote|demote|remove|rename|add|complete)\b/;
const NOTES = /--(?:append-)?notes\b/;
// `backlog init` in a repository that already has one replaces its config.yml
// with defaults — the project name, statuses and task prefix included.
const INIT = /(?:^|[;&|]\s*)backlog(?:\.md)?\s+init\b/;

/**
 * Does this shell command mutate Backlog.md state?
 *
 * A heuristic, and safe as one: a false negative leaves the cache marked fresh
 * until the next SessionStart, and a false positive costs one refetch. The
 * deny path does not use a heuristic — see lib/paths.mjs.
 *
 * It matches the literal binary name and nothing else, so an alias, a shell
 * function, a project script and anything reaching the CLI through `npx` or a
 * package script are all missed — the false-negative direction, and the reason
 * widening the pattern has not been worth it.
 */
export function mutatesBacklog(command) {
  return typeof command === "string" && MUTATION.test(command);
}

/**
 * Does this command initialise a Backlog.md project?
 *
 * Anchored like `directBacklogCommand` in lib/quoting.mjs: the literal binary
 * at the start of a command, so `echo backlog init` and a task whose title
 * mentions it are not invocations. An env prefix (`BACKLOG_CWD=x backlog init`)
 * is missed for the same reason, which is the false-negative direction.
 */
export function initialisesBacklog(command) {
  return typeof command === "string" && INIT.test(command);
}

/** Does this command write a task's implementation notes? */
export function writesTaskNotes(command) {
  return mutatesBacklog(command) && NOTES.test(command);
}

// A redirect's target and tee's operands: the two ways a shell command names
// outright the file it is about to create or replace. `cp`, `mv` and `sed -i`
// name theirs positionally and are deliberately not matched — the deny path
// refuses only what it can identify exactly (see lib/paths.mjs), and a missed
// one leaves today's behaviour rather than a wrong refusal.
const REDIRECT_TARGET = /(?:^|[^0-9<>&])>>?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g;
const TEE_OPERANDS = /\btee\b((?:[ \t]+(?:"[^"]*"|'[^']*'|[^\s;&|<>]+))+)/g;
const OPERAND = /"([^"]*)"|'([^']*)'|([^\s;&|<>]+)/g;

function unquote(value) {
  return value.replace(/^(['"])([\s\S]*)\1$/, "$2");
}

/**
 * Every path this shell command would create or replace.
 *
 * The write tools are guarded by path; a shell redirect reaches the same file
 * without them, and a model that has just been refused reaches for it — one
 * wrote the task file it had been denied with `cat > 'backlog/tasks/EDG-1 -
 * ….md'`, narrating the detour as it went (BCC-6).
 */
export function shellWriteTargets(command) {
  if (typeof command !== "string") return [];
  const targets = [];
  for (const match of command.matchAll(REDIRECT_TARGET)) targets.push(unquote(match[1]));
  for (const match of command.matchAll(TEE_OPERANDS)) {
    for (const operand of match[1].matchAll(OPERAND)) {
      const value = operand[1] ?? operand[2] ?? operand[3];
      if (value.startsWith("-")) continue;
      targets.push(value);
    }
  }
  return targets.filter(Boolean);
}
