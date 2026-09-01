---
description: Backlog.md task ownership and completion contract
alwaysApply: true
---

The Backlog.md task is the work unit and its files belong to the Backlog tools.
They supersede the Backlog.md CLI instructions; do not read `backlog instructions`.
Follow this order: `backlog_next`, `backlog_task_start`, `backlog_task_plan`, work, `backlog_check_ac` with named evidence for every criterion, then `backlog_task_finish`.
If no task covers the request, create one with `backlog_task_create` first, naming its dependencies there.
The built-in todo list organises the steps inside a task; it does not replace the task.
Never mutate a task through file tools or a handwritten shell command when a Backlog tool exists.
For a status change no tool covers, such as back to To Do: `backlog task edit <id> -s '<status>'`.
If these tools are not available in this session, keep the same order using the `backlog` CLI.
If no `backlog/` directory exists, this contract does not apply.
