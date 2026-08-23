import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeProject, backlogAvailable } from "../helpers/fixture.mjs";
import { run } from "../../lib/proc.mjs";
import { writeCache, readCache, appendEvent, deriveSession } from "../../lib/cache.mjs";
import { FRAME_OPEN, NOTICE_OPEN } from "../../lib/render.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "user-prompt-submit.mjs");

function shQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`;
}

// sourceEdits, stale and identity now live in the append-only journal, not
// the snapshot writeCache/readCache address — seed the scenario there.
function seedEdits(root, sessionId, n) {
  for (let i = 0; i < n; i++) appendEvent(root, sessionId, { t: "edit", p: `src/f${i}.ts` });
}

async function feed(payload, cwd, extraPath) {
  const path = extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH;
  return run(
    "/bin/sh",
    [
      "-c",
      `printf %s ${shQuote(JSON.stringify(payload))} | PATH=${shQuote(path)} ${shQuote(process.execPath)} ${shQuote(HOOK)}`,
    ],
    { cwd, timeoutMs: 30000 },
  );
}

/**
 * A stand-in `backlog` binary that never returns, to prove a timeout fires.
 * A single hanging node process, not a shell script wrapping `sleep`: a
 * shell script forks `sleep` as a child of its own, and that grandchild
 * outlives a SIGKILL sent to the shell, keeping the stdout/stderr pipes
 * open and hanging the whole test. One process with nothing to fork dies
 * cleanly on SIGKILL.
 */
function hangingBacklogOnPath() {
  const dir = mkdtempSync(join(tmpdir(), "bcc-fakebin-"));
  const script = join(dir, "backlog");
  writeFileSync(script, "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n");
  chmodSync(script, 0o755);
  return dir;
}

let available = false;
before(async () => {
  available = await backlogAvailable();
});

test("the hook never blocks and never emits a permission decision", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const r = await feed({ session_id: "s1", cwd: p.root, prompt: "implement the thing" }, p.root);
    assert.equal(r.code, 0);
    if (r.stdout.trim()) {
      const parsed = JSON.parse(r.stdout);
      assert.ok(!("permissionDecision" in parsed.hookSpecificOutput), "UserPromptSubmit must never decide");
      assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    }
  } finally {
    p.cleanup();
  }
});

test("a task id in the prompt injects that task's compact brief, once", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Mentioned elsewhere");
    const payload = { session_id: "s2", cwd: p.root, prompt: `have a look at ${id} please` };

    const first = await feed(payload, p.root);
    const parsed = JSON.parse(first.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes(FRAME_OPEN));
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes(id));
    assert.deepEqual(readCache(p.root, "s2").injectedTasks, [id]);

    const second = await feed(payload, p.root);
    assert.equal(second.stdout.trim(), "", "the same task is not injected twice in one session");
  } finally {
    p.cleanup();
  }
});

test("observations appear once the session has edited source", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Has criteria", ["--ac", "must work"]);
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    writeCache(p.root, "s3", { taskId: id });
    seedEdits(p.root, "s3", 4);

    const r = await feed({ session_id: "s3", cwd: p.root, prompt: "carry on" }, p.root);
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /acceptance criteria 1 (is|are) unchecked/);
    assert.match(context, /file:line/i);
    assert.ok(context.includes(NOTICE_OPEN), "observations are the plugin's own sentences, not contributor prose");
    assert.ok(!context.includes(FRAME_OPEN));
  } finally {
    p.cleanup();
  }
});

test("no observations before any source edit", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Has criteria", ["--ac", "must work"]);
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    writeCache(p.root, "s4", { taskId: id }); // no journal at all — sourceEdits derives to 0

    const r = await feed({ session_id: "s4", cwd: p.root, prompt: "carry on" }, p.root);
    assert.equal(r.stdout.trim(), "");
  } finally {
    p.cleanup();
  }
});

test("stale survives a run where identity was never re-derived (sourceEdits stays at 0)", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Something");
    writeCache(p.root, "s5", { taskId: id });
    appendEvent(p.root, "s5", { t: "stale" }); // sourceEdits stays 0 — no edit events

    const r = await feed({ session_id: "s5", cwd: p.root, prompt: "carry on" }, p.root);
    assert.equal(r.code, 0);
    assert.equal(
      deriveSession(p.root, "s5").stale,
      true,
      "a run that skipped the observation block never re-derived identity, so it may not clear the flag",
    );
  } finally {
    p.cleanup();
  }
});

test("stale clears and the cached taskId is refreshed once identity is re-derived", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Now active");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    // The cached id deliberately does not match the real active task, so a
    // pass only if the hook actually re-derived it rather than trusting it.
    writeCache(p.root, "s6", { taskId: "ZZZQ-999" });
    appendEvent(p.root, "s6", { t: "stale" });
    seedEdits(p.root, "s6", 3);

    const r = await feed({ session_id: "s6", cwd: p.root, prompt: "carry on" }, p.root);
    assert.equal(r.code, 0);
    const derived = deriveSession(p.root, "s6");
    assert.equal(derived.stale, false, "identity was re-derived, so the suspicion is resolved");
    assert.equal(derived.taskId, id, "the freshly re-derived id must be the task actually found active");
  } finally {
    p.cleanup();
  }
});

test("without a stale flag, the cached taskId is trusted directly and stale is left untouched", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Has criteria", ["--ac", "must work"]);
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    writeCache(p.root, "s7", { taskId: id });
    seedEdits(p.root, "s7", 4); // no `stale` event at all

    const r = await feed({ session_id: "s7", cwd: p.root, prompt: "carry on" }, p.root);
    assert.equal(r.code, 0);
    assert.equal(readCache(p.root, "s7").taskId, id, "the cached id is trusted directly, not re-derived");
    assert.equal(
      deriveSession(p.root, "s7").stale,
      false,
      "this branch never re-derives identity, so it never appends a stale or identity event",
    );
  } finally {
    p.cleanup();
  }
});

test("an unresolvable cascade leaves stale and the cached taskId untouched", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    // Remove "In Progress" from the configured statuses so resolveActiveTask's
    // status-column step cannot proceed — it returns "unavailable"
    // (reason: no-in-progress-status) rather than a real resolution, the same
    // shape a transient CLI failure would take.
    const configPath = join(p.root, "backlog", "config.yml");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/statuses:.*$/m, 'statuses: ["To Do", "Done"]'));

    writeCache(p.root, "s8", { taskId: "BACK-7" });
    appendEvent(p.root, "s8", { t: "stale" });
    seedEdits(p.root, "s8", 5);
    const r = await feed({ session_id: "s8", cwd: p.root, prompt: "carry on" }, p.root);
    assert.equal(r.code, 0);
    assert.equal(deriveSession(p.root, "s8").stale, true, "a failed resolution must not clear the suspicion");
    assert.equal(
      readCache(p.root, "s8").taskId,
      "BACK-7",
      "a cached id that was probably still correct must survive a failed resolution",
    );
  } finally {
    p.cleanup();
  }
});

test("no cached id but a real active task: edits neither mislabel it as foreign nor trigger the no-task nudge", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Build the parser", ["--ac", "must work"]);
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    // No cached taskId at all — the state left behind when SessionStart
    // resolved "none" before the agent started the task, or ran before
    // SessionStart at all. This is the reachable state finding 1's bug
    // needed and no earlier fixture covered: taskId absent, edits present,
    // a real In Progress task, and a build-intent prompt naming that task.
    seedEdits(p.root, "s9", 2); // no taskId cached at all

    const r = await feed({ session_id: "s9", cwd: p.root, prompt: `now implement ${id}` }, p.root);
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      !/This is not the active task/.test(context),
      "the task the cascade actually finds active must not be presented as foreign",
    );
    assert.ok(
      !/no Backlog\.md task is active/.test(context),
      "a task was found active, so the no-task nudge must not fire",
    );
    assert.match(context, /acceptance criteria 1 (is|are) unchecked/, "observations must still run for the found task");
  } finally {
    p.cleanup();
  }
});

test("a stale journal identity naming a different task than the fresher cached snapshot does not label that task foreign", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Genuinely active", ["--ac", "must work"]);
    await p.cli(["task", "edit", id, "-s", "In Progress"]);
    // The journal's last `identity` event names an older task, as it would
    // after a `git checkout` onto a different task's branch mid-session: the
    // checkout is not a `backlog` mutation, so PostToolUse appends no `stale`
    // event to bridge the two stores. A later `SessionStart` — the one that
    // follows a compaction — then cached the real active task in the
    // snapshot, so `cachedTaskId` is fresher than
    // `derived.taskId` but neither store is marked stale.
    appendEvent(p.root, "s11", { t: "identity", id: "STALE-1" });
    writeCache(p.root, "s11", { taskId: id });
    seedEdits(p.root, "s11", 3); // no `stale` event: the trust-cached branch is taken

    const r = await feed({ session_id: "s11", cwd: p.root, prompt: `now review ${id}` }, p.root);
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      !/This is not the active task/.test(context),
      "the task actually fetched for observations must not also be labelled foreign",
    );
    assert.match(
      context,
      /acceptance criteria 1 (is|are) unchecked/,
      "observations must still run for the task the snapshot named",
    );
  } finally {
    p.cleanup();
  }
});

test("a speculative candidate lookup times out far short of the 3s default", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    // A cached active task and no edits means the identity block above the
    // candidate loop never runs (edits === 0 and cachedTaskId is set), so
    // only the candidate lookup itself can be slow here — isolating exactly
    // the timeout finding 6 tightened.
    writeCache(p.root, "s10", { taskId: "ACTIVE-1" });
    const fakeBinDir = hangingBacklogOnPath();

    const startedAt = Date.now();
    const r = await feed({ session_id: "s10", cwd: p.root, prompt: "look at FAKE-2 please" }, p.root, fakeBinDir);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(r.code, 0);
    assert.ok(
      elapsedMs < 2500,
      `candidate lookup must honour the tightened ~1s timeout, not the 3s default (took ${elapsedMs}ms)`,
    );
  } finally {
    p.cleanup();
  }
});

test("outside a project the hook is silent and exits 0", async () => {
  const r = await run("/bin/sh", ["-c", `printf '{}' | ${shQuote(process.execPath)} ${shQuote(HOOK)}`], {
    cwd: "/",
    timeoutMs: 10000,
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

/** A `backlog` on PATH that fails every call — resolution answers unavailable. */
function brokenBacklogOnPath(t) {
  const dir = mkdtempSync(join(tmpdir(), "bcc-broken-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "backlog"), '#!/bin/sh\necho "backlog: unreachable" >&2\nexit 1\n', { mode: 0o755 });
  chmodSync(join(dir, "backlog"), 0o755);
  return dir;
}

const NO_TASK_CLAIM = /no Backlog\.md task is active/;

// BCC-48. The three states below all left `activeId` falsy, and the gate read
// only that — so the nudge asserted "no task is active" for a project whose
// task was active, and for one where two were.
test("the nudge fires when the CLI positively reports an empty In Progress column", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    await p.createTask("Waiting in To Do");
    const r = await feed({ session_id: "n1", cwd: p.root, prompt: "implement the parser" }, p.root);
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, NO_TASK_CLAIM, "nothing is In Progress, so the nudge is the whole point");
  } finally {
    p.cleanup();
  }
});

// The measured case: a real In Progress task the plugin simply cannot read.
test("an unreachable CLI makes no claim about whether a task is active", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    const id = await p.createTask("Genuinely active");
    await p.cli(["task", "edit", id, "-s", "In Progress"]);

    const r = await feed(
      { session_id: "n2", cwd: p.root, prompt: "implement the parser" },
      p.root,
      brokenBacklogOnPath(t),
    );
    assert.equal(r.code, 0, "an unreachable CLI must not fail the hook");
    const context = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
    assert.ok(!NO_TASK_CLAIM.test(context), "claimed no task is active while one was");
    assert.ok(!/backlog task create/.test(context), "recommended a command that cannot run on this machine");
  } finally {
    p.cleanup();
  }
});

// The claim is wrong in the other direction here: two are active, not none.
// SessionStart already reports ambiguity with its candidates, so this stays
// silent rather than repeating it every turn.
test("an ambiguous In Progress column never produces the no-task claim", async (t) => {
  if (!available) return t.skip("backlog CLI not installed");
  const p = await makeProject();
  try {
    for (const title of ["First", "Second"]) {
      const id = await p.createTask(title);
      await p.cli(["task", "edit", id, "-s", "In Progress"]);
    }
    const r = await feed({ session_id: "n3", cwd: p.root, prompt: "implement the parser" }, p.root);
    const context = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
    assert.ok(!NO_TASK_CLAIM.test(context), "two tasks are active, so 'none is' is the wrong claim");
  } finally {
    p.cleanup();
  }
});
