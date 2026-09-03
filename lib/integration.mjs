import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { taskIdCandidates, resolveActiveTask } from "./active-task.mjs";
import { taskView } from "./backlog.mjs";
import { initialisesBacklog, mutatesBacklog, shellWriteTargets, writesTaskNotes } from "./bash.mjs";
import { buildBrief } from "./brief.mjs";
import { appendEvent, deriveSession, readCache, updateCache, writeSessionSummary } from "./cache.mjs";
import { compoundCriteria, compoundNotice, criteriaInCommand } from "./criteria.mjs";
import { denyReason, initReason } from "./deny.mjs";
import { looksLikeBuildIntent, observe } from "./observations.mjs";
import { classifyBacklogPath, findProject } from "./paths.mjs";
import { scaledTimeout, workerNodeExecutable } from "./proc.mjs";
import { renderForeignTask, renderIntentNudge, renderObservations } from "./render.mjs";
import { includesSelf } from "./session-sweep.mjs";

const CANDIDATE_LOOKUP_LIMIT = 3;
const CANDIDATE_TIMEOUT_MS = 1000;
const PROMPT_BUDGET_MS = 4000;
const WRITE_TOOLS = new Set(["write", "edit", "notebookedit", "ast_edit"]);
const NOOP = (_error) => {};

function normaliseToolName(name) {
  return typeof name === "string" ? name.toLowerCase() : "";
}

/**
 * OMP's mounted xdev tools arrive as `write xd://<tool>` with the real input
 * JSON in `content`. Decode only the two mutating devices this guard knows.
 */
export function decodeMountedToolCall(toolName, toolInput = {}) {
  const name = normaliseToolName(toolName);
  if (name !== "write") return { toolName: name, toolInput, mounted: false };
  const match = /^xd:\/\/(ast_edit|lsp)$/.exec(toolInput?.path);
  if (!match || typeof toolInput?.content !== "string") return { toolName: name, toolInput, mounted: false };
  try {
    const decoded = JSON.parse(toolInput.content);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return { toolName: name, toolInput, mounted: false };
    }
    return { toolName: match[1], toolInput: decoded, mounted: true };
  } catch {
    return { toolName: name, toolInput, mounted: false };
  }
}

function addString(targets, value) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed) targets.add(trimmed);
}

function addObjectTargets(targets, value) {
  if (!value || typeof value !== "object") return;
  for (const key of ["path", "file", "file_path", "notebook_path", "rename", "move", "sourcePath"]) {
    addString(targets, value[key]);
  }
  for (const key of ["edits", "perFileResults", "fileReplacements"]) {
    if (!Array.isArray(value[key])) continue;
    for (const entry of value[key]) addObjectTargets(targets, entry);
  }
  for (const key of ["files", "paths"]) {
    if (!Array.isArray(value[key])) continue;
    for (const file of value[key]) addString(targets, file);
  }
}

function addPatchTargets(targets, text) {
  if (typeof text !== "string") return;
  for (const match of text.matchAll(/^\[([^\]#\r\n]+)#[0-9a-f]{4}\]\s*$/gim)) addString(targets, match[1]);
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gim)) addString(targets, match[1]);
  for (const match of text.matchAll(/^\*\*\* Move to: (.+?)\s*$/gim)) addString(targets, match[1]);
}

/** Return every concrete file path named by a Claude or OMP write payload/result. */
export function toolTargetPaths(toolInput = {}, toolDetails) {
  const targets = new Set();
  addObjectTargets(targets, toolInput);
  addObjectTargets(targets, toolDetails);
  for (const key of ["input", "patch", "diff"]) addPatchTargets(targets, toolInput?.[key]);
  return [...targets];
}

function reasonInput(toolInput) {
  const authored = [toolInput?.input, toolInput?.patch, toolInput?.diff].filter((value) => typeof value === "string");
  return authored.length > 0 ? { ...toolInput, content: authored.join("\n") } : toolInput;
}
function isWritingTool(name, toolInput) {
  if (WRITE_TOOLS.has(name)) return true;
  if (name !== "lsp") return false;
  if (toolInput?.action === "rename" || toolInput?.action === "rename_file") return true;
  return toolInput?.action === "code_actions" && toolInput?.apply === true;
}

/**
 * Refuse what a shell command would overwrite: a `backlog init` landing on a
 * configuration that already exists, or a redirect into a managed file.
 *
 * The existence check is `findProject` itself: no project, no refusal, so the
 * init that creates one runs untouched — including one in a subdirectory of a
 * repository that has none. When a project is found, its config file is the
 * file the command would overwrite, and the reason names it.
 *
 * The redirect check runs second and shares every rule with the write tools,
 * because a refused write tool is exactly when a model reaches for the shell:
 * one answered two denied `Write` calls with `cat > 'backlog/tasks/EDG-1 -
 * ….md'` and said so in the same breath (BCC-6).
 */
function bashGuard(toolInput, cwd, guard, sessionId) {
  const command = toolInput && typeof toolInput === "object" ? Reflect.get(toolInput, "command") : undefined;
  const project = findProject(cwd || process.cwd());
  if (!project) return null;
  if (initialisesBacklog(command)) {
    const configPath = relative(project.root, project.configPath) || project.configPath;
    recordSessionMetric({ cwd: project.root, sessionId, name: "guard" });
    return { block: guard !== "0", reason: initReason(configPath), target: configPath };
  }
  return managedTargetGuard(shellWriteTargets(command), project, { content: command }, guard, sessionId);
}

/**
 * The first managed path among `targets`, refused with the command that should
 * have been run instead. Shared by every writing surface so a path cannot be
 * guarded through one tool and open through another.
 */
function managedTargetGuard(targets, project, toolInput, guard, sessionId) {
  for (const target of targets) {
    const classification = classifyBacklogPath(target, project);
    if (!classification.managed) continue;
    const exists = existsSync(resolve(project.root, target));
    // `backlog decision create` writes a template and Backlog.md has no
    // command that fills it in, so refusing the hand-edit left the record
    // permanently empty — measured: a session created decision-1, was denied
    // the write, and its audit result exists nowhere (BCC-5). Only the file's
    // creation by hand is still refused; that one has a command.
    if (classification.kind === "decision" && exists) continue;
    const decision = {
      block: guard !== "0",
      reason: denyReason({ ...classification, exists }, toolInput),
      target,
    };
    recordSessionMetric({ cwd: project.root, sessionId, name: "guard" });
    return decision;
  }
  return null;
}

/**
 * Decide whether a direct file-writing tool must be redirected to Backlog.md's CLI.
 * Returns null when the plugin has no positive reason to intervene.
 *
 * @param {{ cwd?: string, toolName?: string, toolInput?: any, guard?: string, sessionId?: string }} [options]
 */
export function evaluateToolGuard({
  cwd,
  toolName,
  toolInput = {},
  guard = process.env.BACKLOG_MD_GUARD,
  sessionId,
} = {}) {
  const call = decodeMountedToolCall(toolName, toolInput);
  if (call.toolName === "bash") return bashGuard(call.toolInput, cwd, guard, sessionId);
  if (!isWritingTool(call.toolName, call.toolInput)) return null;
  const project = findProject(cwd || process.cwd());
  if (!project) return null;

  return managedTargetGuard(toolTargetPaths(call.toolInput), project, reasonInput(call.toolInput), guard, sessionId);
}

const EDITED_TASK_ID = /\bbacklog(?:\.md)?\s+task\s+edit\s+([A-Za-z0-9][\w-]*)/;
const EXIT_CODES = ["exitCode", "exit_code", "returnCode", "code"];

/**
 * Did this tool call fail, as far as its result can say?
 *
 * OMP hands `isError` to `recordToolActivity` directly; Claude Code's
 * PostToolUse payload carries a `tool_response` whose shape is the host's, so
 * this reads the fields hosts actually use and believes nothing else. One run
 * had twelve `backlog task edit` calls rejected by Backlog.md's per-task lock,
 * and every one of them was recorded as a mutation that had happened, marking
 * the cache stale twelve times over (BCC-10).
 *
 * Positive evidence only. An unrecognised response counts as a success, which
 * is the direction that costs a refetch rather than a missed mutation.
 *
 * @param {unknown} response
 */
export function failedToolResponse(response) {
  if (!response || typeof response !== "object") return false;
  const value = /** @type {Record<string, unknown>} */ (response);
  if (value.is_error === true || value.isError === true || value.success === false) return true;
  return EXIT_CODES.some((key) => typeof value[key] === "number" && value[key] !== 0);
}

/**
 * A warning to deliver alongside a tool call that is not being refused, or null.
 *
 * Acceptance criteria written through the shell are the blind spot the
 * create-time check left: it only ever saw a task's first draft, and the
 * criteria that matter are the ones rewritten afterwards. One run split four
 * compound criteria by hand and wrote a fifth compound one in the process,
 * which was never flagged and was later ticked (BCC-10, measured in edgemaker).
 *
 * A warning, never a block: the wording of a criterion is the author's call,
 * and a heuristic that refuses one would be the plugin overruling it.
 *
 * @param {{ cwd?: string, toolName?: string, toolInput?: any }} [options]
 * @returns {string | null}
 */
export function advisoryForToolCall({ cwd, toolName, toolInput = {} } = {}) {
  const call = decodeMountedToolCall(toolName, toolInput);
  if (call.toolName !== "bash") return null;
  const command =
    call.toolInput && typeof call.toolInput === "object" ? Reflect.get(call.toolInput, "command") : undefined;
  const criteria = criteriaInCommand(command);
  if (criteria.length === 0) return null;
  const compound = compoundCriteria(criteria);
  if (compound.length === 0) return null;
  if (!findProject(cwd || process.cwd())) return null;
  return compoundNotice(compound, { id: EDITED_TASK_ID.exec(command)?.[1] ?? "<id>", inTask: false });
}

/**
 * Append one per-session behavior counter without coupling callers to cache paths.
 *
 * @param {{ cwd?: string, sessionId?: string, name: string, tool?: string }} options
 */
export function recordSessionMetric({ cwd, sessionId, name, tool }) {
  const project = findProject(cwd || process.cwd());
  if (!project || typeof name !== "string" || !name) return;
  appendEvent(project.root, typeof sessionId === "string" && sessionId ? sessionId : "nosession", {
    t: "metric",
    name,
    ...(typeof tool === "string" && tool ? { tool } : {}),
  });
}

/**
 * Record which task a native tool call names as the session's own.
 *
 * The OMP path never wrote an identity event — only Claude Code's
 * UserPromptSubmit did — so `deriveSession().taskId` was permanently null
 * there, and the end-of-session flush had no target once the task it worked on
 * went Done (BCC-7). A tool call that names a task is stronger evidence than
 * the re-derivation it replaces: the model said which task it means.
 *
 * @param {{ cwd?: string, sessionId?: string, taskId?: unknown }} options
 */
export function recordTaskIdentity({ cwd, sessionId, taskId }) {
  if (typeof taskId !== "string" || !taskId.trim()) return;
  const project = findProject(cwd || process.cwd());
  if (!project) return;
  appendEvent(project.root, typeof sessionId === "string" && sessionId ? sessionId : "nosession", {
    t: "identity",
    id: taskId.trim(),
  });
}

/** Record a successful tool's effect in the append-only session journal. */
export function recordToolActivity({ cwd, sessionId, toolName, toolInput = {}, toolDetails, isError = false }) {
  if (isError) return;
  const project = findProject(cwd || process.cwd());
  if (!project) return;

  const call = decodeMountedToolCall(toolName, toolInput);
  const name = call.toolName;
  if (name === "bash") {
    const command =
      call.toolInput && typeof call.toolInput === "object" ? Reflect.get(call.toolInput, "command") : undefined;
    if (!mutatesBacklog(command)) return;
    appendEvent(project.root, sessionId, { t: "stale" });
    if (writesTaskNotes(command)) appendEvent(project.root, sessionId, { t: "notes" });
    return;
  }
  if (!isWritingTool(name, call.toolInput)) return;
  if (name === "ast_edit" && (call.mounted || toolDetails?.applied === false)) return;

  const mountedDetails = call.mounted ? (toolDetails?.xdev?.inner?.sourceResultDetails ?? toolDetails) : toolDetails;
  const targets = toolTargetPaths(call.toolInput, mountedDetails);
  for (const target of targets) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue;
    if (classifyBacklogPath(target, project).managed) continue;
    const absolutePath = resolve(project.root, target);
    const relativePath = relative(project.root, absolutePath);
    if (!relativePath || relativePath.startsWith("..")) continue;
    // A payload names paths and it names labels. OMP's edit result carries the
    // bare filename for display beside the real one, and `resolve` turned that
    // into a plausible repo-root path: one task was finished with its single
    // changed file listed twice, once as `src/content/posts/x.mdoc` and once as
    // `x.mdoc` (BCC-11, measured in edgemaker). The tool has already run, so
    // what it wrote is on disk; what is not on disk was not a path.
    if (!existsSync(absolutePath)) continue;
    appendEvent(project.root, sessionId, { t: "edit", p: relativePath });
  }
}

/** Build the session brief and record the event in the session cache. */
export async function sessionContext({ cwd, sessionId, event }) {
  const { context } = await buildBrief({ cwd, sessionId, event });
  return context;
}

function detachedCli({ cwd, pluginRoot, args, nodeExecutable, onError = NOOP, onSpawn = NOOP }) {
  const project = findProject(cwd || process.cwd());
  if (!project || !pluginRoot) return Promise.resolve(false);

  return new Promise((resolveSpawn) => {
    let child;
    let settled = false;
    const settle = (spawned, error) => {
      if (settled) return;
      settled = true;
      try {
        if (spawned) onSpawn();
        else onError(error);
      } catch {
        // Diagnostic callbacks must not prevent the detached worker.
      }
      try {
        child?.unref();
      } catch {
        // A failed spawn has no child process to release.
      }
      resolveSpawn(spawned);
    };

    try {
      child = spawn(
        workerNodeExecutable(process.env, nodeExecutable || "node"),
        [`${pluginRoot}/scripts/backlog-cc.mjs`, ...args],
        {
          cwd: project.root,
          detached: true,
          stdio: "ignore",
        },
      );
    } catch (error) {
      settle(false, error);
      return;
    }
    child.once("error", (error) => settle(false, error));
    child.once("spawn", () => settle(true));
  });
}

/** Start abandoned-session recovery without delaying the live session. */
export function sweepSessions({
  cwd,
  sessionId,
  source,
  pluginRoot,
  nodeExecutable = "node",
  onError = NOOP,
  onSpawn = NOOP,
}) {
  const args = ["sweep", String(sessionId ?? "")];
  if (includesSelf(source)) args.push("--include-self");
  return detachedCli({ cwd, pluginRoot, args, nodeExecutable, onError, onSpawn });
}

/**
 * Flush edited files in a detached child so teardown cannot cancel the write.
 *
 * The counters are frozen here, synchronously, before the child exists: that
 * child deletes the journal they are derived from, and a reader waiting for
 * the host process to exit would otherwise be racing it. Both hosts pass
 * through this function — OMP's `session_shutdown` handler and the SessionEnd
 * hook — so the summary lands once, wherever the session ended.
 *
 * A failed summary write is not allowed to cost the flush: counters are
 * diagnostics, the modified-file list is the work. Its outcome goes to
 * `onSummary`, never to `onError`: a spawn clears every failure recorded at or
 * before its own attempt, so a shared operation name would delete the summary's
 * failure microseconds after recording it, and leave it visible only in the one
 * case where the spawn failed too — under the wrong name.
 */
export function spawnFlush({
  cwd,
  sessionId,
  pluginRoot,
  nodeExecutable = "node",
  onError = NOOP,
  onSpawn = NOOP,
  onSummary = NOOP,
}) {
  let failure = null;
  try {
    const project = findProject(cwd || process.cwd());
    if (project) writeSessionSummary(project.root, sessionId);
  } catch (error) {
    failure = error;
  }
  try {
    onSummary(failure);
  } catch {
    // Diagnostic callbacks must not prevent the detached worker.
  }
  return detachedCli({
    cwd,
    pluginRoot,
    args: ["flush", String(sessionId ?? "")],
    nodeExecutable,
    onError,
    onSpawn,
  });
}

/** Produce the non-blocking context formerly emitted by UserPromptSubmit. */
export async function promptContext({ cwd, sessionId, prompt, now = Date.now }) {
  const project = findProject(cwd || process.cwd());
  if (!project) return null;

  const startedAt = now();
  const overBudget = () => now() - startedAt > scaledTimeout(PROMPT_BUDGET_MS);
  const text = typeof prompt === "string" ? prompt : "";
  const options = { cwd: project.root };
  const snapshot = readCache(project.root, sessionId) || {};
  const derived = deriveSession(project.root, sessionId);
  const cachedTaskId = snapshot.taskId ? String(snapshot.taskId) : null;
  const edits = derived.sourceEdits ?? 0;
  const blocks = [];

  let activeId = derived.taskId ?? cachedTaskId;
  let task = null;
  let identityEvent = null;
  /** @type {import("./types.mjs").ActiveTaskState["state"] | null} */
  let resolvedState = null;

  if (!overBudget() && (edits > 0 || !cachedTaskId)) {
    if (derived.stale || !cachedTaskId) {
      const resolved = await resolveActiveTask(options);
      resolvedState = resolved.state;
      const found = resolved.state === "branch" || resolved.state === "status" ? resolved.task : null;
      if (found) {
        task = found;
        activeId = found.id;
        identityEvent = { t: "identity", id: found.id };
      }
    } else {
      const view = await taskView(cachedTaskId, options);
      if (view.ok) {
        task = view.task;
        activeId = task.id;
      }
    }
  }

  const injected = new Set(snapshot.injectedTasks || []);
  let looked = 0;
  for (const candidate of taskIdCandidates(text)) {
    if (overBudget()) break;
    if (candidate === activeId || injected.has(candidate)) continue;
    if (looked >= CANDIDATE_LOOKUP_LIMIT) break;
    looked += 1;
    const view = await taskView(candidate, { ...options, timeoutMs: scaledTimeout(CANDIDATE_TIMEOUT_MS) });
    if (!view.ok) continue;
    blocks.push(renderForeignTask(view.task));
    injected.add(candidate);
    break;
  }

  if (edits > 0) {
    const observations = renderObservations(observe(task, derived));
    if (observations) blocks.push(observations);
  }
  if (resolvedState === "none" && !activeId && looksLikeBuildIntent(text)) blocks.push(renderIntentNudge());

  if (identityEvent) appendEvent(project.root, sessionId, identityEvent);
  updateCache(project.root, sessionId, { injectedTasks: [...injected] });
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}
