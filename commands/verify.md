---
description: Check the active Backlog.md task's acceptance criteria against real evidence.
---

**Find the task:**

```bash
"${BACKLOG_MD_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/scripts/backlog-cc.mjs" active
```

If there is no single active task, say so and stop.

**Dispatch the `backlog-verifier` agent** with the task id. It maps each
criterion to evidence and returns a verdict table. It never ticks a box.

**If the dispatch fails, retry it once and no more.** Read
`${CLAUDE_PLUGIN_ROOT}/agents/backlog-verifier.md`, gather that evidence
inline in this session, and build the same table — saying that the agent was
unavailable. Every gate below still applies; a table you wrote yourself is not
a licence to check a box without asking.

**Present the table unchanged.** Do not upgrade a verdict. If the verifier said
`unverifiable`, the criterion is unverifiable, and the useful next step is
deciding whether the criterion is wrong.

**Then ask, and wait for approval,** on which of the `met` criteria to check,
and run only those:

```bash
backlog task edit TASK-12 --check-ac 1 --check-ac 3
```

Indices are 1-based and come from the task's own JSON — never counted by hand
from the rendered brief.

**A criterion that is already checked and comes back `not met` runs the same
gate in reverse.** Present the verdict, propose the uncheck, wait for approval,
and only then:

```bash
backlog task edit TASK-12 --uncheck-ac 2
```

Neither half is optional. Leaving the tick standing publishes a verified
criterion that was just disproved, and the next reader has no way to tell;
removing it unasked is the same unilateral write the checking gate exists to
prevent, in the direction that loses information.

If nothing is met, that is the report. Say what is missing and stop; a task is
not closer to done because it was verified.
