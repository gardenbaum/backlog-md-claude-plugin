import { IN_PROGRESS } from "../lib/active-task.mjs";
import { taskList, taskView } from "../lib/backlog.mjs";
import { recordSessionMetric, recordTaskIdentity } from "../lib/integration.mjs";
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
  const result = await mutate(["task", "edit", id, "-s", IN_PROGRESS], ctx);
  if (result.isError) return result;
  // Named, not only counted. This was the one place the plugin could tell the
  // plan was missing, and it recorded the number in silence: a session started
  // a task, wrote a whole blog post, checked six criteria and finished, with
  // `unplannedStarts: 1` the only trace that no plan was ever written (BCC-7).
  const notes = [];
  if (!before.ok || !before.task.implementationPlan?.trim()) {
    recordSessionMetric({ cwd: ctx.cwd, sessionId: contextSessionId(ctx), name: "unplanned-start" });
    notes.push(
      `${id} has no implementation plan. Write one with backlog_task_plan before the work, not after: ` +
        "the plan is what the next reader — and this session after a compaction — has instead of the " +
        "reasoning that produced the code.",
    );
  }
  // More than one task In Progress makes `resolveActiveTask` ambiguous, and
  // the brief, the acceptance reminder and the end-of-session note all go
  // quiet together. A session started thirteen at once and left the first one
  // open with four unchecked criteria, unnoticed (BCC-5). Named, not refused:
  // working on several tasks is legitimate, losing the safety net without
  // being told is not.
  const listed = await taskList(["-s", IN_PROGRESS], { cwd: ctx.cwd });
  const others = listed.ok ? listed.tasks.filter((task) => task.id.toLowerCase() !== id.toLowerCase()) : [];
  if (others.length > 0) {
    notes.push(
      `Also In Progress: ${others.map((task) => task.id).join(", ")}. ` +
        "While more than one task is In Progress, this session cannot tell which one it is working on, and the " +
        "task brief, the unchecked-criteria reminder and the end-of-session note stay silent until one is left. " +
        "Finish or move the others back with backlog task edit <id> -s 'To Do' unless you meant to hold them all open.",
    );
  }
  if (notes.length === 0) return result;
  return textResult([result.content[0].text, ...notes].join("\n\n"), false, result.details);
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
    // Backlog.md locks a task per process. Seven `backlog_check_ac` calls issued
    // as one batch left five of them with "is being modified by another
    // process", and the retry re-checked what had already succeeded, doubling
    // its evidence notes (BCC-4, measured and reproduced). `exclusive` is a full
    // barrier in OMP's batch scheduler, so the calls queue behind each other
    // instead. Not part of OMP's `ToolDefinition`, but `applyToolProxy` copies
    // every own key onto the adapter the scheduler reads; a host that drops the
    // field is back to today's behaviour rather than broken.
    concurrency: name === "backlog_next" ? "shared" : "exclusive",
    execute: async (...args) => {
      const result = await execute(...args);
      if (!result.isError) {
        const ctx = args.at(-1);
        const session = contextSessionId(ctx);
        recordSessionMetric({ cwd: ctx.cwd, sessionId: session, name: "tool", tool: name });
        // Which task this session is working on, from the call that names it.
        // Without this the flush at shutdown has nothing to write to once the
        // task has been finished, and the journal outlives the session (BCC-7).
        recordTaskIdentity({ cwd: ctx.cwd, sessionId: session, taskId: args[1]?.taskId });
        if (name === "backlog_check_ac") {
          recordSessionMetric({ cwd: ctx.cwd, sessionId: session, name: "acceptance-check" });
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
          ? textResult(renderNext(result.tasks, { status: result.status, total: result.total }), false, result)
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
        if (!id || !summary) return textResult("taskId and summary are required.", true);
        // Backlog.md sets Done whatever the criteria say — measured: a task went
        // Done with both of its criteria still open (BCC-4). A criterion that
        // cannot be met belongs corrected or removed, not carried into Done
        // where the next reader has no way to tell it was never verified. A
        // task this tool cannot read is not blocked: refusing on a failed read
        // would put an unreachable CLI between the model and a finished task.
        const view = await taskView(id, { cwd: ctx.cwd });
        const open = view.ok ? (view.task.acceptanceCriteria || []).filter((criterion) => !criterion.checked) : [];
        if (open.length > 0) {
          return textResult(
            `${id} still has unchecked acceptance criteria: ${open.map((criterion) => `#${criterion.index}`).join(", ")}. ` +
              "Check each one with backlog_check_ac and evidence you actually gathered. A criterion you cannot " +
              "verify belongs removed with backlog task edit <id> --remove-ac <n>, or rewritten into one you can: " +
              "checking it with an excuse for evidence records it as verified when it was not.",
            true,
          );
        }
        return mutate(["task", "edit", id, "-s", "Done", "--final-summary", summary], ctx);
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
          // A decomposition is a dependency graph, and without these three the
          // native path could only create the nodes (BCC-4). Optional, so the
          // ordinary single-task call is unchanged — and without `minItems`,
          // which rejected an explicit empty array in the host's schema check
          // before this tool ever ran. Every task in an empty backlog is a root
          // task, so that refusal left no way to create the first one (BCC-6).
          dependencies: {
            type: "array",
            items: nonEmptyText,
            description:
              "Task IDs this task depends on. They must already exist. Omit it for a task with no predecessor.",
          },
          milestone: { ...nonEmptyText, description: "Existing milestone ID or title." },
          parent: { ...nonEmptyText, description: "Existing parent task ID, never a milestone ID." },
        },
        required: ["title", "description", "acceptanceCriteria"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const title = requiredString(params, "title");
        const description = requiredString(params, "description");
        const criteria =
          Array.isArray(params?.acceptanceCriteria) &&
          params.acceptanceCriteria.every((criterion) => typeof criterion === "string" && criterion.trim());
        if (!title || !description || !criteria) {
          return textResult("title, description, and one or more acceptanceCriteria are required.", true);
        }
        const dependencies = Array.isArray(params?.dependencies) ? params.dependencies : [];
        if (!dependencies.every((id) => typeof id === "string" && id.trim())) {
          return textResult("Every dependency must be a non-empty task ID.", true);
        }
        const milestone = requiredString(params, "milestone");
        const parent = requiredString(params, "parent");
        return mutate(
          [
            "task",
            "create",
            title,
            "-d",
            description,
            ...params.acceptanceCriteria.flatMap((criterion) => ["--ac", criterion]),
            ...dependencies.flatMap((id) => ["--dep", id]),
            ...(milestone ? ["-m", milestone] : []),
            ...(parent ? ["-p", parent] : []),
          ],
          ctx,
        );
      },
    }),
  );
}

/** Activate registered Backlog tools for the current project only. */
export async function activateBacklogTools(pi) {
  await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...BACKLOG_TOOL_NAMES])]);
}
