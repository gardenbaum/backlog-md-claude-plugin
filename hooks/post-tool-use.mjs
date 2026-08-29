#!/usr/bin/env node
import { readHookInput, guard } from "../lib/protocol.mjs";
import { recordToolActivity } from "../lib/integration.mjs";

// Emits nothing: the tool has already run. Remembers what happened and stays
// cheap — it fires on every edit, so it never spawns the backlog CLI.
//
// Append-only, never a read-modify-write of the snapshot: Claude Code
// dispatches tool calls in parallel and that pattern loses updates (measured:
// 3-4 of 6 concurrent edits landed).
guard(
  async () => {
    const input = await readHookInput();
    await recordToolActivity({
      cwd: input.cwd,
      sessionId: input.session_id,
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolDetails: input.tool_response,
      isError: false,
    });
  },
  { event: "PostToolUse" },
);
