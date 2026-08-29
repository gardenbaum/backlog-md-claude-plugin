import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import { taskIdCandidates, resolveActiveTask } from "./active-task.mjs";
import { taskView } from "./backlog.mjs";
import { mutatesBacklog, writesTaskNotes } from "./bash.mjs";
import { buildBrief } from "./brief.mjs";
import { appendEvent, deriveSession, readCache, updateCache } from "./cache.mjs";
import { denyReason } from "./deny.mjs";
import { looksLikeBuildIntent, observe } from "./observations.mjs";
import { classifyBacklogPath, findProject } from "./paths.mjs";
import { renderForeignTask, renderIntentNudge, renderObservations } from "./render.mjs";
import { includesSelf } from "./session-sweep.mjs";

const CANDIDATE_LOOKUP_LIMIT = 3;
const CANDIDATE_TIMEOUT_MS = 1000;
const PROMPT_BUDGET_MS = 4000;
const WRITE_TOOLS = new Set(["write", "edit", "notebookedit", "ast_edit"]);

function normaliseToolName(name) {
  return typeof name === "string" ? name.toLowerCase() : "";
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
 * Decide whether a direct file-writing tool must be redirected to Backlog.md's CLI.
 * Returns null when the plugin has no positive reason to intervene.
 */
export function evaluateToolGuard({ cwd, toolName, toolInput = {}, guard = process.env.BACKLOG_MD_GUARD }) {
  if (!isWritingTool(normaliseToolName(toolName), toolInput)) return null;
  const project = findProject(cwd || process.cwd());
  if (!project) return null;

  for (const target of toolTargetPaths(toolInput)) {
    const classification = classifyBacklogPath(target, project);
    if (!classification.managed) continue;
    return {
      block: guard !== "0",
      reason: denyReason(classification, reasonInput(toolInput)),
      target,
    };
  }
  return null;
}

/** Record a successful tool's effect in the append-only session journal. */
export function recordToolActivity({ cwd, sessionId, toolName, toolInput = {}, toolDetails, isError = false }) {
  if (isError) return;
  const project = findProject(cwd || process.cwd());
  if (!project) return;

  const name = normaliseToolName(toolName);
  if (name === "bash") {
    const command = toolInput && typeof toolInput === "object" ? Reflect.get(toolInput, "command") : undefined;
    if (!mutatesBacklog(command)) return;
    appendEvent(project.root, sessionId, { t: "stale" });
    if (writesTaskNotes(command)) appendEvent(project.root, sessionId, { t: "notes" });
    return;
  }
  if (!isWritingTool(name, toolInput)) return;
  if (name === "ast_edit" && toolDetails?.applied === false) return;

  const targets = toolTargetPaths(toolInput, toolDetails);
  for (const target of targets) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue;
    if (classifyBacklogPath(target, project).managed) continue;
    const relativePath = relative(project.root, resolve(project.root, target));
    if (!relativePath || relativePath.startsWith("..")) continue;
    appendEvent(project.root, sessionId, { t: "edit", p: relativePath });
  }
}

/** Build the session brief and record the event in the session cache. */
export async function sessionContext({ cwd, sessionId, event }) {
  const { context } = await buildBrief({ cwd, sessionId, event });
  return context;
}

function detachedCli({ cwd, pluginRoot, command, sessionId, nodeExecutable }) {
  const project = findProject(cwd || process.cwd());
  if (!project || !pluginRoot) return false;
  const child = spawn(
    nodeExecutable || "node",
    [`${pluginRoot}/scripts/backlog-cc.mjs`, command, String(sessionId ?? "")],
    {
      cwd: project.root,
      detached: true,
      stdio: "ignore",
    },
  );
  child.on("error", () => {});
  child.unref();
  return true;
}

/** Start abandoned-session recovery without delaying the live session. */
export function sweepSessions({ cwd, sessionId, source, pluginRoot, nodeExecutable }) {
  const project = findProject(cwd || process.cwd());
  if (!project || !pluginRoot) return false;
  const args = [`${pluginRoot}/scripts/backlog-cc.mjs`, "sweep", String(sessionId ?? "")];
  if (includesSelf(source)) args.push("--include-self");
  const child = spawn(nodeExecutable || "node", args, { cwd: project.root, detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return true;
}

/** Flush edited files in a detached child so teardown cannot cancel the write. */
export function flushSession({ cwd, sessionId, pluginRoot, nodeExecutable }) {
  return detachedCli({ cwd, pluginRoot, command: "flush", sessionId, nodeExecutable });
}

/** Produce the non-blocking context formerly emitted by UserPromptSubmit. */
export async function promptContext({ cwd, sessionId, prompt, now = Date.now }) {
  const project = findProject(cwd || process.cwd());
  if (!project) return null;

  const startedAt = now();
  const overBudget = () => now() - startedAt > PROMPT_BUDGET_MS;
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
    const view = await taskView(candidate, { ...options, timeoutMs: CANDIDATE_TIMEOUT_MS });
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
