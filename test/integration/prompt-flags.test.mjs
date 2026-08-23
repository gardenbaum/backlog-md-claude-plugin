import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run } from "../../lib/proc.mjs";
import { backlogAvailable } from "../helpers/fixture.mjs";
import { promptFiles } from "../helpers/prompts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does `flag` appear in `text` as its own token, not merely as a substring
 * of a longer one? `text.includes("-m")` is true for "--milestone" too —
 * any long flag "--Xyz" contains "-X" as a substring at position 1, so a
 * short flag that was never real still "passed" as long as the help text
 * happened to list some long flag starting with the same letter.
 */
function hasFlag(text, flag) {
  return new RegExp(`(?<![\\w-])${escapeRegExp(flag)}(?![\\w-])`).test(text);
}

/** A token that ends the subcommand path: a flag, a placeholder, or an id. */
const ENDS_PATH = (token) =>
  token.startsWith("-") || /[<>$'"|]/.test(token) || /^[A-Za-z]+-\d/.test(token) || /^\d+$/.test(token);

/** Every `backlog ...` invocation inside a code span or fenced block. */
export function invocations(text) {
  const found = [];
  // Tagged by source so the test below can floor each extraction path
  // separately (a4d9c1 review, finding 2) — losing one path silently must
  // not hide behind the other path's count.
  const chunks = [
    ...[...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => ({ source: "fenced", text: m[1] })),
    ...[...text.matchAll(/`([^`\n]+)`/g)].map((m) => ({ source: "inline", text: m[1] })),
  ];
  for (const { source, text: chunk } of chunks) {
    for (const line of chunk.split("\n")) {
      const match = line.match(/\bbacklog\s+(.*)$/);
      if (!match) continue;
      const tokens = match[1].split(/\s+/).filter(Boolean);
      const path = [];
      for (const token of tokens) {
        if (ENDS_PATH(token)) break;
        path.push(token);
      }
      const flags = tokens.filter((t) => /^-{1,2}[A-Za-z]/.test(t));
      if (path.length > 0 || flags.length > 0) found.push({ path, flags, line: line.trim(), source });
    }
  }
  return found;
}

test("every backlog flag named in a prompt exists in the installed CLI", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");

  const helpCache = new Map();
  const help = async (path) => {
    const key = path.join(" ");
    if (!helpCache.has(key)) {
      const r = await run("backlog", [...path, "--help"], { timeoutMs: 10000 });
      helpCache.set(key, r.ok ? `${r.stdout}\n${r.stderr}` : null);
    }
    return helpCache.get(key);
  };

  /**
   * commander resolves --help before validating the path, so exit 0 says
   * nothing about whether a subcommand exists — `backlog frobnicate --help`
   * exits 0 and prints the root help verbatim, and `backlog task frobnicate
   * --help` exits 0 and prints `task`'s help verbatim. Walk the path instead,
   * checking each segment against the commands its own parent lists. Reuses
   * the `help` cache above rather than spawning per segment per invocation.
   */
  // A leaf command (no "Commands:" section of its own — e.g. `instructions`,
  // which takes an optional positional `guide` like `overview`) cannot have
  // subcommand children, so a token after one is a positional argument, not
  // a further path segment. Without this, `backlog instructions overview`
  // (a real, valid invocation) is misread as an invented subcommand.
  const hasSubcommands = (helpText) => /^Commands:/m.test(helpText);

  const pathExists = async (path) => {
    for (let i = 0; i < path.length; i += 1) {
      const parent = await help(path.slice(0, i));
      if (parent === null) return false;
      if (!hasSubcommands(parent)) return true;
      if (!new RegExp(`^\\s+${path[i]}\\b`, "m").test(parent)) return false;
    }
    return true;
  };

  const failures = [];
  // Today: 16 flags checked from fenced blocks, 9 from inline code spans
  // (25 total). Floored separately, each with headroom below today's count,
  // so one extraction path silently going dark cannot hide behind the other
  // path's total — a combined floor alone would not catch inline dropping to
  // 0 while fenced still supplied 16.
  let checkedFenced = 0;
  let checkedInline = 0;
  /** @type {Set<string>} */
  const covered = new Set();
  for (const rel of promptFiles()) {
    for (const inv of invocations(readFileSync(join(root, rel), "utf8"))) {
      if (inv.path.length === 0) continue;
      if (!(await pathExists(inv.path))) {
        failures.push(`${rel}: no such subcommand: backlog ${inv.path.join(" ")} — ${inv.line}`);
        continue;
      }
      const text = await help(inv.path);
      for (const flag of inv.flags) {
        if (flag === "--help") continue;
        if (inv.source === "fenced") checkedFenced += 1;
        else checkedInline += 1;
        covered.add(flag);
        if (!hasFlag(text, flag)) failures.push(`${rel}: backlog ${inv.path.join(" ")} has no ${flag} — ${inv.line}`);
      }
    }
  }

  assert.deepEqual(failures, [], failures.join("\n"));
  // A parser that silently matched nothing would pass this test forever.
  assert.ok(
    checkedFenced > 10,
    `only ${checkedFenced} flags checked from fenced blocks — the extractor is probably broken`,
  );
  assert.ok(
    checkedInline > 5,
    `only ${checkedInline} flags checked from inline code spans — the extractor is probably broken`,
  );
  // BCC-41: the way back from a checked criterion is half the evidence-not-
  // ticks doctrine, and a prompt that stops naming --uncheck-ac loses it
  // silently — the counters above would not move enough to notice.
  assert.ok(covered.has("--uncheck-ac"), "no prompt names --uncheck-ac, so the downgrade path is undocumented");
});
