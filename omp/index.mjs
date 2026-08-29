import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCommandTemplates, renderCommandTemplate } from "../lib/commands.mjs";
import {
  evaluateToolGuard,
  flushSession,
  promptContext,
  recordToolActivity,
  sessionContext,
  sweepSessions,
  toolTargetPaths,
} from "../lib/integration.mjs";
import { notice } from "../lib/render.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sessionId(ctx) {
  return String(ctx.sessionManager.getSessionId() ?? "");
}

function contextMessage(customType, content) {
  return {
    customType,
    content,
    display: false,
    attribution: "agent",
  };
}

export default function backlogMdExtension(pi) {
  const pendingPrompts = new Map();
  pi.setLabel("Backlog.md");

  const report = (operation, error) => {
    pi.logger.warn(`Backlog.md ${operation} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const sendSessionContext = async (eventName, ctx) => {
    try {
      const content = await sessionContext({
        cwd: ctx.cwd,
        sessionId: sessionId(ctx),
        event: eventName,
      });
      if (content) pi.sendMessage(contextMessage("backlog-md.context", content), { deliverAs: "nextTurn" });
    } catch (error) {
      report(eventName, error);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    pendingPrompts.clear();
    await sendSessionContext("OMP session_start", ctx);
    sweepSessions({
      cwd: ctx.cwd,
      sessionId: sessionId(ctx),
      pluginRoot,
      source: "resume",
      nodeExecutable: "node",
    });
  });

  for (const eventName of ["session_switch", "session_branch", "session_tree", "session_compact"]) {
    pi.on(eventName, async (_event, ctx) => {
      pendingPrompts.clear();
      await sendSessionContext(`OMP ${eventName}`, ctx);
    });
  }

  pi.on("input", (event, ctx) => {
    const id = sessionId(ctx);
    pendingPrompts.set(
      id,
      promptContext({ cwd: ctx.cwd, sessionId: id, prompt: event.text }).catch((error) => {
        report("prompt observation", error);
        return null;
      }),
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const id = sessionId(ctx);
    let pending = pendingPrompts.get(id);
    pendingPrompts.delete(id);
    if (!pending) {
      pending = promptContext({ cwd: ctx.cwd, sessionId: id, prompt: event.prompt }).catch((error) => {
        report("prompt observation", error);
        return null;
      });
    }
    const content = await pending;
    if (content) return { message: contextMessage("backlog-md.observation", content) };
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      const result = evaluateToolGuard({
        cwd: ctx.cwd,
        toolName: event.toolName,
        toolInput: event.input,
        guard: process.env.BACKLOG_MD_GUARD,
      });
      if (!result) return;
      if (result.block) return { block: true, reason: result.reason };

      pi.sendMessage(
        contextMessage(
          "backlog-md.guard-warning",
          notice(`Warning, not blocked (BACKLOG_MD_GUARD=0):\n\n${result.reason}`),
        ),
        { deliverAs: "nextTurn" },
      );
    } catch (error) {
      report("tool guard", error);
    }
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      const id = sessionId(ctx);
      const toolName = String(event.toolName).toLowerCase();
      const devicePath = event.input?.path;
      const resolution = event.details?.xdev?.inner;
      if (toolName === "write" && (devicePath === "xd://resolve" || devicePath === "xd://reject")) {
        if (
          !event.isError &&
          devicePath === "xd://resolve" &&
          resolution?.action === "apply" &&
          resolution?.sourceToolName === "ast_edit"
        ) {
          const targets = toolTargetPaths({}, resolution.sourceResultDetails);
          if (targets.length > 0) {
            recordToolActivity({
              cwd: ctx.cwd,
              sessionId: id,
              toolName: "write",
              toolInput: { files: targets },
            });
          }
        }
        return;
      }
      recordToolActivity({
        cwd: ctx.cwd,
        sessionId: id,
        toolName: event.toolName,
        toolInput: event.input,
        toolDetails: event.details,
        isError: event.isError,
      });
    } catch (error) {
      report("tool recording", error);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    flushSession({
      cwd: ctx.cwd,
      sessionId: sessionId(ctx),
      pluginRoot,
      nodeExecutable: "node",
    });
  });

  for (const template of loadCommandTemplates(pluginRoot)) {
    pi.registerCommand(`backlog-md:${template.name}`, {
      description: template.description,
      handler: async (args) => {
        pi.sendUserMessage(renderCommandTemplate(template, pluginRoot, args));
      },
    });
  }
}
