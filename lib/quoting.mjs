// Backlog.md's CLI has three quoting hazards that hit agents hardest. The same
// wording has to reach the skill, every agent prompt and every deny reason, so
// this is its only home in code; test/unit/prompts.test.mjs holds the Markdown
// files to it.
export const QUOTING_RULES = [
  "Multi-line values: repeated `--append-*` flags, one invocation per line, is the recommended form. A real newline inside the quoted value works too. A literal `\\n` does not — it is stored as text.",
  "Never use ANSI-C quoting such as `$'a\\nb'` — the tree-sitter-based sandbox agents run in rejects it (Backlog.md issue #595).",
  "Single-quote any value containing backticks. Inside double quotes they are command substitution, and the original text cannot be recovered afterwards.",
];

/** The compressed form that fits inside a deny reason. */
export const QUOTING_SHORT =
  "Multi-line values are safest as one `--append-*` call per line; quote anything containing backticks with single quotes.";

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
