#!/usr/bin/env node
import { readHookInput, emitAdditionalContext, emitPermissionDecision, guard } from "../lib/protocol.mjs";
import { findProject, classifyBacklogPath } from "../lib/paths.mjs";
import { denyReason } from "../lib/deny.mjs";
import { notice } from "../lib/render.mjs";

// The plugin's only deny. Nothing becomes impossible, one thing becomes
// correct: the message carries the command to run instead.
//
// Fails open — a path this hook cannot positively identify as Backlog.md's is
// left alone. A guard that blocks when it cannot verify blocks real work.
guard(
  async () => {
    const input = await readHookInput();
    const project = findProject(input.cwd || process.cwd());
    if (!project) return;

    const toolInput = input.tool_input || {};
    const target = toolInput.file_path || toolInput.notebook_path;
    if (!target) return;

    const classification = classifyBacklogPath(target, project);
    if (!classification.managed) return;

    const reason = denyReason(classification, toolInput);

    if (process.env.BACKLOG_MD_GUARD === "0") {
      // Plugin guidance addressed to the agent, so notice(), not frame().
      emitAdditionalContext("PreToolUse", notice(`Warning, not blocked (BACKLOG_MD_GUARD=0):\n\n${reason}`));
      return;
    }

    emitPermissionDecision("PreToolUse", "deny", reason);
  },
  { event: "PreToolUse" },
);
