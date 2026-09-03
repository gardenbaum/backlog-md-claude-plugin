---
name: backlog-workflow
description: Use when working in a repository that has a Backlog.md backlog — how to pick up, record and finish work through the CLI, what the plugin's commands do, and what a redirected write means.
hide: true
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

- Multi-line values: repeated `--append-plan`, `--append-notes` or `--append-final-summary` flags, one invocation per line, is the recommended form. Those three are the only append flags there are — acceptance criteria are added with `--ac` and replaced with `--acceptance-criteria`. A real newline inside the quoted value works too. A literal `\n` does not — it is stored as text.
- Never use ANSI-C quoting such as `$'a\nb'` — the tree-sitter-based sandbox agents run in rejects it (Backlog.md issue #595).
- Single-quote any value containing backticks. Inside double quotes they are command substitution, and the original text cannot be recovered afterwards.
- One `backlog` command at a time. Backlog.md locks a task per process, so several issued in one parallel batch fail with `is being modified by another process` — twelve did in one run, and the retries re-applied what had already landed. Wait for each to return before sending the next.

## Evidence, not ticks

An acceptance criterion is checked when there is something that demonstrates
it — a test that fails without the change, an observable behaviour, a
measurement. Name the evidence, then check the box:

```bash
backlog task edit TASK-12 --check-ac 3
```

If a criterion cannot be demonstrated, leave it open and say why. An unchecked
criterion with a reason is worth more than a checked one without.

## Splitting a criterion that carries two assertions

One checkbox over two requirements cannot record that one of them holds, and
the half that fails is the half that gets waved through. When a criterion joins
its requirements with "and", a semicolon, or a list of three or more, split it
before anything is measured against it.

`backlog_edit_ac` does it in one call: `remove` takes the indices to drop —
all resolved against the list as it stands, so no counting backwards — and
`add` takes the replacements. Through the CLI it is one `backlog task edit`
with `--remove-ac` and repeated `--ac`, and two costs the CLI does not mention:
added criteria land at the end rather than in the removed one's place, and the
replacement form (`--clear-ac` with `--acceptance-criteria`) clears every
checkmark on the task. Pass the whole list as `criteria` to `backlog_edit_ac`
when the order matters — it restores the checkmarks of the criteria whose text
is unchanged, which the CLI cannot do.
