---
description: Turn an idea into proposed Backlog.md tasks, for review before anything is created.
argument-hint: <idea>
---

The idea is: `$ARGUMENTS`. If that is empty, ask what to decompose and stop.

**Dispatch the `backlog-decomposer` agent** with the idea and the repository
path, verbatim and nothing else. That dispatch is this command's first tool
call: no `ls`, no `find`, no `grep`, no `backlog task list` before it, and
nothing appended to the idea — no file layout, no schema fields, no
constraints, no restatement of the agent's own job. Finding duplicates and
sizing the work are the first two things its own prompt has it do, and a
briefing turns checkpoint 1 into a review of your own guess: one run spent ten
orientation commands on the context window this agent has its own of, then
told it which schema fields the collection has, and got back an acceptance
criterion that was a checklist of exactly those fields. Another that dictated
the criteria got back one no measurement could fail.

**If the dispatch fails, read what it says.** A rejection that names what the
call is missing — a field, an array, a shape — is about the call, not the
agent: fix it and send it again. One host turned this dispatch down three times
over the shape of the arguments and accepted the fourth. An unknown agent, no
subagent support, or the same rejection twice ends it — read
`${CLAUDE_PLUGIN_ROOT}/agents/backlog-decomposer.md`, do that research inline
in this session, and carry on to checkpoint 1 — saying that the agent was
unavailable. A decomposition done here is worth more than a dispatch that never
lands.

**When it returns — this is checkpoint 1.** Present its proposals to the user
as a short list: title, one line of intent, and the milestone if it named one.
Write the acceptance criteria out in full when there are three tasks or fewer;
above that, their count. They are what the work will be measured against, and a
criterion carrying two assertions is invisible in a count — one run approved
"9 acceptance criteria" unseen, and one of those nine, "3-5 inhaltliche
Hauptabschnitte", was later ticked over a post with six. Show the duplicates it
found first if there are any; an idea that is already tracked ends here.

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
- Multi-line values: repeated `--append-plan`, `--append-notes` or `--append-final-summary` flags, one invocation per line, is the recommended form. Those three are the only append flags there are — acceptance criteria are added with `--ac` and replaced with `--acceptance-criteria`. A real newline inside the quoted value works too. A literal `\n` does not — it is stored as text.
- Single-quote any value containing backticks. Inside double quotes they are command substitution, and the original text cannot be recovered afterwards.
- One `backlog` command at a time. Backlog.md locks a task per process, so several issued in one parallel batch fail with `is being modified by another process` — twelve did in one run, and the retries re-applied what had already landed. Wait for each to return before sending the next.

**Creating them is where this command ends.** Implementation starts with
`/backlog-md:start <id>`, which checks what is already active, reads the brief
and asks for a plan before any code. A session that slides from creating a task
straight into doing it starts it after the fact, and the plan is never written.

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


