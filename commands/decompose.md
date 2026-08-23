---
description: Turn an idea into proposed Backlog.md tasks, for review before anything is created.
argument-hint: <idea>
---

The idea is: `$ARGUMENTS`. If that is empty, ask what to decompose and stop.

**Dispatch the `backlog-decomposer` agent** with the idea, and tell it the
repository it is working in. It reads a lot of code, which is why it has its
own context window.

**When it returns — this is checkpoint 1.** Present its proposals to the user
as a short list: title, one line of intent, the acceptance criteria count, and
the milestone if it named one. Show the duplicates it found first if there are
any; an idea that is already tracked ends here.

**Wait for approval.** Then create only what was approved, one command per
task, in dependency order so `--dep` can name real ids:

```bash
backlog task create 'Title' -d 'Description' --ac 'First criterion' --ac 'Second criterion' --dep TASK-4 -m 'Milestone title'
```

Rules that matter here:

- Add `-m 'Milestone title'` only when the proposal named one; leave it off
  otherwise. `-m`/`--milestone` assigns by existing milestone id or title.
- Multi-line values: repeated `--append-*` flags, one invocation per line, is the recommended form. A real newline inside the quoted value works too. A literal `\n` does not — it is stored as text.
- Single-quote any value containing backticks. Inside double quotes they are command substitution, and the original text cannot be recovered afterwards.
- Create parents before children, and dependencies before dependents — `--dep`
  needs an id that exists.
- Report the ids that were created. If one command fails, stop and report
  rather than continuing: half a decomposition with broken dependencies is
  worse than none.

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


