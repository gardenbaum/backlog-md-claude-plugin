---
name: backlog-workflow
description: Use when working in a repository that has a Backlog.md backlog — how to pick up, record and finish work through the CLI, what the plugin's commands do, and what a redirected write means.
---

# Backlog.md workflow

This repository's work is tracked by Backlog.md. The task file is the unit of
work, and the CLI owns it.

## Read the canonical instructions first

Backlog.md ships its own workflow guide, and it is the authority — this skill
does not restate it. Once per session, before touching a task:

```bash
backlog instructions overview
```

When you start executing a task, read `backlog instructions task-execution`.
When you finish one, read `backlog instructions task-finalization`. They are
short and they are current; this file is not a substitute.

## What this plugin adds

| Command | Use it when |
|---|---|
| `/backlog-md:next` | You need work and no task is active. Proposes one ready task. |
| `/backlog-md:start <id>` | You know which task to work on. Sets it In Progress and shows the brief. |
| `/backlog-md:decompose <idea>` | An idea is bigger than one task. Returns proposals for review. |
| `/backlog-md:plan` | The active task has no implementation plan yet. |
| `/backlog-md:verify` | Before claiming a task is done. Maps each criterion to evidence. |
| `/backlog-md:finish` | The work is verified and you are closing the task out. |
| `/backlog-md:doctor` | Something about the integration is not behaving. |
| `/backlog-md:setup` | First run in a repository — git hooks, reachability. |

The session's active task is injected at session start and again after
compaction. You do not need to ask which task is active; if the injection said
there is none, there is none.

## When a write is redirected

Editing a file under the backlog directory with `Write` or `Edit` is denied,
and the denial names the CLI command that does the same thing properly. This is
a signpost, not an error and not a permissions problem: the frontmatter,
checklist indices and cross-task relationships in those files are maintained by
the CLI, so a hand-edit can corrupt metadata that later reads depend on. Run
the command it names.

The one situation where this is worth arguing with: if the command it names is
wrong for what you were trying to do, say so rather than working around the
deny. `BACKLOG_MD_GUARD=0` downgrades it to a warning, and is for the person
running the session to set, not for you.

## Quoting

Three hazards, all of which bite agents harder than humans:

- Multi-line values: repeated `--append-*` flags, one invocation per line, is the recommended form. A real newline inside the quoted value works too. A literal `\n` does not — it is stored as text.
- Never use ANSI-C quoting such as `$'a\nb'` — the tree-sitter-based sandbox agents run in rejects it (Backlog.md issue #595).
- Single-quote any value containing backticks. Inside double quotes they are command substitution, and the original text cannot be recovered afterwards.

## Evidence, not ticks

An acceptance criterion is checked when there is something that demonstrates
it — a test that fails without the change, an observable behaviour, a
measurement. Name the evidence, then check the box:

```bash
backlog task edit TASK-12 --check-ac 3
```

If a criterion cannot be demonstrated, leave it open and say why. An unchecked
criterion with a reason is worth more than a checked one without.
