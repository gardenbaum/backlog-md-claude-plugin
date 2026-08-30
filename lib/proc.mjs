import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 3000;

const POSIX = process.platform !== "win32";

/** Node command used by detached plugin workers and command templates. */
export function workerNodeExecutable(env = process.env, fallback = "node") {
  const configured = typeof env.BACKLOG_MD_NODE === "string" ? env.BACKLOG_MD_NODE.trim() : "";
  return configured || fallback;
}

/**
 * Spawn a subprocess and collect its output.
 *
 * Never throws and never rejects: every failure is reported as a `reason`.
 * The child's stdin is ignored so a CLI that tries to prompt cannot hang us,
 * and a hard timeout kills the child, because a hang is not an exception and
 * `try/catch` would not catch it.
 *
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {import("./types.mjs").ProcOptions} [options]
 * @returns {Promise<import("./types.mjs").ProcResult>}
 */
export async function run(cmd, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env = process.env } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    const timer = setTimeout(() => {
      // The whole group, not just the direct child: a forked grandchild
      // outlives a SIGKILL aimed at its parent. `detached` below makes the
      // child a group leader, so the negated pid addresses the group. No
      // SIGTERM grace period — the hook's budget has already elapsed and none
      // of these children own state worth flushing.
      try {
        if (POSIX && child?.pid) process.kill(-child.pid, "SIGKILL");
        else child?.kill("SIGKILL");
      } catch {
        try {
          child?.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      finish({ ok: false, reason: "timeout", stdout, stderr, code: null });
    }, timeoutMs);

    try {
      // detached only on POSIX: on Windows it means "own console window", not
      // "own process group", so the behaviour there is deliberately unchanged.
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: POSIX });
    } catch {
      return finish({ ok: false, reason: "spawn-failed", stdout, stderr, code: null });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", () => finish({ ok: false, reason: "spawn-failed", stdout, stderr, code: null }));
    child.on("close", (code) => {
      finish(
        code === 0
          ? { ok: true, reason: null, stdout, stderr, code }
          : { ok: false, reason: "exit-nonzero", stdout, stderr, code },
      );
    });
  });
}
