#!/usr/bin/env node
import { readHookInput, emitAdditionalContext, guard } from "../lib/protocol.mjs";
import { sessionContext, sweepSessions } from "../lib/integration.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

guard(
  async () => {
    const input = await readHookInput();
    const context = await sessionContext({
      cwd: input.cwd,
      sessionId: input.session_id,
      event: "SessionStart",
    });
    emitAdditionalContext("SessionStart", context);

    const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    sweepSessions({
      cwd: input.cwd,
      sessionId: input.session_id,
      source: input.source,
      pluginRoot,
      nodeExecutable: process.execPath,
    });
  },
  { event: "SessionStart" },
);
