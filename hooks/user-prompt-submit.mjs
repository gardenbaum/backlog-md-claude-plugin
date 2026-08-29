#!/usr/bin/env node
import { readHookInput, emitAdditionalContext, guard } from "../lib/protocol.mjs";
import { promptContext } from "../lib/integration.mjs";

// Never blocks, never decides. Turning the human's own prompt away would be
// overreach, so this hook only ever adds context.
guard(
  async () => {
    const input = await readHookInput();
    const context = await promptContext({
      cwd: input.cwd,
      sessionId: input.session_id,
      prompt: input.prompt,
    });
    emitAdditionalContext("UserPromptSubmit", context);
  },
  { event: "UserPromptSubmit" },
);
