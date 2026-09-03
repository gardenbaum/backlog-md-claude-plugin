import { IN_PROGRESS } from "../lib/active-task.mjs";
import { taskList, taskView } from "../lib/backlog.mjs";
import { appendEvent, deriveSession } from "../lib/cache.mjs";
import { compoundCriteria, compoundNotice } from "../lib/criteria.mjs";
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
  "backlog_edit_ac",
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

/**
 * An array parameter, with a host's serialised array unwrapped.
 *
 * A run reached this tool with `acceptanceCriteria` holding a single string
 * that was the whole thirteen-item list as JSON text, and with `steps` holding
 * the whole plan the same way. Thirteen criteria the user had just approved
 * became one, and the plan was stored with its brackets and quotes intact
 * (BCC-11, measured in edgemaker). The schema says `array of string`, so the
 * host is wrong to send that — but the list is still recoverable here, and one
 * criterion is not.
 *
 * Only a one-element array is unwrapped, and only when the element parses as an
 * array whose leaves are all non-empty strings: a criterion that merely starts
 * with `[` parses as nothing and is returned as itself.
 *
 * @param {unknown} value
 * @returns {string[] | null} the strings, or null when the shape is not a list of them
 */
export function stringList(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const strings = value.every((entry) => typeof entry === "string" && entry.trim());
  if (!strings) return null;
  const trimmed = value.map((entry) => entry.trim());
  if (trimmed.length !== 1) return trimmed;
  return unwrapped(trimmed[0]) ?? trimmed;
}

/**
 * Flattened, because the nesting a host wraps a list in is not the list's
 * shape: one run sent a single plan step as `[[[[[["Alle 33 ACs …"]]]]]]` and
 * it was stored with all twelve brackets, since the outer array's one element
 * is an array rather than the string this looked for (BCC-12).
 *
 * @param {string} text @returns {string[] | null}
 */
function unwrapped(text) {
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    const leaves = parsed.flat(Number.POSITIVE_INFINITY);
    if (leaves.length === 0) return null;
    if (!leaves.every((entry) => typeof entry === "string" && entry.trim())) return null;
    return leaves.map((entry) => entry.trim());
  } catch {
    return null;
  }
}

/**
 * The same, for a list that may be left out entirely.
 *
 * An explicit empty array is a list of none, not a malformed one: every task in
 * an empty backlog is a root task, and rejecting `dependencies: []` left no way
 * to create the first one (BCC-6).
 *
 * @param {unknown} value
 * @returns {string[] | null}
 */
function optionalStringList(value) {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return [];
  return stringList(value);
}

/** How many items were written, for a result line that would otherwise not say. */
function countOf(items, singular, plural = `${singular}s`) {
  return `${items.length} ${items.length === 1 ? singular : plural}`;
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
        const steps = stringList(params?.steps);
        if (!id || !steps) return textResult("taskId and one or more non-empty steps are required.", true);
        const result = await mutate(["task", "edit", id, ...steps.flatMap((step) => ["--append-plan", step])], ctx);
        if (result.isError) return result;
        // What landed, not just that something did. "Updated task EDG-3" reads
        // the same whether six steps were appended or one holding all six
        // (BCC-11).
        return textResult(
          `${result.content[0].text}\n\nAppended ${countOf(steps, "plan step")} to ${id}. Backlog.md appends every ` +
            "step it is given and drops none, so if that is fewer than you sent, the rest did not arrive — re-send " +
            "them rather than working from a plan the task does not have. A number that matches what you sent is " +
            "this call reporting success, not a warning.",
          false,
          result.details,
        );
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
        const before = await taskView(id, { cwd: ctx.cwd });
        // The criterion, beside the claim, in the file and not only in this
        // answer. The evidence paragraph is keyed by index, and every
        // `--remove-ac` and `--clear-ac` renumbers the list underneath it: one
        // run rebuilt its criteria twice while an evidence paragraph for #1 was
        // already recorded, and nothing in the task would have shown the
        // mismatch (BCC-10). With the criterion quoted next to the evidence, a
        // renumbering is visible to the next reader instead of silent.
        const criterion = before.ok
          ? (before.task.acceptanceCriteria || []).find((entry) => entry.index === index)
          : null;
        // One paragraph, always: a blank line inside the evidence would split
        // the block that `replaceEvidence` has to find again on a re-check.
        const line =
          evidencePrefix(index) +
          (criterion ? `"${criterion.text.trim()}" — ` : "") +
          evidence.trim().replace(/\n[ \t]*\n+/g, "\n");
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
        // measured in edgemaker).
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
      name: "backlog_edit_ac",
      label: "Edit Backlog criteria",
      description: "Add, remove, or replace a Backlog.md task's acceptance criteria in one call.",
      parameters: {
        ...emptyObject,
        properties: {
          taskId,
          add: {
            type: "array",
            items: nonEmptyText,
            description: "Criteria to append. They land at the end of the list, never in a removed one's place.",
          },
          remove: {
            type: "array",
            items: { type: "integer", minimum: 1 },
            description: "One-based indices to remove, all resolved against the list as it is now.",
          },
          criteria: {
            type: "array",
            items: nonEmptyText,
            description:
              "The complete new list, in order. Replaces every criterion; cannot be combined with add or remove.",
          },
        },
        required: ["taskId"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const id = requiredString(params, "taskId");
        if (!id) return textResult("taskId is required.", true);
        const add = stringList(params?.add);
        const criteria = stringList(params?.criteria);
        const remove = Array.isArray(params?.remove) ? params.remove : [];
        if (!remove.every((index) => Number.isInteger(index) && index > 0)) {
          return textResult("Every remove entry must be a positive one-based index.", true);
        }
        if (params?.add && !add) return textResult("Every add entry must be a non-empty criterion.", true);
        if (params?.criteria && !criteria) return textResult("Every criteria entry must be a non-empty string.", true);
        if (criteria && (add || remove.length > 0)) {
          return textResult(
            "criteria replaces the whole list, so it cannot be combined with add or remove — the CLI refuses " +
              "the same combination. Pass the complete list you want, or use add and remove together.",
            true,
          );
        }
        if (!criteria && !add && remove.length === 0) {
          return textResult("Pass add, remove, or criteria — there is nothing to change otherwise.", true);
        }
        const before = await taskView(id, { cwd: ctx.cwd });
        const previous = before.ok ? before.task.acceptanceCriteria || [] : [];

        if (!criteria) {
          // One process, one lock. The same split issued as `--remove-ac` and
          // two `--ac` calls in a batch failed with "is being modified by
          // another process" (BCC-10) — and repeated `--remove-ac` in a single
          // call resolves every index against the original list, so the
          // highest-index-down dance is not needed here either (verified on
          // 1.50.1).
          const result = await mutate(
            [
              "task",
              "edit",
              id,
              ...remove.flatMap((index) => ["--remove-ac", String(index)]),
              ...(add ?? []).flatMap((criterion) => ["--ac", criterion]),
            ],
            ctx,
          );
          if (result.isError) return result;
          const notes = [];
          if (add) {
            const kept = previous.length - remove.length;
            const compound = compoundCriteria(add);
            if (compound.length > 0) {
              notes.push(
                compoundNotice(
                  compound.map((n) => (kept > 0 ? kept + n : n)),
                  { id },
                ),
              );
            }
            if (remove.length > 0 && kept > 0) {
              notes.push(
                `Added criteria are appended, so they are now #${kept + 1}${add.length > 1 ? `-#${kept + add.length}` : ""} ` +
                  "rather than in the place of what was removed. Pass the whole list as `criteria` if that order matters.",
              );
            }
          }
          return notes.length === 0
            ? result
            : textResult([result.content[0].text, ...notes].join("\n\n"), false, result.details);
        }

        // Replacement clears every checkmark and cannot be combined with
        // `--check-ac` in the same call (the CLI refuses it), so the ticks are
        // restored in a second call. A run rebuilt its list this way through
        // the shell and silently lost the one criterion it had already checked
        // with evidence (BCC-10). Matched on text: a criterion whose wording
        // changed is a different claim and has to be measured again.
        const checkedBefore = previous.filter((entry) => entry.checked).map((entry) => entry.text.trim());
        const result = await mutate(
          ["task", "edit", id, ...criteria.flatMap((criterion) => ["--acceptance-criteria", criterion])],
          ctx,
        );
        if (result.isError) return result;
        const restore = criteria.flatMap((text, i) => (checkedBefore.includes(text) ? [i + 1] : []));
        const dropped = checkedBefore.filter((text) => !criteria.includes(text));
        const restored =
          restore.length > 0
            ? await mutate(["task", "edit", id, ...restore.flatMap((index) => ["--check-ac", String(index)])], ctx)
            : null;
        const notes = [];
        if (restore.length > 0) {
          notes.push(
            restored?.isError
              ? `The replacement landed, but restoring the checkmarks on ${restore.map((n) => `#${n}`).join(", ")} failed: ` +
                  `${restored.content[0].text} Re-check them with backlog_check_ac and the evidence already recorded.`
              : `Checkmarks restored on ${restore.map((n) => `#${n}`).join(", ")} — the criteria whose text is unchanged.`,
          );
        }
        if (dropped.length > 0) {
          notes.push(
            `${dropped.length} checked criteri${dropped.length === 1 ? "on is" : "a are"} not in the new list and ` +
              `${dropped.length === 1 ? "its evidence is" : "their evidence is"} now unattached: ` +
              `${dropped.map((text) => `"${text}"`).join(", ")}. Evidence paragraphs in the implementation notes are ` +
              "keyed by index, so re-read the notes against the new numbering before checking anything else.",
          );
        }
        const compound = compoundCriteria(criteria);
        if (compound.length > 0) notes.push(compoundNotice(compound, { id }));
        return notes.length === 0
          ? result
          : textResult([result.content[0].text, ...notes].join("\n\n"), false, result.details);
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
        // The `recorded` event afterwards is what keeps a second task finished
        // in the same session from inheriting these same files — recorded, not
        // merely written about, since prose notes leave `--modified-file`
        // untouched and used to clear the list all the same (BCC-12).
        const project = findProject(ctx.cwd || process.cwd());
        const session = contextSessionId(ctx);
        const derived = project ? deriveSession(project.root, session) : null;
        const files = derived?.pendingModifiedFiles ?? [];
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
        if (result.isError) return result;
        if (project && files.length > 0) appendEvent(project.root, session, { t: "recorded" });
        const notes = [];
        // Every box on this task was ticked by the session that did the work.
        // That is the ordinary case and not a fault, but it is also the whole
        // of the evidence: `/backlog-md:finish` opens with the verifier for
        // this reason, and a session that reaches Done through this tool has
        // skipped it — one wrote a whole post, ticked fifteen criteria of its
        // own and finished, with "ausschließlich aus Business-Perspektive"
        // resting on nothing but its own reading (BCC-10). Named, not refused:
        // an independent check is a decision for the person, and refusing here
        // would leave a finished task unclosable in a session without agents.
        //
        // Spelled out as a slash command since a run read the old wording as a
        // path, ran `scripts/backlog-verify.mjs`, got MODULE_NOT_FOUND and
        // concluded the verifier did not exist in this version — then finished
        // on thirty-five criteria it had checked itself (BCC-11).
        if ((derived?.metrics.acceptanceChecks ?? 0) > 0) {
          notes.push(
            `${id} is Done, and this session checked its own criteria — nothing independent has read them. Type ` +
              "`/backlog-md:verify` as a slash command — it is not a script, and nothing under scripts/ answers to " +
              "that name. It dispatches the `backlog-verifier` agent against the evidence in the task and can still " +
              "uncheck what does not hold; a criterion it rejects means this task goes back, not that the box was " +
              "close enough.",
          );
        }
        // The definition of done is the half of `/backlog-md:finish` that no
        // other tool reads, so a session that reaches Done through this call
        // never sees it. Free here: it is in the view this tool already took.
        const dod = (view.ok ? view.task.definitionOfDone || [] : []).filter((item) => !item.checked);
        if (dod.length > 0) {
          notes.push(
            `${countOf(dod, "definition-of-done item is", "definition-of-done items are")} still unchecked: ` +
              `${dod.map((item) => `#${item.index} ${item.text}`).join("; ")}. Backlog.md does not gate Done on ` +
              "them. Walk each one, then check the ones that hold with backlog task edit " +
              `${id} --check-dod <n>.`,
          );
        }
        // Recorded is not committed: a finished task named its one changed file
        // in both places the plugin writes, and the file was still untracked
        // when the session ended (BCC-11, measured in edgemaker).
        if (files.length > 0) {
          notes.push(
            `Recorded as modified: ${files.join(", ")}. Recorded, not committed — proposing the commit is the last ` +
              "step of `/backlog-md:finish`, and it is still to do.",
          );
        }
        return notes.length === 0
          ? result
          : textResult([result.content[0].text, ...notes].join("\n\n"), false, result.details);
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
        const criteria = stringList(params?.acceptanceCriteria);
        if (!title || !description || !criteria) {
          return textResult("title, description, and one or more acceptanceCriteria are required.", true);
        }
        const dependencies = optionalStringList(params?.dependencies);
        if (!dependencies) {
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
            ...criteria.flatMap((criterion) => ["--ac", criterion]),
            ...dependencies.flatMap((id) => ["--dep", id]),
            ...(milestone ? ["-m", milestone] : []),
            ...(parent ? ["-p", parent] : []),
          ],
          ctx,
        );
        if (result.isError) return result;
        // A create that writes one criterion and a create that writes thirteen
        // answer "Created task EDG-3" alike. One run had twelve of thirteen
        // approved criteria never reach the task, and found out only by reading
        // the file back four calls later (BCC-11, measured in edgemaker).
        const written =
          `Wrote ${countOf(criteria, "acceptance criterion", "acceptance criteria")} to this task. ` +
          "Backlog.md writes every criterion it is given — it does not merge duplicates and does not drop any — so " +
          "if that is fewer than you sent, the rest never arrived. Add them before any of this is measured, and do " +
          "not explain the difference away.";
        const compound = compoundCriteria(criteria);
        if (compound.length === 0) {
          return textResult(`${result.content[0].text}\n\n${written}`, false, result.details);
        }
        // The id the CLI just assigned, so the split it asks for is a command
        // that can be run rather than one to fill in first.
        const created = /Created task ([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(result.content[0].text);
        return textResult(
          [result.content[0].text, written, compoundNotice(compound, { id: created?.[1] ?? "<id>" })].join("\n\n"),
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
