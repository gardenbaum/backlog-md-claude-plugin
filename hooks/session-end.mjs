#!/usr/bin/env node
import { readHookInput, guard } from "../lib/protocol.mjs";
import { findProject } from "../lib/paths.mjs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
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
    const project = findProject(input.cwd || process.cwd());
    if (!project) return;

    const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "backlog-cc.mjs");
    spawn(process.execPath, [cli, "flush", String(input.session_id ?? "")], {
      cwd: project.root,
      detached: true,
      stdio: "ignore",
    }).unref();
  },
  { event: "SessionEnd" },
);
