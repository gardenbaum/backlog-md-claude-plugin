---
description: Backlog.md task ownership and completion contract
alwaysApply: true
---

When this repository has a `backlog/` directory, the Backlog.md task is the work unit and its files belong to the Backlog tools.
They supersede the Backlog.md CLI instructions; do not read `backlog instructions`.
Follow this order: `backlog_next`, `backlog_task_start`, `backlog_task_plan`, work, `backlog_check_ac` for every criterion, then `backlog_task_finish`.
If no task covers the request, create one with `backlog_task_create` first.
The built-in todo list organises the steps inside a task; it does not replace the task.
Check each criterion with `backlog_check_ac` and named evidence that demonstrates it.
Never mutate a task through file tools or a handwritten shell command when a Backlog tool exists.
If these tools are not available in this session, keep the same order using the `backlog` CLI.
If no `backlog/` directory exists, this contract does not apply.
