import { IN_PROGRESS } from "../lib/active-task.mjs";
import { taskList, taskView } from "../lib/backlog.mjs";
import { appendEvent, deriveSession } from "../lib/cache.mjs";
import { recordSessionMetric, recordTaskIdentity } from "../lib/integration.mjs";
import { findNext } from "../lib/next.mjs";
import { findProject } from "../lib/paths.mjs";
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

/**
 * The notes with this criterion's evidence replaced, or null to append.
 *
 * A re-check corrects the check before it — the executor measured again, or
 * the first evidence was wrong. Appending left both readings in the task: one
 * run recorded "description=304 characters — violates the 1–300 limit" and,
 * three paragraphs later, "245 characters (OK)", with nothing to say which one
 * counts (BCC-8, measured in edgemaker). The evidence line is written here, so
 * its paragraph is ours to find and ours to overwrite.
 *
 * @param {string} notes
 * @param {number} index
 * @param {string} line
 * @returns {string | null}
 */
function replaceEvidence(notes, index, line) {
  const prefix = evidencePrefix(index);
  const paragraphs = String(notes || "").split(/\n[ \t]*\n/);
  if (!paragraphs.some((paragraph) => paragraph.startsWith(prefix))) return null;
  let written = false;
  return paragraphs
    .filter((paragraph) => {
      if (!paragraph.startsWith(prefix)) return true;
      if (written) return false;
      written = true;
      return true;
    })
    .map((paragraph) => (paragraph.startsWith(prefix) ? line : paragraph))
    .join("\n\n");
}

function evidencePrefix(index) {
  return `Evidence for acceptance criterion #${index}: `;
}

/**
 * The 1-based indices of criteria that carry more than one assertion.
 *
 * One checkbox over several requirements cannot record that some of them hold,
 * and the one that fails is the one that gets waved through: a criterion
 * reading "3-5 inhaltliche Hauptabschnitte" was ticked over a post with six,
 * and another asserted a title image "liegt unter public/images/posts/" while
 * excusing its absence in the same sentence (BCC-9, measured in edgemaker).
 * The decomposer prompt has asked for one assertion each since 0.3.8; that run
 * had it and returned six compound criteria out of nine anyway. This is the
 * same sentence where the criteria are actually written.
 *
 * Parentheticals are dropped first: "(nicht engineering, nicht gesellschaft)"
 * clarifies one assertion rather than adding three.
 *
 * @param {string[]} criteria
 * @returns {number[]}
 */
function compoundCriteria(criteria) {
  return criteria.flatMap((text, i) => {
    const bare = String(text).replace(/\([^)]*\)/g, "");
    const joins = /\s(?:und|and|sowie)\s/i.test(bare) || bare.includes(";");
    return joins || (bare.match(/,/g) || []).length >= 3 ? [i + 1] : [];
  });
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
        if (!id || !index || !evidence) {
          return textResult("taskId, a positive index, and named evidence are required.", true);
        }
        // One paragraph, always: a blank line inside the evidence would split
        // the block that `replaceEvidence` has to find again on a re-check.
        const line = evidencePrefix(index) + evidence.trim().replace(/\n[ \t]*\n+/g, "\n");
        const before = await taskView(id, { cwd: ctx.cwd });
        // A failed read appends. Losing the check to a lookup that did not
        // answer would be the worse half of the trade.
        const replaced = before.ok ? replaceEvidence(before.task.implementationNotes, index, line) : null;
        const result = await mutate(
          [
            "task",
            "edit",
            id,
            ...(replaced === null ? ["--append-notes", line] : ["--notes", replaced]),
            "--check-ac",
            String(index),
          ],
          ctx,
        );
        if (result.isError) return result;
        // The criterion, beside the claim, at the moment the box is ticked.
        // "Updated task EDG-1" was the entire answer nine times in one run, and
        // one of those nine ticked "3-5 inhaltliche Hauptabschnitte" over a post
        // with six sections — the six counted in its own evidence (BCC-9,
        // measured in edgemaker). Nothing extra is read for this: the view above
        // is already made for the evidence.
        const criterion = before.ok
          ? (before.task.acceptanceCriteria || []).find((entry) => entry.index === index)
          : null;
        if (!criterion) return result;
        return textResult(
          `${result.content[0].text}\n\nChecked #${index} against: ${criterion.text}\n` +
            "If the evidence does not meet that as written, the tick is wrong: undo it with " +
            `backlog task edit ${id} --uncheck-ac ${index}, then correct the criterion or the work.`,
          false,
          result.details,
        );
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
        // What the session actually touched, from the journal that records
        // every edit anyway. `--modified-file` has been in the CLI all along;
        // without it a finished task named the one file it changed inside a
        // prose sentence of evidence, and nowhere a reader can list (BCC-9).
        // The notes event afterwards is what keeps a second task finished in
        // the same session from inheriting these same files.
        const project = findProject(ctx.cwd || process.cwd());
        const session = contextSessionId(ctx);
        const files = project ? deriveSession(project.root, session).pendingModifiedFiles : [];
        const result = await mutate(
          [
            "task",
            "edit",
            id,
            "-s",
            "Done",
            "--final-summary",
            summary,
            ...files.flatMap((file) => ["--modified-file", file]),
          ],
          ctx,
        );
        if (!result.isError && project && files.length > 0) appendEvent(project.root, session, { t: "notes" });
        return result;
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
        const result = await mutate(
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
        if (result.isError) return result;
        const compound = compoundCriteria(params.acceptanceCriteria);
        if (compound.length === 0) return result;
        return textResult(
          `${result.content[0].text}\n\nCriteria ${compound.map((n) => `#${n}`).join(", ")} carry more than one ` +
            'assertion. A criterion whose evidence needs an "and" cannot record that half of it holds, and the ' +
            "half that fails is the half that gets waved through. Split them now, while nothing has been measured " +
            "against them: backlog task edit <id> --remove-ac <n> --ac '<one assertion>' --ac '<the other>'. " +
            "Removing renumbers every criterion after it, so work from the highest index down.",
          false,
          result.details,
        );
      },
    }),
  );
}

/** Activate registered Backlog tools for the current project only. */
export async function activateBacklogTools(pi) {
  await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...BACKLOG_TOOL_NAMES])]);
}
