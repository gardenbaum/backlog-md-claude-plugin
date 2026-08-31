import { taskView } from "../lib/backlog.mjs";
import { recordSessionMetric } from "../lib/integration.mjs";
import { findNext } from "../lib/next.mjs";
import { run } from "../lib/proc.mjs";
import { renderNext } from "../lib/render.mjs";

export const BACKLOG_TOOL_NAMES = [
  "backlog_next",
  "backlog_task_start",
  "backlog_task_plan",
  "backlog_check_ac",
  "backlog_task_finish",
  "backlog_task_create",
];

const emptyObject = { type: "object", additionalProperties: false };
const taskId = { type: "string", minLength: 1, description: "Backlog task ID, for example BCC-12." };
const nonEmptyText = { type: "string", minLength: 1 };

function textResult(text, isError = false, details) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}), ...(details ? { details } : {}) };
}

function failed(result) {
  const detail = result.message ?? result.stderr?.trim() ?? result.stdout?.trim();
  return textResult(`Backlog command failed: ${result.reason}${detail ? ` — ${detail}` : ""}`, true, result);
}

async function mutate(args, ctx) {
  const result = await run("backlog", args, { cwd: ctx.cwd });
  return result.ok ? textResult(result.stdout.trim() || "Backlog command completed.", false, result) : failed(result);
}

function contextSessionId(ctx) {
  try {
    return String(ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.sessionId ?? "nosession");
  } catch {
    return "nosession";
  }
}

async function startTask(id, ctx) {
  const before = await taskView(id, { cwd: ctx.cwd });
  const result = await mutate(["task", "edit", id, "-s", "In Progress"], ctx);
  if (!result.isError && (!before.ok || !before.task.implementationPlan?.trim())) {
    recordSessionMetric({ cwd: ctx.cwd, sessionId: contextSessionId(ctx), name: "unplanned-start" });
  }
  return result;
}

function requiredString(params, name) {
  const value = params?.[name];
  return typeof value === "string" && value.trim() ? value : null;
}

function taskTool({ name, label, description, parameters, execute }) {
  return {
    name,
    label,
    description,
    parameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: name === "backlog_next" ? "read" : "write",
    execute: async (...args) => {
      const result = await execute(...args);
      if (!result.isError) {
        const ctx = args.at(-1);
        recordSessionMetric({ cwd: ctx.cwd, sessionId: contextSessionId(ctx), name: "tool", tool: name });
        if (name === "backlog_check_ac") {
          recordSessionMetric({ cwd: ctx.cwd, sessionId: contextSessionId(ctx), name: "acceptance-check" });
        }
      }
      return result;
    },
  };
}

/** Register tools that replace agent-authored `backlog` shell invocations. */
export function registerBacklogTools(pi) {
  pi.registerTool(
    taskTool({
      name: "backlog_next",
      label: "Next Backlog task",
      description: "List the highest-priority ready Backlog.md tasks.",
      parameters: emptyObject,
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        const result = await findNext({ cwd: ctx.cwd });
        return result.ok
          ? textResult(renderNext(result.tasks, { status: result.status }), false, result)
          : textResult(`Backlog command failed: ${result.reason}`, true, result);
      },
    }),
  );
  pi.registerTool(
    taskTool({
      name: "backlog_task_start",
      label: "Start Backlog task",
      description: "Mark a Backlog.md task In Progress.",
      parameters: {
        ...emptyObject,
        properties: { taskId },
        required: ["taskId"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const id = requiredString(params, "taskId");
        return id ? startTask(id, ctx) : textResult("taskId is required.", true);
      },
    }),
  );
  pi.registerTool(
    taskTool({
      name: "backlog_task_plan",
      label: "Plan Backlog task",
      description: "Append ordered implementation-plan steps to a Backlog.md task.",
      parameters: {
        ...emptyObject,
        properties: { taskId, steps: { type: "array", minItems: 1, items: nonEmptyText } },
        required: ["taskId", "steps"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const id = requiredString(params, "taskId");
        const steps =
          Array.isArray(params?.steps) && params.steps.every((step) => typeof step === "string" && step.trim());
        return id && steps
          ? mutate(["task", "edit", id, ...params.steps.flatMap((step) => ["--append-plan", step])], ctx)
          : textResult("taskId and one or more non-empty steps are required.", true);
      },
    }),
  );
  pi.registerTool(
    taskTool({
      name: "backlog_check_ac",
      label: "Check Backlog criterion",
      description: "Record named evidence and check one Backlog.md acceptance criterion.",
      parameters: {
        ...emptyObject,
        properties: {
          taskId,
          index: { type: "integer", minimum: 1, description: "One-based acceptance-criterion index." },
          evidence: { ...nonEmptyText, description: "Named test, observation, or measurement proving this criterion." },
        },
        required: ["taskId", "index", "evidence"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const id = requiredString(params, "taskId");
        const evidence = requiredString(params, "evidence");
        const index = Number.isInteger(params?.index) && params.index > 0 ? params.index : null;
        return id && index && evidence
          ? mutate(
              [
                "task",
                "edit",
                id,
                "--append-notes",
                `Evidence for acceptance criterion #${index}: ${evidence}`,
                "--check-ac",
                String(index),
              ],
              ctx,
            )
          : textResult("taskId, a positive index, and named evidence are required.", true);
      },
    }),
  );
  pi.registerTool(
    taskTool({
      name: "backlog_task_finish",
      label: "Finish Backlog task",
      description: "Write a final summary and mark a Backlog.md task Done.",
      parameters: {
        ...emptyObject,
        properties: {
          taskId,
          summary: { ...nonEmptyText, description: "Final summary of completed work and verification." },
        },
        required: ["taskId", "summary"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const id = requiredString(params, "taskId");
        const summary = requiredString(params, "summary");
        return id && summary
          ? mutate(["task", "edit", id, "-s", "Done", "--final-summary", summary], ctx)
          : textResult("taskId and summary are required.", true);
      },
    }),
  );
  pi.registerTool(
    taskTool({
      name: "backlog_task_create",
      label: "Create Backlog task",
      description: "Create a Backlog.md task with its description and acceptance criteria.",
      parameters: {
        ...emptyObject,
        properties: {
          title: { ...nonEmptyText, description: "Clear task title." },
          description: { ...nonEmptyText, description: "Outcome and context for the task." },
          acceptanceCriteria: { type: "array", minItems: 1, items: nonEmptyText },
        },
        required: ["title", "description", "acceptanceCriteria"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const title = requiredString(params, "title");
        const description = requiredString(params, "description");
        const criteria =
          Array.isArray(params?.acceptanceCriteria) &&
          params.acceptanceCriteria.every((criterion) => typeof criterion === "string" && criterion.trim());
        return title && description && criteria
          ? mutate(
              [
                "task",
                "create",
                title,
                "-d",
                description,
                ...params.acceptanceCriteria.flatMap((criterion) => ["--ac", criterion]),
              ],
              ctx,
            )
          : textResult("title, description, and one or more acceptanceCriteria are required.", true);
      },
    }),
  );
}

/** Activate registered Backlog tools for the current project only. */
export async function activateBacklogTools(pi) {
  await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...BACKLOG_TOOL_NAMES])]);
}
