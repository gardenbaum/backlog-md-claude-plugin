---
description: Set a Backlog.md task to In Progress and read its brief.
argument-hint: <task-id>
---

The task to start is `$ARGUMENTS`. If that is empty, ask which task and stop.

**First, check what is already running:**

```bash
"${BACKLOG_MD_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/scripts/backlog-cc.mjs" active
```

- If the state is `status` or `branch` and the id is **not** the one requested,
  **report it and stop.** Say which task is currently active and ask whether to
  switch. Do not override it: a second task in the In Progress column makes the
  active task **ambiguous** for every hook in this session, and orientation
  stays degraded until someone empties the column again.
- If the state is `ambiguous`, report the candidates and ask which one to keep.
  Starting a third does not help.
- If the state is `unavailable`, **report it and stop.** The CLI is unreachable,
  the project is broken, or the "In Progress" status is misconfigured. Run
  `/backlog-md:doctor` to diagnose.
- If the state is `none` or the id matches what is already active, proceed:
  skip the status change (if needed) and go straight to the brief.

**Then set the status.** Use the native tool when it is available:

`backlog_task_start` with the task id.

It is not a wrapper around the CLI line below. It says so when the task has no
implementation plan, it names every other task still In Progress, and it
records both in this session's journal. Setting the status through the shell
records none of it: one session started a task with no plan, wrote the whole
implementation and finished, and the plugin's own measurements called it a
clean run because the only counter that would have said otherwise is written
by the tool that was never called.

Only if that tool is absent:

```bash
backlog task edit $ARGUMENTS -s "In Progress"
```

**Then read the brief:**

```bash
"${BACKLOG_MD_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/scripts/backlog-cc.mjs" brief $ARGUMENTS
```

The brief is the task's own content — acceptance criteria, plan, notes,
blocking dependencies. Read it as the specification for what follows.

If it shows no implementation plan, run `/backlog-md:plan` before writing code.
If it shows blocking dependencies that are not Done, say so: the task was
started anyway, and that is worth naming out loud.
