import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { QUOTING_RULES } from "../../lib/quoting.mjs";
import { promptFiles, frontmatter, readPrompt as read } from "../helpers/prompts.mjs";

test("the skill exists where a plugin's skills are discovered", () => {
  assert.ok(promptFiles().includes(join("skills", "backlog-workflow", "SKILL.md")));
});

test("the workflow skill is hidden from OMP discovery but remains installed", () => {
  const { fields } = frontmatter(read(join("skills", "backlog-workflow", "SKILL.md")));
  assert.equal(fields.hide, "true");
});

test("every prompt file has frontmatter with a description", () => {
  for (const rel of promptFiles()) {
    const { fields } = frontmatter(read(rel));
    assert.ok(fields, `${rel}: no frontmatter`);
    assert.ok(fields.description, `${rel}: no description`);
  }
});

test("OMP rules separate always-applied task ownership from CLI quoting guidance", () => {
  const contract = frontmatter(read(join("rules", "backlog-md-contract.md")));
  assert.equal(contract.fields.alwaysApply, "true");
  assert.match(contract.body, /backlog_next/);
  assert.match(contract.body, /backlog_check_ac.*evidence/i);
  // The three ways a session leaves the workflow before it starts: no task
  // exists yet, Backlog.md's own CLI instructions outweigh this rule, or the
  // host's todo list stands in for the task (BCC-3).
  assert.match(contract.body, /backlog_task_create/);
  assert.match(contract.body, /supersede the Backlog\.md CLI instructions/);
  assert.match(contract.body, /todo list.*does not replace the task/is);

  // A tool that exists but refuses the call is neither "no tool" nor a reason
  // to hand-write the file. Without this the contract reads as a dead end, and
  // a session took it as one (BCC-6).
  assert.match(contract.body, /refuses the call[\s\S]*`backlog` CLI/);

  const quoting = frontmatter(read(join("rules", "backlog-md-quoting.md")));
  assert.match(quoting.fields.condition, /backlog task edit.*backlog task create.*--append-/);
  for (const rule of QUOTING_RULES) assert.ok(quoting.body.includes(rule), `missing rule: ${rule}`);

  // The contract is always applied, so a condition it satisfies itself makes
  // the quoting rule announce itself in runs that write no command at all. It
  // did: the placeholder in "backlog task edit <id> -s" matched (BCC-8).
  const condition = new RegExp(quoting.fields.condition.replace(/^"|"$/g, ""));
  assert.doesNotMatch(contract.body, condition, "the contract triggers the quoting rule");
  // Still fires on the real thing.
  for (const command of ["backlog task edit BCC-1 --check-ac 1", "backlog task create 'Title' --ac 'One'"]) {
    assert.match(command, condition, `condition no longer matches: ${command}`);
  }
});

// alwaysApply carries this file into every prompt of every project, including
// the ones that have no Backlog.md at all, so its size is a running cost.
test("the always-applied contract rule stays under 1000 bytes", () => {
  const bytes = Buffer.byteLength(read(join("rules", "backlog-md-contract.md")), "utf8");
  assert.ok(bytes < 1000, `contract rule is ${bytes} bytes`);
});

// Verbatim, not paraphrased. A paraphrase is how the three hazards turn into
// two.
test("the skill carries all three quoting rules verbatim", () => {
  const text = read(join("skills", "backlog-workflow", "SKILL.md"));
  for (const rule of QUOTING_RULES) assert.ok(text.includes(rule), `missing rule: ${rule}`);
});

// The namespace is the plugin name. `/backlog:` was the first draft's mistake
// and would resolve to nothing.
test("no prompt file references the wrong command namespace", () => {
  for (const rel of promptFiles()) {
    assert.ok(!/\/backlog:/.test(read(rel)), `${rel}: uses /backlog: instead of /backlog-md:`);
  }
});

// The plugin tells agents never to use ANSI-C quoting; shipping an example of
// it would be the instruction contradicting itself.
test("no prompt file demonstrates the quoting it forbids", () => {
  for (const rel of promptFiles()) {
    const body = read(rel).replace(/`\$'a\\nb'`/g, ""); // the rule text itself may name it
    assert.ok(!/\$'[^']*\\n/.test(body), `${rel}: contains ANSI-C quoting`);
  }
});

const AGENTS = ["backlog-decomposer", "backlog-planner", "backlog-verifier"];
const agentPath = (name) => join("agents", `${name}.md`);

test("all three agents exist", () => {
  for (const name of AGENTS) assert.ok(promptFiles().includes(agentPath(name)), `missing agent: ${name}`);
});
test("every agent declares the stable name OMP requires", () => {
  for (const name of AGENTS) {
    assert.equal(frontmatter(read(agentPath(name))).fields.name, name);
  }
});

// Read-only on source. The tools line is the mechanical half of that; the
// prose is the rest, because Bash cannot be withheld from an agent that has
// to run tests to gather evidence.
test("no agent is granted a file-writing tool", () => {
  for (const name of AGENTS) {
    const { fields } = frontmatter(read(agentPath(name)));
    assert.ok(fields.tools, `${name}: no tools line, so it inherits everything including Write`);
    const tools = fields.tools.split(",").map((t) => t.trim());
    for (const forbidden of ["Write", "Edit", "NotebookEdit"]) {
      assert.ok(!tools.includes(forbidden), `${name}: granted ${forbidden}`);
    }
  }
});

test("every agent can read, search and run commands", () => {
  for (const name of AGENTS) {
    const tools = frontmatter(read(agentPath(name))).fields.tools;
    for (const needed of ["Read", "Grep", "Glob", "Bash"]) {
      assert.ok(tools.includes(needed), `${name}: missing ${needed}`);
    }
  }
});

test("every agent carries all three quoting rules verbatim", () => {
  for (const name of AGENTS) {
    const text = read(agentPath(name));
    for (const rule of QUOTING_RULES) assert.ok(text.includes(rule), `${name}: missing rule: ${rule}`);
  }
});

// The sentence that keeps the review checkpoint alive. If it goes missing, the
// agent is one plausible-looking step away from closing tasks by itself.
test("every agent is told in prose that it must not mutate the backlog", () => {
  for (const name of AGENTS) {
    const text = read(agentPath(name));
    assert.match(
      text,
      /never (run|use|call)[^.]*\bbacklog (task|draft|milestone|doc|decision) (edit|create)/i,
      `${name}: no explicit no-mutation clause`,
    );
  }
});

// "One per line, each independently checkable" was satisfied by a criterion
// carrying eight requirements on one line — one checkbox that could not record
// that six of them held, and evidence that ran to a paragraph (BCC-8).
test("the decomposer is told one assertion per criterion, not one line per criterion", () => {
  const body = frontmatter(read(agentPath("backlog-decomposer"))).body.replace(/\s+/g, " ");
  assert.match(body, /One assertion each/i);
  assert.match(body, /needs an "and" is two criteria/i);
});

const COMMANDS = ["doctor", "next", "start", "decompose", "plan", "verify", "finish", "setup"];

test("all eight commands exist", () => {
  const files = promptFiles();
  for (const name of COMMANDS) {
    assert.ok(files.includes(join("commands", `${name}.md`)), `missing command: ${name}`);
  }
});

// A command that hard-codes a path instead of using CLAUDE_PLUGIN_ROOT works
// only on the author's machine.
test("commands address plugin files through CLAUDE_PLUGIN_ROOT", () => {
  for (const name of COMMANDS) {
    const text = read(join("commands", `${name}.md`));
    for (const line of text.split("\n")) {
      if (line.includes("backlog-cc.mjs")) {
        assert.match(line, /\$\{CLAUDE_PLUGIN_ROOT\}/, `${name}: ${line.trim()}`);
      }
    }
  }
});

test("command wrappers honor BACKLOG_MD_NODE for hosts without node on PATH", () => {
  for (const name of COMMANDS) {
    const text = read(join("commands", `${name}.md`));
    for (const line of text.split("\n")) {
      if (line.includes("backlog-cc.mjs")) {
        assert.match(line, /\$\{BACKLOG_MD_NODE:-node\}/, `${name}: ${line.trim()}`);
      }
    }
  }
});

// Naming a state is not covering it: the first version of this test passed on
// a start.md that listed all five states and prescribed nothing for two of
// them. The bullet is found by its backticked state name, because matching
// bare prose selected the wrong bullet — "ambiguous" also appears inside the
// status/branch one — so the state names are asserted to be backticked exactly
// once first, or `find` would silently take the wrong block.
test("start says what to do in each state, not merely that the state exists", () => {
  const text = read(join("commands", "start.md"));
  const STATES = ["status", "branch", "ambiguous", "none", "unavailable"];
  for (const state of STATES) {
    const hits = text.split(`\`${state}\``).length - 1;
    assert.equal(hits, 1, `start.md mentions \`${state}\` ${hits} times; the block lookup below would pick the first`);
  }
  const required = {
    unavailable: [/\bstop\b/i, /\/backlog-md:doctor/],
    ambiguous: [/\bask\b/i],
    none: [/\bstart\b|\bproceed\b/i],
  };
  for (const [state, patterns] of Object.entries(required)) {
    const block = text.split(/\n(?=\s*[-*]\s)|\n\n/).find((b) => b.includes(`\`${state}\``)) || "";
    assert.ok(block, `start.md never mentions the ${state} state`);
    for (const pattern of patterns) {
      assert.match(block, pattern, `start.md mentions ${state} but does not say what to do about it (${pattern})`);
    }
  }
});

// next.md must route through start rather than reimplementing its checks. The
// mechanical regression is an inlined CLI call; the paraphrase that actually
// shipped once was describing start's internals instead of delegating.
test("next does not set a status itself — it routes through start's checks", () => {
  const text = read(join("commands", "next.md"));
  assert.match(text, /\/backlog-md:start/);
  assert.ok(
    !/-s ["']In Progress["']|task edit/.test(text),
    "next.md sets a status directly, bypassing start's already-running check",
  );
  assert.ok(!/set\s+the\s+status/i.test(text), "next.md describes start's internals instead of delegating to it");
});

// Every command that dispatches an agent must name an agent that exists.
// Matched by how commands actually name one — "the `<name>` agent" — not by
// guessing at a naming suffix: a prior version matched only names ending in
// "-er", so renaming an agent to e.g. `backlog-qa` slipped through unnoticed.
// `/backlog-md:<command>` is never mistaken for this: its backtick span
// starts with "/", not "backlog-", so the pattern below never matches it.
test("commands dispatch only agents this plugin ships", () => {
  const shipped = new Set(AGENTS);
  for (const name of COMMANDS) {
    const text = read(join("commands", `${name}.md`));
    for (const match of text.matchAll(/`(backlog-[a-z0-9-]+)`\s+agent\b/g)) {
      assert.ok(shipped.has(match[1]), `${name}: dispatches an agent this plugin does not ship: ${match[1]}`);
    }
  }
});

// A dispatch a host refuses is not a rare edge: an OMP session rejected the
// same call ten times and never produced a decomposition (BCC-2). Each command
// that dispatches an agent therefore has to bound the retries and name the
// inline fallback, which is the agent's own prompt file.
// "Retry once and no more" was written for a host with no subagents, and read
// as a ceiling on every kind of failure: one host rejected the dispatch three
// times over the shape of the arguments and took the fourth, which the rule
// would have abandoned after the second for nothing (BCC-8).
test("every command that dispatches an agent bounds the retries and falls back inline", () => {
  for (const name of COMMANDS) {
    const text = read(join("commands", `${name}.md`));
    const dispatched = [...text.matchAll(/\*\*Dispatch the `(backlog-[a-z0-9-]+)` agent\*\*/g)].map((m) => m[1]);
    const flat = text.replace(/\s+/g, " ");
    for (const agent of dispatched) {
      assert.match(flat, /the same rejection twice ends it/i, `${name}: dispatches ${agent} with no retry ceiling`);
      assert.match(
        flat,
        /names what the call is missing.*fix it and send it again/i,
        `${name}: a rejected call shape must be fixed and resent, not counted against the ceiling`,
      );
      assert.ok(
        text.includes(`\${CLAUDE_PLUGIN_ROOT}/agents/${agent}.md`),
        `${name}: no inline fallback pointing at ${agent}.md`,
      );
    }
  }
});

// `backlog_task_create` has taken dependencies since 0.3.4, but the template
// still taught the CLI form; the quoting rule then redirected the model to the
// native tools and the graph fell out on the way. Thirteen tasks were created
// with the dependencies described in prose and recorded nowhere (BCC-5).
test("decompose creates through the native tool, with the CLI form as its fallback", () => {
  const text = read(join("commands", "decompose.md"));
  const nativeAt = text.indexOf("backlog_task_create");
  const cliAt = text.indexOf("backlog task create");
  assert.ok(nativeAt >= 0, "decompose.md never names backlog_task_create");
  assert.ok(cliAt < 0 || nativeAt < cliAt, "the CLI form must follow the native tool, as its fallback");
  for (const parameter of ["`dependencies`", "`milestone`", "`parent`"]) {
    assert.ok(text.includes(parameter), `decompose.md never names ${parameter}`);
  }
  // Read as if dependencies were mandatory, this page turned one proposed task
  // into three invented ones so the graph would have an edge, and then created
  // none of them (BCC-6).
  assert.match(text, /waits for nothing leaves `dependencies` out/);
});

// Both halves of one run: the session surveyed the backlog itself, dispatched
// a scout agent of its own invention, then briefed the decomposer with the
// answer and the acceptance criteria it wanted — one of which no measurement
// could fail. Then it carried straight on into the implementation, so the task
// was started after the work and never planned (BCC-7).
test("decompose dispatches without a briefing and ends before the implementation", () => {
  const text = read(join("commands", "decompose.md"));
  const flat = text.replace(/\s+/g, " ");
  assert.match(flat, /verbatim and nothing else/);
  // "Do not survey the backlog or the code first" was in this file for the run
  // that opened with ten orientation commands. Naming them is the difference
  // between a rule about a category and a rule about `ls` (BCC-9).
  assert.match(flat, /this command's first tool call/);
  for (const command of ["`ls`", "`find`", "`grep`", "`backlog task list`"]) {
    assert.ok(flat.includes(`no ${command}`), `decompose.md never rules out ${command} before the dispatch`);
  }
  assert.match(flat, /nothing appended to the idea/);

  const endsAt = text.indexOf("Creating them is where this command ends");
  assert.ok(endsAt >= 0, "decompose.md never says where it ends");
  assert.ok(text.slice(endsAt).includes("/backlog-md:start"), "the exit must name the command that implements");
});

// The user approved "9 acceptance criteria" without seeing one of them, and
// the one that read "3-5 inhaltliche Hauptabschnitte" was later ticked over a
// post with six sections (BCC-9, edgemaker).
test("checkpoint 1 shows the criteria themselves, not how many there are", () => {
  const flat = read(join("commands", "decompose.md")).replace(/\s+/g, " ");
  const checkpointAt = flat.indexOf("this is checkpoint 1");
  assert.ok(checkpointAt >= 0, "decompose.md never names checkpoint 1");
  const checkpoint = flat.slice(checkpointAt, checkpointAt + 700);
  assert.match(checkpoint, /criteria out in full/, "checkpoint 1 must spell the criteria out");
  assert.match(checkpoint, /three tasks or fewer/, "the threshold that keeps a large decomposition readable");
});

// The review checkpoint: the gate sentence must precede the write it guards.
test("verify's gate instructs asking and waiting before any criterion is checked", () => {
  const text = read(join("commands", "verify.md"));
  const gateAt = text.search(/ask,?\s+and\s+wait\s+for\s+approval/i);
  assert.ok(gateAt >= 0, "verify.md: no explicit ask-and-wait gate sentence");
  const checkAt = text.indexOf("--check-ac");
  assert.ok(checkAt >= 0, "verify.md: no --check-ac invocation for the gate to guard");
  assert.ok(gateAt < checkAt, "verify.md: the ask-and-wait gate does not precede --check-ac");
});

// `<` and `>` are shell redirection. An example containing an angle-bracket
// placeholder does not fail loudly when run as shown — it silently redirects
// from a file named after the placeholder. `bash -n` accepts it, so only this
// kind of check catches it. Scanned across every fenced block regardless of
// language tag (or none) — a placeholder is just as broken in a `console` or
// untagged fence as in a `bash` one. The break only needs the opening `<`
// followed by a letter or underscore — `<TASK_ID`, `<id123` and `<your idea`
// all redirect just as unterminated `<id` does; the closing `>` is not
// required. `(?<!<)` keeps a heredoc's `<<EOF` from matching on its second `<`.
test("no runnable example uses an angle-bracket placeholder", () => {
  for (const rel of promptFiles()) {
    for (const [, block] of read(rel).matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
      assert.ok(
        !/(?<!<)<[a-z_]/i.test(block),
        `${rel}: a fenced example contains an angle-bracket placeholder — < is shell redirection, so the line breaks when run as shown`,
      );
    }
  }
});

// plan.md and verify.md both resolved the active task before doing anything;
// finish.md, the command that writes the most, jumped straight into its flow
// and left the agent to guess which task it was closing (BCC-22). What is
// pinned is the order — the resolution has to come before the first write in
// the file — plus a stop condition, because reading `ambiguous` and carrying
// on anyway is worse than never having asked.
test("every command that mutates a task resolves the active one before it writes", () => {
  for (const name of ["plan", "verify", "finish"]) {
    const text = read(join("commands", `${name}.md`));
    const activeAt = text.search(/backlog-cc\.mjs" active\b/);
    assert.ok(activeAt >= 0, `${name}: does not resolve the active task`);
    const writeAt = text.search(/backlog task edit\b/);
    assert.ok(writeAt >= 0, `${name}: no mutation for the resolution to guard`);
    assert.ok(activeAt < writeAt, `${name}: writes before it resolves the task`);
    assert.match(text, /\bstop\b/i, `${name}: no stop condition when the task is unresolved`);
  }
});
