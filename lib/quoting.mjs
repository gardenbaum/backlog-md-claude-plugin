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
