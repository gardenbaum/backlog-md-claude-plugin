---
description: Research the active Backlog.md task and record an implementation plan, after review.
---

**Find the task:**

```bash
"${BACKLOG_MD_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/scripts/backlog-cc.mjs" active
```

If the state is not `status` or `branch`, there is no single active task — say
so and stop. `/backlog-md:next` picks one; guessing does not.

**Dispatch the `backlog-planner` agent** with the task id. It researches and
returns a plan. It does not write it.

**When it returns — this is checkpoint 2.** Present the plan. Lead with
anything the planner flagged as disagreeing with the task description, or as
already implemented; those change what should be built and are easy to miss in
the middle of a list.

**Wait for approval, then record it** — one call per line, because `\n` is not
converted:

```bash
backlog task edit TASK-12 --append-plan '1. Extract the parser into lib/parse.mjs'
backlog task edit TASK-12 --append-plan '2. Add the failing test for a missing file'
```

Use `--plan` instead of `--append-plan` only when replacing a plan the user
asked you to replace; `--plan` overwrites.

Then **stop**. This command plans. Implementing is the next conversation turn,
against the plan the user just approved.
