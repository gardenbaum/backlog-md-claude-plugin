---
description: Walk a Backlog.md task to Done — verify, definition of done, final summary, status, commit.
---

Do these in order and stop at the first one that fails.

**Find the task:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/backlog-cc.mjs" active
```

If the state is not `status` or `branch`, there is no single active task — say
so and stop. `ambiguous`, `none` and `unavailable` each mean the id is not
known, and this command writes more than any other: a wrong guess here checks
boxes, writes a summary and sets Done on somebody else's task.

Every `TASK-12` below stands for the id this step resolved. It is an example,
never the id to operate on.

**1. Verify.** Run `/backlog-md:verify`'s flow: dispatch the
`backlog-verifier` agent and present its table. Both of that flow's gates
apply here unchanged — the one for checking a `met` criterion and the one for
unchecking a criterion the verifier found `not met`; read them there rather
than from a paraphrase here, and do not move a box either way without
approval. If any acceptance criterion is `not met`, stop here and report. A task with an unmet criterion is not
finished, and finishing it anyway is the one thing this command exists to
prevent.

**2. Definition of done.** Read it from the task:

```bash
backlog task TASK-12 --json
```

Walk each `definitionOfDone` item and say, per item, whether it holds and why.
Check only the ones that do:

```bash
backlog task edit TASK-12 --check-dod 2
```

**3. Final summary.** Write what changed and why, in the task, not in the chat.
One call per line:

```bash
backlog task edit TASK-12 --append-final-summary 'Replaced the inline parser with lib/parse.mjs.'
backlog task edit TASK-12 --append-final-summary 'Behaviour unchanged; adds a regression test for the missing-file case.'
```

**4. Status.** Only after 1–3:

```bash
backlog task edit TASK-12 -s "Done"
```

**5. Propose the commit.** Show the message and wait for approval; do not
commit unasked. If the git hooks are installed, `prepare-commit-msg` adds the
`Task: <id>` trailer itself — you do not need to write one by hand. (Writing
one yourself does not duplicate it: the hook detects an existing trailer and
leaves it alone. Do it only to attribute the commit to a different task than
the one the hook would resolve.)

Two things not to do here: do not check a criterion that the verifier did not
call met, and do not set `Done` while a blocking dependency is still open —
report that instead, because it usually means the dependency is stale rather
than the task being wrong.

Afterwards, `backlog cleanup` moves old Done tasks out of the board into the
completed folder. Mention it when the Done column has grown; never run it. It
is interactive, it moves files, and which tasks leave the board is the user's
call, not a side effect of finishing one task.
