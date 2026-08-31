import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../../lib/proc.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const LIB = join(here, "..", "..", "lib", "protocol.mjs");

// The protocol is exercised by running small scripts as real child processes,
// because stdin handling and exit behaviour cannot be tested in-process.
function scriptRunner(body) {
  const dir = mkdtempSync(join(tmpdir(), "bcc-proto-"));
  const file = join(dir, "probe.mjs");
  writeFileSync(file, body.replace("__LIB__", JSON.stringify(pathToFileURL(LIB).href)));
  return file;
}

test("emitAdditionalContext prints the production-proven envelope", async () => {
  const probe = scriptRunner(`
    import { emitAdditionalContext } from __LIB__;
    emitAdditionalContext("SessionStart", "hello");
  `);
  const r = await run(process.execPath, [probe]);
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hello" },
  });
});

test("emitAdditionalContext prints nothing for empty context", async () => {
  const probe = scriptRunner(`
    import { emitAdditionalContext } from __LIB__;
    emitAdditionalContext("SessionStart", "");
    emitAdditionalContext("SessionStart", null);
  `);
  const r = await run(process.execPath, [probe]);
  assert.equal(r.stdout, "");
});

test("emitPermissionDecision uses permissionDecisionReason and never reason", async () => {
  const probe = scriptRunner(`
    import { emitPermissionDecision } from __LIB__;
    emitPermissionDecision("PreToolUse", "deny", "because");
  `);
  const r = await run(process.execPath, [probe]);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "because",
    },
  });
  assert.ok(!("reason" in parsed.hookSpecificOutput), "a `reason` key is wrong here, not merely redundant");
});

test("emitPermissionDecision prints nothing for a deny with no reason", async () => {
  const probe = scriptRunner(`
    import { emitPermissionDecision } from __LIB__;
    emitPermissionDecision("PreToolUse", "deny", "");
    emitPermissionDecision("PreToolUse", "deny", null);
    emitPermissionDecision("PreToolUse", "deny", undefined);
  `);
  const r = await run(process.execPath, [probe]);
  assert.equal(r.stdout, "", "a mute deny is worse than no decision at all");
});

test("readHookInput parses the piped JSON payload", async () => {
  const probe = scriptRunner(`
    import { readHookInput } from __LIB__;
    const input = await readHookInput();
    process.stdout.write(JSON.stringify({ got: input.session_id }));
  `);
  // A piped payload requires a shell; echo into the probe.
  const r = await run("/bin/sh", ["-c", `echo '{"session_id":"abc"}' | ${process.execPath} ${probe}`]);
  assert.deepEqual(JSON.parse(r.stdout), { got: "abc" });
});

test("readHookInput returns {} for malformed input instead of throwing", async () => {
  const probe = scriptRunner(`
    import { readHookInput } from __LIB__;
    const input = await readHookInput();
    process.stdout.write(JSON.stringify({ keys: Object.keys(input).length }));
  `);
  const r = await run("/bin/sh", ["-c", `echo 'not json' | ${process.execPath} ${probe}`]);
  assert.deepEqual(JSON.parse(r.stdout), { keys: 0 });
});

test("guard exits 0 even when main throws", async () => {
  const probe = scriptRunner(`
    import { guard } from __LIB__;
    guard(async () => { throw new Error("boom"); });
  `);
  const r = await run(process.execPath, [probe]);
  assert.equal(r.code, 0, "a throwing hook must never fail the session");
  assert.equal(r.stdout, "");
});

test("guard force-exits a hanging main", async () => {
  const probe = scriptRunner(`
    import { guard } from __LIB__;
    // A ref'd handle: without the watchdog this process would sit here for an
    // hour. This is what makes the test detect a missing watchdog at all —
    // an unref'd hang (e.g. \`await new Promise(() => {})\` alone) holds no
    // libuv handle, so Node exits on its own in ~1ms regardless of guard().
    setInterval(() => {}, 3_600_000);
    guard(async () => { await new Promise(() => {}); }, { hardTimeoutMs: 200 });
  `);
  const started = Date.now();
  const r = await run(process.execPath, [probe], { timeoutMs: 4000 });
  const elapsed = Date.now() - started;
  assert.equal(r.reason, null, "the watchdog should end the process, not our own timeout");
  assert.equal(r.code, 0);
  assert.ok(
    elapsed >= 150,
    `the watchdog was configured for 200ms but the process exited after ${elapsed}ms — it did not fire`,
  );
  assert.ok(elapsed < 2000, `expected the watchdog to end this, not our 4s timeout (${elapsed}ms)`);
});

test("guard records a watchdog timeout even though the hook protocol is silent", async () => {
  const state = mkdtempSync(join(tmpdir(), "bcc-watchdog-"));
  const probe = scriptRunner(`
    import { guard } from __LIB__;
    setInterval(() => {}, 3_600_000);
    guard(async () => { await new Promise(() => {}); }, { hardTimeoutMs: 100, event: "SessionStart" });
  `);
  const r = await run(process.execPath, [probe], {
    timeoutMs: 4000,
    env: { ...process.env, BACKLOG_MD_DEBUG: "1", XDG_STATE_HOME: state },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", "a timed-out hook cannot safely emit a partial protocol envelope");

  const entry = JSON.parse(readFileSync(join(state, "backlog-md-cc", "debug.jsonl"), "utf8").trim());
  assert.equal(entry.ok, false);
  assert.equal(entry.watchdog, true);
  assert.equal(entry.event, "SessionStart");
  assert.match(entry.message, /watchdog timeout/i);
});

// BACKLOG_MD_DEBUG is the second knob (BCC-6). guard() swallows every error by
// design, so without this there is no way to see the exception at all.
test("with BACKLOG_MD_DEBUG set, the swallowed error reaches the debug log", async () => {
  const state = mkdtempSync(join(tmpdir(), "bcc-debug-"));
  const probe = scriptRunner(`
    import { guard } from __LIB__;
    guard(async () => { throw new Error("boom"); }, { event: "SessionStart" });
  `);
  const r = await run(process.execPath, [probe], {
    env: { ...process.env, BACKLOG_MD_DEBUG: "1", XDG_STATE_HOME: state },
  });
  assert.equal(r.code, 0, "the knob must not change the exit code");
  assert.equal(r.stdout, "", "the debug path must never write to the protocol stream");

  const entry = JSON.parse(readFileSync(join(state, "backlog-md-cc", "debug.jsonl"), "utf8").trim());
  assert.equal(entry.ok, false);
  assert.equal(entry.hook, "probe.mjs");
  assert.equal(entry.event, "SessionStart");
  assert.match(entry.message, /boom/);
  assert.match(entry.stack, /Error: boom/);
  assert.equal(typeof entry.ms, "number");
});

test("with the knob unset, no log file is created at all", async () => {
  const state = mkdtempSync(join(tmpdir(), "bcc-nodebug-"));
  const probe = scriptRunner(`
    import { guard } from __LIB__;
    guard(async () => { throw new Error("boom"); }, { event: "SessionStart" });
  `);
  const env = { ...process.env, XDG_STATE_HOME: state };
  delete env.BACKLOG_MD_DEBUG;
  const r = await run(process.execPath, [probe], { env });
  assert.equal(r.code, 0);
  assert.equal(existsSync(join(state, "backlog-md-cc")), false, "the default path must not touch the state dir");
});

// The knob exists to help debugging; being able to break a hook would make it
// worse than no knob. XDG_STATE_HOME points at a regular file here, so the
// log directory cannot be created.
test("an unwritable debug log leaves the hook and its output intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bcc-debug-ro-"));
  const blocked = join(dir, "a-file-not-a-directory");
  writeFileSync(blocked, "");
  const probe = scriptRunner(`
    import { guard, emitAdditionalContext } from __LIB__;
    guard(async () => { emitAdditionalContext("SessionStart", "still here"); }, { event: "SessionStart" });
  `);
  const r = await run(process.execPath, [probe], {
    env: { ...process.env, BACKLOG_MD_DEBUG: "1", XDG_STATE_HOME: blocked },
  });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "still here" },
  });
});
