#!/usr/bin/env node
import { readHookInput, emitAdditionalContext, emitPermissionDecision, guard } from "../lib/protocol.mjs";
import { evaluateToolGuard } from "../lib/integration.mjs";
import { notice } from "../lib/render.mjs";

// The plugin's only deny. Nothing becomes impossible, one thing becomes
// correct: the message carries the command to run instead.
//
// Fails open — a path this hook cannot positively identify as Backlog.md's is
// left alone. A guard that blocks when it cannot verify blocks real work.
guard(
  async () => {
    const input = await readHookInput();
    const result = evaluateToolGuard({
      cwd: input.cwd,
      toolName: input.tool_name,
      toolInput: input.tool_input,
      guard: process.env.BACKLOG_MD_GUARD,
      sessionId: input.session_id,
    });
    if (!result) return;

    if (!result.block) {
      emitAdditionalContext("PreToolUse", notice(`Warning, not blocked (BACKLOG_MD_GUARD=0):\n\n${result.reason}`));
      return;
    }

    emitPermissionDecision("PreToolUse", "deny", result.reason);
  },
  { event: "PreToolUse" },
);
