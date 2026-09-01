import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_NAMES, loadCommandTemplate, renderCommandTemplate } from "../lib/commands.mjs";
import { resolveActiveTask } from "../lib/active-task.mjs";
import { createRuntimeFailureState, deriveSession } from "../lib/cache.mjs";
import {
  evaluateToolGuard,
  promptContext,
  recordSessionMetric,
  recordToolActivity,
  sessionContext,
  spawnFlush,
  sweepSessions,
  toolTargetPaths,
} from "../lib/integration.mjs";
import { correctedBacklogCommand } from "../lib/quoting.mjs";
import { notice } from "../lib/render.mjs";
import { findProject } from "../lib/paths.mjs";
import { activateBacklogTools, registerBacklogTools } from "./tools.mjs";

const installedPluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sessionId(ctx) {
  try {
    return String(ctx?.sessionManager?.getSessionId?.() ?? "");
  } catch {
    return "";
  }
}

function hasSessionManager(ctx) {
  return typeof ctx?.sessionManager?.getSessionId === "function";
}
/**
 * @param {string} customType
 * @param {import("@oh-my-pi/pi-coding-agent").CustomMessageContent} content
 * @returns {import("@oh-my-pi/pi-coding-agent").CustomMessagePayload}
 */
function contextMessage(customType, content) {
  return {
    customType,
    content,
    display: false,
    attribution: "agent",
  };
}

/** Did this session touch Backlog.md at all — a native tool, a CLI mutation, or a task it resolved? */
function touchedBacklog(session) {
  return Boolean(session.taskId) || session.stale || Object.keys(session.metrics.toolCalls).length > 0;
}

/** Name the changed files, capped: the continuation is a nudge, not a diff. */
function listed(files, limit = 5) {
  const shown = files.slice(0, limit).join(", ");
  return files.length > limit ? `${shown} and ${files.length - limit} more` : shown;
}

function hasAstEditTargetMetadata(details) {
  return (
    details !== null &&
    typeof details === "object" &&
    (Object.hasOwn(details, "files") || Object.hasOwn(details, "fileReplacements"))
  );
}

/** @param {import("@oh-my-pi/pi-coding-agent").ExtensionAPI} pi */
export default function backlogMdExtension(
  pi,
  { pluginRoot = installedPluginRoot, diagnosticCwd = process.cwd() } = {},
) {
  const pendingPrompts = new Map();
  const acceptanceChecksBySession = new Set();
  const steeredTasksBySession = new Map();
  const continuedSessions = new Set();
  const latestSuccess = new Map();
  // This is a process-local ordering token, not a wall-clock timestamp. It is
  // seeded from Date.now(), then increments when events share a millisecond or
  // the clock moves backward. Persisted `startedAt` values compare only within
  // this extension instance, scope, and operation; `at` remains the display
  // timestamp. The token prevents an older async success from erasing a newer
  // failure.
  let latestAttemptStartedAt = 0;
  const attemptStartedAt = () => {
    latestAttemptStartedAt = Math.max(Date.now(), latestAttemptStartedAt + 1);
    return latestAttemptStartedAt;
  };

  const projectRootByCwd = new Map();
  const runtimeHealthByProjectRoot = new Map();
  const registrationContext = {
    cwd: diagnosticCwd,
    sessionManager: { getSessionId: () => "" },
  };

  const projectRootFor = (cwd) => {
    if (typeof cwd !== "string" || !cwd) return null;
    if (!projectRootByCwd.has(cwd)) projectRootByCwd.set(cwd, findProject(cwd)?.root ?? null);
    return projectRootByCwd.get(cwd);
  };

  const healthFor = (ctx, hydrate = false) => {
    const projectRoot = projectRootFor(ctx?.cwd);
    if (!projectRoot) return null;
    let health = runtimeHealthByProjectRoot.get(projectRoot);
    if (!health && hydrate) {
      health = createRuntimeFailureState(projectRoot);
      runtimeHealthByProjectRoot.set(projectRoot, health);
    }
    return health ?? null;
  };

  // Command and hook registration happen before session_start, so hydrate the
  // ambient project once here; each later session root hydrates at its start.
  healthFor(registrationContext, true);

  const report = (operation, error, ctx, startedAt = attemptStartedAt()) => {
    const scope = ctx ? sessionId(ctx) : "";
    const key = `${scope}\0${operation}`;
    const health = healthFor(ctx, true);
    if (health && (latestSuccess.get(key) ?? -Infinity) < startedAt) {
      health.record(operation, error, startedAt, scope);
    }
    try {
      pi.logger.warn(`Backlog.md ${operation} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // The bounded health state above is the diagnostic fallback.
    }
  };

  const clearFailure = (operation, ctx, startedAt) => {
    if (!ctx?.cwd) return;
    const scope = sessionId(ctx);
    const key = `${scope}\0${operation}`;
    latestSuccess.set(key, Math.max(latestSuccess.get(key) ?? -Infinity, startedAt));
    healthFor(ctx)?.clear(operation, startedAt, scope);
  };

  pi.setLabel("Backlog.md");
  const toolRegistrationStartedAt = attemptStartedAt();
  try {
    registerBacklogTools(pi);
    clearFailure("tool registration", registrationContext, toolRegistrationStartedAt);
  } catch (error) {
    report("tool registration", error, registrationContext, toolRegistrationStartedAt);
  }

  const observePrompt = (prompt, ctx, id) => {
    const startedAt = attemptStartedAt();
    return promptContext({ cwd: ctx.cwd, sessionId: id, prompt }).then(
      (content) => {
        clearFailure("prompt observation", ctx, startedAt);
        return content;
      },
      (error) => {
        report("prompt observation", error, ctx, startedAt);
        return null;
      },
    );
  };

  const sendSessionContext = async (eventName, ctx) => {
    const startedAt = attemptStartedAt();
    try {
      const content = await sessionContext({
        cwd: ctx.cwd,
        sessionId: sessionId(ctx),
        event: eventName,
      });
      if (content) pi.sendMessage(contextMessage("backlog-md.context", content), { deliverAs: "nextTurn" });
      clearFailure(eventName, ctx, startedAt);
    } catch (error) {
      report(eventName, error, ctx, startedAt);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    healthFor(ctx, true);
    const toolActivationStartedAt = attemptStartedAt();
    try {
      if (findProject(ctx.cwd)) await activateBacklogTools(pi);
      clearFailure("tool activation", ctx, toolActivationStartedAt);
    } catch (error) {
      report("tool activation", error, ctx, toolActivationStartedAt);
    }
    const supportsSessionManager = hasSessionManager(ctx);
    const id = sessionId(ctx);
    steeredTasksBySession.set(id, new Set());
    if (!supportsSessionManager) {
      report("OMP session manager contract", new Error("sessionManager.getSessionId is unavailable"), ctx);
    }
    pendingPrompts.clear();
    await sendSessionContext("OMP session_start", ctx);
    const startedAt = attemptStartedAt();
    // OMP's session_start begins a process even when it resumes the same
    // session id. Existing state under that id therefore belongs to the dead
    // predecessor and must bypass the abandoned-age threshold.
    sweepSessions({
      cwd: ctx.cwd,
      sessionId: id,
      pluginRoot,
      source: supportsSessionManager ? "resume" : "unknown",
      onError: (error) => report("session sweep worker", error, ctx, startedAt),
      onSpawn: () => clearFailure("session sweep worker", ctx, startedAt),
    });
  });

  const sendLifecycleContext = async (eventName, ctx) => {
    pendingPrompts.clear();
    await sendSessionContext(`OMP ${eventName}`, ctx);
  };
  pi.on("session_switch", async (_event, ctx) => sendLifecycleContext("session_switch", ctx));
  pi.on("session_branch", async (_event, ctx) => sendLifecycleContext("session_branch", ctx));
  pi.on("session_tree", async (_event, ctx) => sendLifecycleContext("session_tree", ctx));
  pi.on("session_compact", async (_event, ctx) => sendLifecycleContext("session_compact", ctx));

  pi.on("input", (event, ctx) => {
    const id = sessionId(ctx);
    pendingPrompts.set(id, {
      prompt: event.text,
      promise: observePrompt(event.text, ctx, id),
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const id = sessionId(ctx);
    const pending = pendingPrompts.get(id);
    pendingPrompts.delete(id);
    const observation = pending?.prompt === event.prompt ? pending.promise : observePrompt(event.prompt, ctx, id);
    const content = await observation;
    if (content) return { message: contextMessage("backlog-md.observation", content) };
  });

  pi.on("tool_call", (event, ctx) => {
    const toolName = String(event.toolName).toLowerCase();
    const command = event.input && typeof event.input === "object" ? Reflect.get(event.input, "command") : undefined;
    const directAcceptanceCheck =
      toolName === "bash" &&
      typeof command === "string" &&
      /\bbacklog\s+task\s+edit\b[\s\S]*\s--check-ac\b/.test(command);
    if (toolName === "backlog_check_ac" || directAcceptanceCheck) {
      acceptanceChecksBySession.add(sessionId(ctx));
      if (directAcceptanceCheck) {
        recordSessionMetric({ cwd: ctx.cwd, sessionId: sessionId(ctx), name: "acceptance-check" });
      }
    }
    const startedAt = attemptStartedAt();
    try {
      const corrected = toolName === "bash" && findProject(ctx.cwd) ? correctedBacklogCommand(command) : null;
      if (corrected) {
        recordSessionMetric({ cwd: ctx.cwd, sessionId: sessionId(ctx), name: "guard" });
        clearFailure("tool guard", ctx, startedAt);
        return {
          block: true,
          reason: `Unsafe shell quoting in a direct Backlog command. Use this corrected command:\n  ${corrected}`,
        };
      }
      const result = evaluateToolGuard({
        cwd: ctx.cwd,
        toolName: event.toolName,
        toolInput: event.input,
        guard: process.env.BACKLOG_MD_GUARD,
        sessionId: sessionId(ctx),
      });
      if (!result) {
        clearFailure("tool guard", ctx, startedAt);
        return;
      }
      if (result.block) {
        clearFailure("tool guard", ctx, startedAt);
        return { block: true, reason: result.reason };
      }

      pi.sendMessage(
        contextMessage(
          "backlog-md.guard-warning",
          notice(`Warning, not blocked (BACKLOG_MD_GUARD=0):\n\n${result.reason}`),
        ),
        { deliverAs: "nextTurn" },
      );
      clearFailure("tool guard", ctx, startedAt);
    } catch (error) {
      report("tool guard", error, ctx, startedAt);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const startedAt = attemptStartedAt();
    const id = sessionId(ctx);
    try {
      if (acceptanceChecksBySession.delete(id)) {
        clearFailure("acceptance steering", ctx, startedAt);
        return;
      }
      // `turn_end` fires after every LLM turn, not at the end of the exchange
      // with the user, so the first boundary after a task is started is also
      // the earliest — and the worst (BCC-3, measured). Naming open criteria
      // there is naming evidence for work that does not exist yet. Wait until
      // the session has edited something. `sourceEdits` rather than
      // `pendingModifiedFiles`, which resets once notes are written and would
      // silence the session that got furthest. It also spares the CLI
      // subprocess below on every turn of a session that has changed nothing.
      const project = findProject(ctx.cwd);
      const session = project ? deriveSession(project.root, id) : null;
      if (!session || session.sourceEdits === 0) {
        clearFailure("acceptance steering", ctx, startedAt);
        return;
      }
      const active = await resolveActiveTask({ cwd: ctx.cwd });
      if (!("task" in active) || !active.task.acceptanceCriteria?.some((criterion) => !criterion.checked)) {
        clearFailure("acceptance steering", ctx, startedAt);
        return;
      }
      const steered = steeredTasksBySession.get(id) ?? new Set();
      if (steered.has(active.task.id)) {
        clearFailure("acceptance steering", ctx, startedAt);
        return;
      }
      steered.add(active.task.id);
      steeredTasksBySession.set(id, steered);
      recordSessionMetric({ cwd: ctx.cwd, sessionId: id, name: "steering" });
      pi.sendMessage(
        contextMessage(
          "backlog-md.acceptance-steering",
          notice(
            `Task ${active.task.id} has unchecked acceptance criteria. Name evidence and run backlog_check_ac for each open criterion before finishing it.`,
          ),
        ),
        // Not `steer`: OMP cancels in-flight tool calls to deliver one, and the
        // model gets "Skipped due to pending system advisory" in place of the
        // result it was waiting for. Measured cost was a research call thrown
        // away mid-session. `nextTurn` queues the same text, like the guard
        // warning above.
        { deliverAs: "nextTurn" },
      );
      clearFailure("acceptance steering", ctx, startedAt);
    } catch (error) {
      report("acceptance steering", error, ctx, startedAt);
    }
  });

  // The other half of the acceptance steering above, and the half that does
  // not depend on the model having read a rule: `turn_end` steers a task that
  // was started and left open, this steers work for which no task was ever
  // created. Both were measured: a session that finds no matching task drops
  // out of the workflow entirely and plans in the host's todo list instead.
  //
  // One continuation per session, ours, not the host's — its budget is eight,
  // and leaning on it would push the model onward eight times over. And never
  // `decision: "block"`: ending a session without a task stays the user's call.
  pi.on("session_stop", async (_event, ctx) => {
    const startedAt = attemptStartedAt();
    const id = sessionId(ctx);
    try {
      const project = continuedSessions.has(id) ? null : findProject(ctx.cwd);
      const session = project ? deriveSession(project.root, id) : null;
      // Two sessions that must never be held open: one that changed nothing,
      // and one that already worked through Backlog.md — a task finished
      // properly leaves no active task behind either, and asking that session
      // for a second one would punish the workflow it just followed.
      if (!session || session.pendingModifiedFiles.length === 0 || touchedBacklog(session)) {
        clearFailure("taskless continuation", ctx, startedAt);
        return;
      }
      const active = await resolveActiveTask({ cwd: ctx.cwd });
      if ("task" in active) {
        clearFailure("taskless continuation", ctx, startedAt);
        return;
      }
      continuedSessions.add(id);
      recordSessionMetric({ cwd: ctx.cwd, sessionId: id, name: "taskless-continue" });
      clearFailure("taskless continuation", ctx, startedAt);
      return {
        continue: true,
        additionalContext: notice(
          `This session changed ${listed(session.pendingModifiedFiles)} outside backlog/, and no Backlog.md task ` +
            "covers that work. " +
            "Create one with backlog_task_create, then record what you did in it before finishing.",
        ),
      };
    } catch (error) {
      report("taskless continuation", error, ctx, startedAt);
    }
  });

  pi.on("tool_result", (event, ctx) => {
    const startedAt = attemptStartedAt();
    try {
      const id = sessionId(ctx);
      const toolName = String(event.toolName).toLowerCase();
      const devicePath = event.input?.path;
      const xdevDetails = /** @type {{ xdev?: { inner?: Record<string, unknown> } } | undefined} */ (event.details);
      const resolution = xdevDetails?.xdev?.inner;
      if (toolName === "write" && (devicePath === "xd://resolve" || devicePath === "xd://reject")) {
        if (resolution?.sourceToolName !== "ast_edit") return;
        const expectedAction = devicePath === "xd://resolve" ? "apply" : "discard";
        if (!event.isError && resolution.action !== expectedAction) {
          throw new Error(`unexpected ${devicePath} ast_edit resolution metadata`);
        }
        if (!event.isError && devicePath === "xd://resolve") {
          if (!hasAstEditTargetMetadata(resolution.sourceResultDetails)) {
            throw new Error("ast_edit resolution did not report changed-file metadata");
          }
          const targets = toolTargetPaths({}, resolution.sourceResultDetails);
          if (targets.length > 0) {
            recordToolActivity({
              cwd: ctx.cwd,
              sessionId: id,
              toolName: "write",
              toolInput: { files: targets },
              toolDetails: resolution.sourceResultDetails,
            });
          }
        }
        clearFailure("tool recording", ctx, startedAt);
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
      clearFailure("tool recording", ctx, startedAt);
    } catch (error) {
      report("tool recording", error, ctx, startedAt);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const startedAt = attemptStartedAt();
    const id = sessionId(ctx);
    try {
      const active = await resolveActiveTask({ cwd: ctx.cwd });
      if ("task" in active) {
        recordSessionMetric({ cwd: ctx.cwd, sessionId: id, name: "unfinished-session" });
      }
      await spawnFlush({
        cwd: ctx.cwd,
        sessionId: id,
        pluginRoot,
        onError: (error) => report("session flush worker", error, ctx, startedAt),
        onSpawn: () => clearFailure("session flush worker", ctx, startedAt),
        onSummary: (error) =>
          error ? report("session summary", error, ctx, startedAt) : clearFailure("session summary", ctx, startedAt),
      });
    } catch (error) {
      report("session shutdown", error, ctx, startedAt);
    }
  });

  // OMP dispatches extension commands before file commands, so these handlers
  // are the one effective implementation even though its Claude-plugin
  // compatibility provider also discovers commands/*.md from the package.
  for (const name of COMMAND_NAMES) {
    const startedAt = attemptStartedAt();
    try {
      const template = loadCommandTemplate(pluginRoot, name);
      pi.registerCommand(`backlog-md:${template.name}`, {
        // Both entries carry the same name in the picker; the suffix is what
        // tells the reader which of the two rows is the one that runs.
        description: `${template.description} (native)`,
        handler: async (args) => {
          pi.sendUserMessage(renderCommandTemplate(template, pluginRoot, args));
        },
      });
      clearFailure(`command ${name} registration`, registrationContext, startedAt);
    } catch (error) {
      report(`command ${name} registration`, error, registrationContext, startedAt);
    }
  }
}
