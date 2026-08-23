#!/usr/bin/env node
import { relative, resolve } from "node:path";
import { readHookInput, guard } from "../lib/protocol.mjs";
import { findProject, classifyBacklogPath } from "../lib/paths.mjs";
import { mutatesBacklog, writesTaskNotes } from "../lib/bash.mjs";
import { appendEvent } from "../lib/cache.mjs";

// Emits nothing: the tool has already run. Remembers what happened and stays
// cheap — it fires on every edit, so it never spawns the backlog CLI.
//
// Append-only, never a read-modify-write of the snapshot: Claude Code
// dispatches tool calls in parallel and that pattern loses updates (measured:
// 3-4 of 6 concurrent edits landed).
guard(
  async () => {
    const input = await readHookInput();
    const project = findProject(input.cwd || process.cwd());
    if (!project) return;

    const sessionId = input.session_id;
    const toolInput = input.tool_input || {};

    if (input.tool_name === "Bash") {
      const command = toolInput.command;
      if (!mutatesBacklog(command)) return;
      // Every mutation makes the cached task facts suspect, so every one
      // appends `stale` — including a notes-writing one, which can change
      // status in the same command. A notes write additionally appends
      // `notes`, so `editsAtLastNotes` still tracks it.
      appendEvent(project.root, sessionId, { t: "stale" });
      if (writesTaskNotes(command)) appendEvent(project.root, sessionId, { t: "notes" });
      return;
    }

    const target = toolInput.file_path || toolInput.notebook_path;
    if (!target) return;
    if (classifyBacklogPath(target, project).managed) return;

    const relativePath = relative(project.root, resolve(project.root, target));
    if (!relativePath || relativePath.startsWith("..")) return;

    appendEvent(project.root, sessionId, { t: "edit", p: relativePath });
  },
  { event: "PostToolUse" },
);
