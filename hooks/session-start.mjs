#!/usr/bin/env node
import { readHookInput, emitAdditionalContext, guard } from "../lib/protocol.mjs";
import { buildBrief } from "../lib/brief.mjs";
import { findProject } from "../lib/paths.mjs";
import { includesSelf } from "../lib/session-sweep.mjs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

guard(
  async () => {
    const input = await readHookInput();
    const { context } = await buildBrief({
      cwd: input.cwd,
      sessionId: input.session_id,
      event: "SessionStart",
    });
    emitAdditionalContext("SessionStart", context);

    const project = findProject(input.cwd || process.cwd());
    if (!project) return;

    // Recovery for sessions that never ran SessionEnd (BCC-16, BCC-18).
    // Detached and never awaited: its two CLI calls measurably exceeded this
    // hook's five-second budget, and a session start must not wait on the
    // recovery of an older one anyway.
    const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "backlog-cc.mjs");
    const args = [cli, "sweep", String(input.session_id ?? "")];
    if (includesSelf(input.source)) args.push("--include-self");
    spawn(process.execPath, args, {
      cwd: project.root,
      detached: true,
      stdio: "ignore",
    }).unref();
  },
  { event: "SessionStart" },
);
