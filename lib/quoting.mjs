// The hazards of Backlog.md's CLI that hit agents hardest: three of quoting,
// and one of concurrency. The same wording has to reach the skill, every agent
// prompt and every deny reason, so this is its only home in code;
// test/unit/prompts.test.mjs holds the Markdown files to it.
//
// The first rule used to say "repeated `--append-*` flags" and left the agent
// to guess which ones exist. One guessed `--append-ac`, which does not —
// acceptance criteria are added with `--ac` and replaced with
// `--acceptance-criteria` (BCC-10, measured in edgemaker). The three are named
// now, because a glob in an instruction is an invitation to invent a fourth.
export const QUOTING_RULES = [
  "Multi-line values: repeated `--append-plan`, `--append-notes` or `--append-final-summary` flags, one invocation per line, is the recommended form. Those three are the only append flags there are — acceptance criteria are added with `--ac` and replaced with `--acceptance-criteria`. A real newline inside the quoted value works too. A literal `\\n` does not — it is stored as text.",
  "Never use ANSI-C quoting such as `$'a\\nb'` — the tree-sitter-based sandbox agents run in rejects it (Backlog.md issue #595).",
  "Single-quote any value containing backticks. Inside double quotes they are command substitution, and the original text cannot be recovered afterwards.",
  "One `backlog` command at a time. Backlog.md locks a task per process, so several issued in one parallel batch fail with `is being modified by another process` — twelve did in one run, and the retries re-applied what had already landed. Wait for each to return before sending the next.",
];

/** The compressed form that fits inside a deny reason. */
export const QUOTING_SHORT =
  "Multi-line values are safest as one `--append-plan`/`--append-notes` call per line; quote anything containing backticks with single quotes; send one `backlog` command at a time, never a parallel batch.";

function directBacklogCommand(command) {
  return /(?:^|[;&|]\s*)backlog(?:\s|$)/.test(command);
}

function literalNewlines(command) {
  let quote = null;
  let out = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (!quote) {
      if (char === "'" || char === '"') quote = char;
      out += char;
      continue;
    }
    if (char === "\\" && command[i + 1] === "n") {
      out += "\n";
      i += 1;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      out += char + command[i + 1];
      i += 1;
      continue;
    }
    out += char;
    if (char === quote) quote = null;
  }
  return out;
}

/**
 * Return a shell-safe direct Backlog command when one of the quoting hazards
 * is present, otherwise null. Values are agents' literal task content, so
 * converting ANSI-C escapes and backtick-bearing double quotes is deliberate.
 */
export function correctedBacklogCommand(command) {
  if (typeof command !== "string" || !directBacklogCommand(command)) return null;
  let corrected = command.replace(/\$'((?:\\.|[^'])*)'/g, (_match, value) => `'${value.replaceAll("\\n", "\n")}'`);
  corrected = literalNewlines(corrected);
  corrected = corrected.replace(/"((?:\\.|[^"\\])*)"/g, (whole, value) =>
    value.includes("`") ? `'${value.replaceAll("'", "'\\''")}'` : whole,
  );
  return corrected === command ? null : corrected;
}
