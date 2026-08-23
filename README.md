# backlog-md

A [Claude Code](https://claude.com/product/claude-code) plugin for the
[Backlog.md](https://github.com/MrLesk/Backlog.md) task manager. It keeps a
session oriented on the task it is working on — at session start, and again
after context compaction — and it routes every backlog mutation through the
`backlog` CLI that owns the files, rather than letting an editor tool touch
them directly.

This is a community plugin, not affiliated with or endorsed by the upstream
Backlog.md project.

## Requirements

- Node 18 or newer.
- `backlog` on your `PATH` (`npm i -g backlog.md`).
- A repository where `backlog init` has already been run.

Without any of these the plugin is a silent no-op. Windows is untested and
not claimed.

## Install

Add this repository as a plugin marketplace, then install from it:

```
/plugin marketplace add gardenbaum/backlog-md-claude-plugin
/plugin install backlog-md@gardenbaum
```

Then run `/backlog-md:setup` — it diagnoses the install and offers to install
the optional git hooks. Do this before anything else; every other command
assumes a working `backlog` and a discovered project.

## What happens without you asking

Five hooks, none of which need to be invoked:

| Hook | What it does |
|---|---|
| `SessionStart` | Injects the active task — acceptance criteria, definition of done, plan, blocking dependencies, description, references, documentation, the most recent comments, recent notes — so the session opens already oriented. Its matcher covers `startup`, `resume`, `clear` and `compact`, so the same brief arrives again on the other side of a compaction. |
| `UserPromptSubmit` | A turn-boundary observation: surfaces a task named in the prompt that isn't the active one, reports what changed on the active task since it was last checked, and nudges toward starting a task before writing code — only when the CLI positively reports an empty In Progress column, never when it could not answer. Never blocks. |
| `PostToolUse` | The other turn-boundary observation: records edited files and backlog-mutating `Bash` commands for `UserPromptSubmit` and `SessionEnd` to read later. Never denies, never calls the CLI itself. |
| `SessionEnd` | The modified-file flush: writes the session's edited-file list onto the active task, then discards the session's cache. Handed to a detached child, because Claude Code cancels a hook still running while it shuts down. |
| `PreToolUse` | The redirect of hand-edits to the CLI: denies a `Write`/`Edit`/`NotebookEdit` aimed at a Backlog.md-managed file and names the `backlog` command that should have been run instead. The plugin's only `deny`. |

The active task is resolved by checking the current branch name for a task id
first, then by finding exactly one task in the `In Progress` column. More
than one candidate is reported as ambiguous rather than guessed.

## What it costs

Measured, not estimated: `node scripts/measure-latency.mjs` drives each hook
the way Claude Code does — one process, JSON on stdin — against a throwaway
copy of this repository's own backlog, and reads the milliseconds each hook
records with `BACKLOG_MD_DEBUG=1`. 15 runs per row, Apple silicon, Node 24,
44 task files, machine otherwise idle.

| | in hook | p95 | whole process |
|---|---|---|---|
| `PreToolUse` (allow, and deny) | 4ms | 5ms | 59ms |
| `PostToolUse` | 5ms | 8ms | 57ms |
| `UserPromptSubmit`, no edits since the last turn | 4ms | 5ms | 59ms |
| `SessionEnd` | 10ms | 41ms | 97ms |
| `UserPromptSubmit`, after edits | 242ms | 261ms | 297ms |
| `SessionStart` | 699ms | 870ms | 756ms |
| `UserPromptSubmit`, prompt naming three unknown task ids | 992ms | 2185ms | 1053ms |

The second column is what the plugin controls; the third adds Node's own
startup, which the session waits for as well — about 55ms, and the floor for
any hook at all. The split in the table is one thing: whether the hook had to
call the `backlog` CLI. Everything that does costs several hundred
milliseconds, because one CLI call is ~250ms on this machine; everything that
does not is single-digit milliseconds. That is why `UserPromptSubmit` gates
its identity refetch on there having been edits — most turns skip it and cost
4ms.

The one expensive row that happens every session is `SessionStart`, and the
per-turn worst case — a prompt naming three task ids that do not exist, each
looked up and each missing — stays around a second, inside that hook's own 4s
budget and well inside `guard()`'s 5s watchdog. `CANDIDATE_LOOKUP_LIMIT` is 3
for that reason and was left there.

`SessionEnd` sits with the cheap rows because it does not wait for its own
work: it hands the flush to a detached child and returns. It used to cost
449ms in-hook, and Claude Code aborts a hook that is still running while it
shuts down — quitting reported `SessionEnd hook failed: Hook cancelled` and
left the flush to the next session's sweep. Detached, the child outlives the
shutdown and the hook itself costs 10ms.

Under concurrent load the same script measured roughly double throughout
(`SessionStart` 1.33s median), so on a slower machine, a network filesystem,
or a much larger backlog, read these as the optimistic end.

Backlog.md's own `checkActiveBranches` and `remoteOperations` are both `true`
by default, which lets `task list` reach the remote. Every number above was
measured on a repository where that costs nothing; on a large one with a slow
remote it can outlast the hooks' 3s CLI budget, and a brief that times out is
not a slow brief but an absent one — the injection degrades to `unavailable`.
`/backlog-md:doctor` prints both values with that consequence, so the
diagnosis names it before someone has to guess.

## Commands

| Command | Does |
|---|---|
| `/backlog-md:doctor` | Diagnose the plugin — CLI reachability, project discovery, active task, cache, and hook health. |
| `/backlog-md:next` | Propose the next ready task, and start it once you agree. |
| `/backlog-md:start` | Set a task to In Progress and read its brief. |
| `/backlog-md:decompose` | Turn an idea into proposed tasks, for review before anything is created. |
| `/backlog-md:plan` | Research the active task and record an implementation plan, after review. |
| `/backlog-md:verify` | Check the active task's acceptance criteria against real evidence. |
| `/backlog-md:finish` | Walk a task to Done — verify, definition of done, final summary, status, commit. |
| `/backlog-md:setup` | First-run setup — diagnosis and the optional git hooks. |

`decompose`, `plan`, and `verify` each dispatch a read-only agent
(`backlog-decomposer`, `backlog-planner`, `backlog-verifier`) that researches
or proposes in its own context window and returns text; the command itself
still performs any mutation, after you've reviewed it.

## The design position

*Add context, do not remove capability.* Every hook above only ever injects
information or records it for later — the one exception is the single guard
in `PreToolUse`, and even that doesn't make anything impossible, it makes one
thing correct: a hand-edit of a task gets redirected to the CLI command that
should have made the change. This project's own manifesto names complexity
creep as a risk in itself, and a tool that blocks a person's own commit is
enforcing discipline nobody asked it to enforce. One guard, one switch — no
gates on commits, no gates on plans.

## The switch

`BACKLOG_MD_GUARD=0` turns the `PreToolUse` deny into a warning: the edit
goes through, and the same redirect message is injected as context instead of
blocking it. On by default.

`BACKLOG_MD_DEBUG=1` appends one JSONL record per hook run — hook, event,
elapsed milliseconds, and the error message and stack when there was one — to
`$XDG_STATE_HOME/backlog-md-cc/debug.jsonl` (`~/.local/state/...` by default;
`doctor` prints the path). Off by default, and with it unset nothing is read,
written or created. It exists because every hook body runs inside a guard that
swallows exceptions, which is right for the session and leaves nobody a way to
see why a hook silently did nothing. Writing the log is best-effort: an
unwritable location costs the hook nothing.

There is no configuration file — these two environment variables are the only
knobs.

## The git hooks

`/backlog-md:setup` offers two, both optional and both fail-open:
`prepare-commit-msg` appends a `Task: <id>` trailer, and `pre-commit` rejects
a staged task file the CLI can no longer read.

Neither depends on where the plugin happens to live. Each one resolves it when
it runs, in this order: `git config backlog-md.pluginRoot` (recorded by the
installer, and the way to point a hook at a development checkout), the path
noted at install time, `CLAUDE_PLUGIN_ROOT`, and finally the newest
`~/.claude/plugins/cache/*/backlog-md/*` that holds the plugin. Nothing found
means the hook exits 0 and the commit proceeds — an uninstalled plugin must
not be able to block a commit. `lib/plugin-root.mjs` is the
reference implementation of that order, each hook carries its own copy in
POSIX sh so that no hook depends on a second file being present, and
`/backlog-md:doctor` reports what the installed hooks resolve to.

Because of that, `install-hooks --shared` — which writes the hooks into a
committed `.githooks` directory and sets `core.hooksPath` — writes no path
specific to the machine that ran it. A teammate needs the plugin installed,
not a second run of the installer.

Where the hooks go is git's answer, not a guess: `git rev-parse --git-path
hooks` covers a `core.hooksPath` somebody set and the indirection a worktree
adds. A `core.hooksPath` this installer did not set belongs to another tool —
beads, husky, lefthook — and is refused rather than used or replaced: nothing
is written, the value is left alone, and the message says to chain the
templates in `git/` from the hooks already there. `--force` overrides, keeping
whatever it replaces as `<name>.backlog-md.bak`. `/backlog-md:doctor` also
reports the state in between, hooks of ours in `.git/hooks` that git no longer
reads.

## Limitations

- `git commit --no-verify` bypasses the pre-commit check, and the hook only
  exists on a machine where somebody installed it. It is a tripwire against
  mistakes, not a control. The gate is in CI: the `tasks` job runs
  `backlog-cc check-tasks` over every task file on the branch, where a
  bypassed hook cannot hide a broken one.
- Backlog.md's own `bypassGitHooks: true` is the same bypass without anyone
  typing it: the CLI then commits with `--no-verify`, so the tripwire runs on
  no commit Backlog.md makes. `autoCommit: true` compounds it — the CLI
  commits every task write itself, so the `SessionEnd` flush of modified files
  becomes a commit nobody reviewed, and `prepare-commit-msg` attaches a
  `Task:` trailer to it. Neither setting is wrong, and this plugin does not
  change them; `/backlog-md:doctor` reads both and prints the consequence, so
  the interaction is visible rather than surprising.
- The pre-commit check reads the staged content by copying it into a
  throwaway project and asking the CLI to read it there. That costs a temp
  directory and one `git show` per staged task file, and it means the check
  cannot see a task the commit does not touch.
- The `PreToolUse` guard matches `Write|Edit|NotebookEdit`, not `Bash`, so a
  shell write to a task file is not redirected: `sed -i`, `echo >`, `tee`, an
  in-place editor, anything that reaches the file without an editor tool. This
  is not defended, deliberately. Recognising a write in a shell command means
  parsing shell — redirections, pipelines, `sh -c`, aliases, an editor nobody
  thought of — and a guard that gets that wrong either blocks legitimate work
  or gives false assurance. The guard is a signpost against reaching for the
  wrong tool by habit, not a control against someone routing around it. The
  pre-commit hook catches part of what passes here afterwards, by rejecting a
  staged task file the CLI can no longer read — a tripwire, one commit later,
  and only for damage that makes the file unreadable.
- The three agents need `Bash` to gather evidence, so "never mutates the
  backlog" is enforced by their prompts, not mechanically. That is the same
  gap as the entry above, seen from the other side: extending the guard to
  `Bash` would not fix it either, because a hook cannot tell a subagent's call
  from the main agent's, and the main agent's `backlog` commands are the
  plugin's whole point.
- A hook that is not ours is never overwritten by default — the install is
  skipped and the message says how to chain it by hand. `install-hooks
  --force` replaces it instead, keeping the replaced hook as
  `<name>.backlog-md.bak`. Chaining is still the better answer: the backup is
  a file nothing runs.
- `SessionEnd` does not always run: a crash never fires it. A normal quit no
  longer loses it — the hook hands its flush to a detached child and returns
  in 10ms, so Claude Code's shutdown abort has nothing left to cancel — but
  the child is a separate process, and a machine that goes down between the
  two still leaves the flush undone. Nor does a flush that runs but cannot
  finish: an unreachable CLI leaves the journal in place rather than
  discarding it, so the pending list survives for the retry below.
  Recovery is at the next session start in that repository — in a detached
  process, so orientation never waits on it — which flushes the
  journal a killed predecessor left under this session id — a `resume`, where
  the id is reused — and sweeps journals of other sessions untouched for
  thirty minutes. What a session in that window loses is its edit counters,
  not its files: the sweep writes the list onto the task before removing the
  journal. Thirty minutes is a guess at liveness; nothing in the state
  directory says whether a session is still running.
- Nothing is injected *before* a compaction, only after it. The plugin used
  to register a `PreCompact` hook for that, and Claude Code 2.1.238 rejects
  its output: `hookSpecificOutput` is defined for `PreToolUse`,
  `UserPromptSubmit`, `PostToolUse`, `PostToolBatch` and `Stop`, and a
  `PreCompact` entry is not one of them, so the hook could only fail loudly at
  every `/compact`. It is gone. What the summariser sees is therefore whatever
  brief was already in the context; the fresh one arrives with the
  `SessionStart` that follows.
- Two concurrent sessions that resolve their task by status see the same
  task.
- Path classification is lexical: the deny decision compares the edited path
  against the backlog directory as text and never calls `realpath`. A symlink
  living outside the backlog directory but pointing at a managed task file is
  therefore edited without a deny. That is a decision, not an oversight —
  resolving symlinks on the deny path would put filesystem syscalls, and their
  failure modes, inside a guard whose whole contract is to fail open, and the
  guard is a tripwire against accidental hand-edits rather than a control
  against someone who is deliberately routing around it. A test pins the
  current behaviour, so changing it has to be deliberate too.

## Development

```bash
npm test               # everything
npm run test:unit      # no external binaries needed
npm run test:contract  # protocol shape, no backlog required
npm run test:integration  # exercises the real backlog CLI when present
npm run typecheck      # tsc --noEmit over the JSDoc types
npm run lint           # biome check (formatting and lint in one pass)
npm run format         # biome check --write, applies the safe fixes
```

Comments in this repository carry the reasoning, not just the what: a comment
saying *why* a line is the way it is, and what was measured to get there,
survives where a commit message does not — maintenance here is agent-driven,
and an agent reading a file rarely reads its history. A comment therefore has
to stand on its own: one that only defers to a document is a comment to
rewrite, and earlier ones that deferred to since-deleted planning artefacts
were rewritten to state their reason instead.

The single shorthand that remains is `BCC-<n>`, a task id from the
pre-publication development backlog. Those task files are not part of the
published repository; every comment carries its reason in its own words, and
the id only names where the change came from.

Two Biome rules are off on purpose, since `biome.json` cannot carry comments:
`style/useTemplate`, because `write(render(x) + "\n")` is the house idiom and
the template-literal rewrite is churn; and the import-sorting assist, because
import order here groups local modules before `node:` builtins for a reader,
which alphabetical order destroys.

Every integration test skips itself when `backlog` is not installed —
measured: 0 of 29, including the ones that only touch git or the plugin's
own scripts. None is exempted yet.

`.github/workflows/ci.yml` runs that suite on every push and pull request:
Ubuntu on Node 18 (the engines floor) and Node 24 (the current LTS), plus one
job that installs the real `backlog` CLI so the pinned flag contracts are
exercised instead of skipped, and a `tasks` job that reads every task file in
the branch through that CLI. Linux is the point — it is the case-sensitive
filesystem a macOS workstation cannot reproduce. macOS is deliberately absent:
the runner pool has no macOS label, and a job waiting for one is a gate that
never closes. The case-insensitive branches stay covered by developer
machines, which are macOS, and the four filesystem-dependent tests skip
themselves on Linux rather than lying about it.

One rule this plan learned the hard way: **any CLI flag not measured against
the installed binary is a hypothesis.** Backlog.md's documentation on `main`
describes a newer version than may be installed, and
`test/integration/prompt-flags.test.mjs` now walks every `backlog` invocation
named in a command or agent prompt and checks it against `--help` from the
binary that's actually on `PATH`, so a drifted flag fails loudly instead of
shipping silently.
