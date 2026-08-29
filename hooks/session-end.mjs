#!/usr/bin/env node
import { readHookInput, guard } from "../lib/protocol.mjs";
import { flushSession } from "../lib/integration.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Hands the session's edited-file list to a detached child and returns.
// Emits nothing: there is no agent left to tell anything to.
//
// The flush used to run here inline. Claude Code aborts a hook still running
// while it shuts down, so its two CLI calls (449ms measured) reported
// `Hook cancelled` and never landed — the teardown arm, not a timeout, so no
// budget would have fixed it (BCC-46). Detached and never awaited, the same
// shape session-start.mjs uses for the sweep.
guard(
  async () => {
    const input = await readHookInput();
    const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    flushSession({
      cwd: input.cwd,
      sessionId: input.session_id,
      pluginRoot,
      nodeExecutable: process.execPath,
    });
  },
  { event: "SessionEnd" },
);
