---
description: Propose the next ready Backlog.md task, and start it once the user agrees.
---

Find the ready work:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/backlog-cc.mjs" next
```

Then:

1. **Present the top candidate** with one sentence on why it is first — its
   priority, and what it unblocks if anything. Mention the runners-up in one
   line each.
2. **Ask, and wait.** Which task to work on is the user's decision, not a
   ranking's. Do not set any status before they answer.
3. **On agreement**, run `/backlog-md:start <id>`. This command first checks
   what is already running and may refuse if another task is active or the
   state is ambiguous. It reads the brief on success.

If the output says there is no ready task, do not invent one. Report what is
blocking the column and stop — that output already names the project's
configured column and the exact `backlog task list -s '<status>'` command to
see what is waiting on a dependency there. Do not substitute "To Do" for it;
a renamed column makes that name wrong.

If the command prints nothing at all, this is not a Backlog.md project or the
CLI is unreachable; run `/backlog-md:doctor`.
