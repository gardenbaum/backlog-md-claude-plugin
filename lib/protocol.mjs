import { basename } from "node:path";
import { debugLog } from "./cache.mjs";
import { scaledTimeout } from "./proc.mjs";

/**
 * Read the hook payload from stdin.
 *
 * Always resolves. A hook that waits forever on stdin would freeze the session,
 * so the read is bounded and any problem yields an empty object.
 */
export async function readHookInput({ timeoutMs = 1000 } = {}) {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  const timer = setTimeout(() => process.stdin.destroy(), scaledTimeout(timeoutMs));
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
    // destroyed by the watchdog, or closed early
  }
  clearTimeout(timer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8").trim() || "{}");
  } catch {
    return {};
  }
}

/** Emit the context envelope. Shape verified against a production plugin. */
export function emitAdditionalContext(hookEventName, additionalContext) {
  if (!additionalContext) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }) + "\n");
}

/**
 * Emit a permission decision. The field is `permissionDecisionReason`; a plain
 * `reason` key is wrong, not redundant. A deny whose explanation is dropped
 * leaves the agent blocked and mute, so a falsy reason emits nothing at all.
 */
export function emitPermissionDecision(hookEventName, permissionDecision, permissionDecisionReason) {
  if (permissionDecision === "deny" && !permissionDecisionReason) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason },
    }) + "\n",
  );
}

/**
 * Run a hook body so it can never cost the user a session. Errors are
 * swallowed; a watchdog force-exits on a hang, which `try/catch` cannot catch.
 * With `BACKLOG_MD_DEBUG` set, both land in the debug log — the only way to
 * see an exception this function exists to hide.
 *
 * @param {() => any} main
 * @param {{ hardTimeoutMs?: number, event?: string }} [options]
 */
export function guard(main, { hardTimeoutMs = 5000, event } = {}) {
  const started = Date.now();
  const hook = basename(process.argv[1] || "unknown");
  const timeoutMs = scaledTimeout(hardTimeoutMs);
  const watchdog = setTimeout(() => {
    debugLog({
      hook,
      event,
      ms: Date.now() - started,
      ok: false,
      watchdog: true,
      message: `watchdog timeout after ${timeoutMs}ms`,
      stack: null,
    });
    process.exit(0);
  }, timeoutMs);
  watchdog.unref();
  Promise.resolve()
    .then(main)
    .then(
      () => debugLog({ hook, event, ms: Date.now() - started, ok: true }),
      (error) =>
        debugLog({
          hook,
          event,
          ms: Date.now() - started,
          ok: false,
          message: String(error?.message ?? error),
          stack: error?.stack ?? null,
        }),
    )
    .finally(() => clearTimeout(watchdog));
}
