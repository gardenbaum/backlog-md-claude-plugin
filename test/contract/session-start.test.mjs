import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { run } from "../../lib/proc.mjs";
import { makeProject, backlogAvailable, parseHookOutput } from "../helpers/fixture.mjs";
import { FRAME_OPEN } from "../../lib/render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, "..", "..", "hooks", "session-start.mjs");

let available = false;
before(async () => {
  available = await backlogAvailable();
});

// Single-quote for the shell, escaping any embedded single quote. Node's own
// paths can legitimately contain spaces (e.g. under a user's Application
// Support directory), so every interpolated path is quoted, not just the payload.
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function feed(payload, cwd) {
  const json = JSON.stringify(payload);
  return run("/bin/sh", ["-c", `printf '%s' ${shQuote(json)} | ${shQuote(process.execPath)} ${shQuote(HOOK)}`], {
    cwd,
    timeoutMs: 10000,
  });
}

test("outside a Backlog.md project the hook is silent and exits 0", async () => {
  const empty = mkdtempSync(join(tmpdir(), "bcc-noproject-"));
  const r = await feed({ session_id: "s1", cwd: empty, source: "startup" }, empty);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("malformed stdin does not fail the hook", async () => {
  const empty = mkdtempSync(join(tmpdir(), "bcc-noproject-"));
  const r = await run("/bin/sh", ["-c", `printf 'garbage' | ${shQuote(process.execPath)} ${shQuote(HOOK)}`], {
    cwd: empty,
    timeoutMs: 10000,
  });
  assert.equal(r.code, 0);
});

// The two tests above only prove silence. Silence is also what a hook
// emitting the wrong shape would produce, so it does not by itself prove the
// envelope is right. This is the one place that resolves a real
// task through the real hook and checks the actual output.
test("a resolvable task produces the SessionStart envelope with the framed brief", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Contract check");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);

    const r = await feed({ session_id: "contract-session-start", cwd: p.root, source: "startup" }, p.root);
    assert.equal(r.code, 0);
    const parsed = parseHookOutput(r, "SessionStart");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes(FRAME_OPEN));
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes(id));
  } finally {
    p.cleanup();
  }
});

// The watchdog and the stdin read both exit 0 with no stdout, by design: the
// host must never be handed a broken payload. A bare `JSON.parse("")` of that
// silence blames the parser — "Unexpected end of JSON input" — which is the
// wrong diagnosis for the one situation that produces it under parallel load.
test("a hook starved of its budget is reported as a budget failure, not a JSON error", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Budget check");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);

    const json = JSON.stringify({ session_id: "contract-budget", cwd: p.root, source: "startup" });
    const command = `printf '%s' ${shQuote(json)} | BACKLOG_MD_TIMEOUT_SCALE=0.001 ${shQuote(process.execPath)} ${shQuote(HOOK)}`;
    const r = await run("/bin/sh", ["-c", command], { cwd: p.root, timeoutMs: 10000 });

    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "");
    assert.throws(() => parseHookOutput(r, "SessionStart"), /SessionStart produced no stdout/);
    assert.throws(() => parseHookOutput(r, "SessionStart"), /BACKLOG_MD_TIMEOUT_SCALE/);
  } finally {
    p.cleanup();
  }
});
