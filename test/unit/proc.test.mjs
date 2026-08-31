import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, scaledTimeout, workerNodeExecutable } from "../../lib/proc.mjs";

test("worker Node honors a non-empty BACKLOG_MD_NODE override", () => {
  assert.equal(workerNodeExecutable({ BACKLOG_MD_NODE: " /opt/node/bin/node " }), "/opt/node/bin/node");
  assert.equal(workerNodeExecutable({ BACKLOG_MD_NODE: " " }), "node");
  assert.equal(workerNodeExecutable({}, process.execPath), process.execPath);
});

test("timeout scale multiplies only valid positive environment values", () => {
  assert.equal(scaledTimeout(5000, {}), 5000);
  assert.equal(scaledTimeout(5000, { BACKLOG_MD_TIMEOUT_SCALE: "2.5" }), 12500);
  assert.equal(scaledTimeout(5000, { BACKLOG_MD_TIMEOUT_SCALE: "0" }), 5000);
  assert.equal(scaledTimeout(5000, { BACKLOG_MD_TIMEOUT_SCALE: "not-a-number" }), 5000);
});

test("run returns ok with stdout on success", async () => {
  const r = await run("node", ["-e", "process.stdout.write('hello')"]);
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.equal(r.stdout, "hello");
  assert.equal(r.code, 0);
});

test("run reports exit-nonzero and still captures stderr", async () => {
  const r = await run("node", ["-e", "process.stderr.write('boom'); process.exit(3)"]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "exit-nonzero");
  assert.equal(r.code, 3);
  assert.equal(r.stderr, "boom");
});

test("run reports spawn-failed for a missing binary", async () => {
  const r = await run("definitely-not-a-real-binary-xyzzy", []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "spawn-failed");
});

test("run kills the child that exceeds the timeout", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "bcc-kill-")), "pid");
  const started = Date.now();
  const r = await run(
    "node",
    ["-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 10000)`],
    { timeoutMs: 300 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timeout");
  assert.ok(Date.now() - started < 3000, "should return promptly, not wait for the child");

  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0, "the child must have recorded its pid");

  // SIGKILL delivery and reaping are not instantaneous, so poll rather than sleep.
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the child must be gone after run() reports a timeout");
});

test("run does not let a child read stdin", async () => {
  const r = await run("node", ["-e", "process.stdin.on('data', () => {}); process.stdout.write('nowait')"], {
    timeoutMs: 2000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, "nowait");
});

// run() used to kill only the direct child, so a grandchild survived the
// timeout and outlived the hook budget. The shell backgrounds another shell
// that sleeps and then writes a marker, so the sleeper is a grandchild of the
// process run() spawned; if the group kill misses it, the marker appears.
//
// Liveness is observed through that marker, not through kill(pid, 0): a killed
// grandchild is reparented to a container init that may never reap it, and
// kill(pid, 0) answers "alive" for a zombie — which is exactly how the first
// version of this test passed on macOS and failed on Linux CI (BCC-8).
test("a timeout kills the whole process group, not just the child", {
  skip: process.platform === "win32",
}, async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "bcc-group-")), "survivor");
  const r = await run("/bin/sh", ["-c", `sh -c 'sleep 1; echo alive > ${marker}' & wait`], { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timeout");

  // Comfortably past the grandchild's own sleep.
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(existsSync(marker), false, "the grandchild kept running after the timeout");
});
