---
description: Turn an idea into proposed Backlog.md tasks, for review before anything is created.
argument-hint: <idea>
---

The idea is: `$ARGUMENTS`. If that is empty, ask what to decompose and stop.

**Dispatch the `backlog-decomposer` agent** with the idea, and tell it the
repository it is working in. It reads a lot of code, which is why it has its
own context window.

**If the dispatch fails, retry it once and no more.** A host that has no
subagents, or whose dispatch tool rejects the call twice, is not going to
accept the third attempt. Read
`${CLAUDE_PLUGIN_ROOT}/agents/backlog-decomposer.md`, do that research inline
in this session, and carry on to checkpoint 1 — saying that the agent was
unavailable. A decomposition done here is worth more than a dispatch that never
lands.

**When it returns — this is checkpoint 1.** Present its proposals to the user
as a short list: title, one line of intent, the acceptance criteria count, and
the milestone if it named one. Show the duplicates it found first if there are
any; an idea that is already tracked ends here.

**Wait for approval.** Then create only what was approved, one call per task,
in dependency order so every dependency names an id that already exists:

- `backlog_task_create` takes `title`, `description`, `acceptanceCriteria` and
  `dependencies` — the ids this task waits for. A decomposition is a
  dependency graph; created without them it is a list, and nothing downstream
  can tell what is ready.
- A task that waits for nothing leaves `dependencies` out. The first task
  always does, and so does every independent one. Never invent a predecessor
  to give a task an edge, and never hold back a task because it would have none.
- `milestone` only when the proposal named one. `parent` only for a subtask,
  and never a milestone id.
- Create parents before children, and dependencies before dependents.
- Report the ids that were created. If one call fails, stop and report rather
  than continuing: half a decomposition with broken dependencies is worse than
  none.

**Only if the native tools are absent here**, the same graph through the CLI,
one command per task:

```bash
backlog task create 'Title' -d 'Description' --ac 'First criterion' --ac 'Second criterion' --dep TASK-4 -m 'Milestone title'
```

Rules that matter for that form:

- Add `-m 'Milestone title'` only when the proposal named one; leave it off
  otherwise. `-m`/`--milestone` assigns by existing milestone id or title.
- Same for `--dep`: a task with no predecessor is created without it.
- Multi-line values: repeated `--append-*` flags, one invocation per line, is the recommended form. A real newline inside the quoted value works too. A literal `\n` does not — it is stored as text.
- Single-quote any value containing backticks. Inside double quotes they are command substitution, and the original text cannot be recovered afterwards.

<!-- 22.08.26 claude (BCC-44): no draft mode here, decided rather than
     overlooked. Backlog.md drafts fit unripe scope, but a draft cannot be
     named as a dependency — `task create --draft --dep DRAFT-1` is refused
     with "the following dependencies do not exist" and creates nothing
     (measured on 1.50.1) — and promotion renumbers DRAFT-n to TASK-n. A
     decomposition is a dependency graph, so the detour would mean creating
     drafts, promoting them, and wiring every --dep in a third pass, with the
     graph absent in between. Checkpoint 1 already puts the review before the
     first write, which is what a draft round would buy. Reopen only if
     drafts learn to hold dependencies. -->


