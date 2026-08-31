# backlog-md

A [Claude Code](https://claude.com/product/claude-code) and
[Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) plugin for the
[Backlog.md](https://github.com/MrLesk/Backlog.md) task manager. One package
keeps either host oriented on the task it is working on — at session start,
after context compaction, and at prompt/tool boundaries — and routes every
backlog mutation through the `backlog` CLI that owns the files, rather than
letting an editor tool touch them directly.

This is a community plugin, not affiliated with or endorsed by the upstream
Backlog.md project.

## Requirements

- Claude Code or OMP with plugin support.
- Node 18 or newer, reachable as `node` or through `BACKLOG_MD_NODE`.
- `backlog` on your `PATH` (`npm i -g backlog.md`).
- A repository where `backlog init` has already been run.

OMP itself may be a standalone executable, but the plugin's detached sweep and
shutdown workers still run under Node. If `node` is absent from OMP's `PATH`,
launch it with `BACKLOG_MD_NODE=/absolute/path/to/node`; the same override is
used by slash-command wrappers and the optional git hooks. `/backlog-md:doctor`
probes that exact command separately from the Node process running doctor.

Without any of these the plugin is a silent no-op. Windows is untested and
not claimed.

## Install

### Claude Code

Add this repository as a plugin marketplace, then install from it:

```
/plugin marketplace add gardenbaum/backlog-md-claude-plugin
/plugin install backlog-md@gardenbaum
```

Use the marketplace name `gardenbaum` in both hosts. Plugin identity is
`backlog-md@gardenbaum`; if Claude Code and OMP use different marketplace names,
OMP sees different plugin IDs and activates both installations instead of
replacing Claude's matching entry.

### OMP

Add the same marketplace and install the same package:

```bash
omp plugin marketplace add gardenbaum/backlog-md-claude-plugin
omp plugin install backlog-md@gardenbaum
```

The package exposes Claude Code's command-hook manifest and OMP's native
`package.json#omp.extensions` entry point side by side. Neither installation
path needs generated files or a host-specific package.

OMP's Claude-plugin compatibility provider also discovers the Markdown command
files. The native extension deliberately registers each name once, and OMP
dispatches extension commands before file commands, so there is one effective
`/backlog-md:*` implementation: the native handler that renders the installed
root and never depends on an ambient `CLAUDE_PLUGIN_ROOT`. A shadowed Markdown
copy may still appear in OMP's command-source diagnostics.

Then run `/backlog-md:setup` — it diagnoses the install and offers to install
the optional git hooks. Do this before anything else; every other command
assumes a working `backlog` and a discovered project.

## What happens without you asking

The host-specific wiring differs; the behavior does not:

| Claude Code hook | OMP native event | What it does |
|---|---|---|
| `SessionStart` | `session_start`, `session_switch`, `session_branch`, `session_tree`, `session_compact` | Injects the active task — acceptance criteria, definition of done, plan, blocking dependencies, description, references, documentation, the most recent comments, recent notes — so the session opens already oriented and gets a fresh brief after compaction or navigation. |
| `UserPromptSubmit` | `input` + `before_agent_start` | A turn-boundary observation: surfaces a task named in the prompt that isn't the active one, reports what changed on the active task since it was last checked, and nudges toward starting a task before writing code — only when the CLI positively reports an empty In Progress column, never when it could not answer. Never blocks. |
| `PostToolUse` | `tool_result` | Records edited files and backlog-mutating shell commands for the next prompt observation and session shutdown to read later. Never denies, never calls the CLI itself. |
| `SessionEnd` | `session_shutdown` | Flushes the session's modified-file list onto the active task, then discards the session cache. Both adapters hand the flush to a detached Node child so host shutdown cannot cancel it. OMP uses `BACKLOG_MD_NODE` when set. |
| `PreToolUse` | `tool_call` | Redirects direct writes to Backlog.md-managed files to the CLI. Claude covers `Write`/`Edit`/`NotebookEdit`; OMP covers `write`, `edit`, `ast_edit`, and mutating `lsp` operations, including `ast_edit`/`lsp` mounted through top-level `write xd://…` calls. The plugin's only block. |

The active task is resolved by checking the current branch name for a task id
first, then by finding exactly one task in the `In Progress` column. More
than one candidate is reported as ambiguous rather than guessed.

## What it costs

Measured, not estimated: `node scripts/measure-latency.mjs` drives each hook
the way Claude Code does — one process, JSON on stdin — against a throwaway
copy of this repository's own backlog, and reads the milliseconds each hook
records with `BACKLOG_MD_DEBUG=1`. 15 runs per row, Apple silicon, Node 24,
44 task files, machine otherwise idle.

These timings measure Claude Code's one-process-per-hook adapter. OMP loads
`omp/index.mjs` in-process, so it shares the same Backlog.md CLI costs but not
the Node startup column.

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

*Add context, do not remove capability.* Every integration above only ever
injects information or records it for later — the one exception is the single
direct-write guard (`PreToolUse` in Claude Code, `tool_call` in OMP), and even
that doesn't make anything impossible, it makes one thing correct: a
hand-edit of a managed Backlog.md file gets redirected to the CLI command that
should have made the change. This project's own manifesto names complexity
creep as a risk in itself, and a tool that blocks a person's own commit is
enforcing discipline nobody asked it to enforce. One guard, one switch — no
gates on commits, no gates on plans.

## The switch

`BACKLOG_MD_GUARD=0` turns the direct-write block into a warning: the edit
goes through, and the same redirect message is injected as context instead of
blocking it. On by default in both hosts.

In Claude Code, `BACKLOG_MD_DEBUG=1` appends one JSONL record per hook run —
hook, event, elapsed milliseconds, and the error message and stack when there
was one — to `$XDG_STATE_HOME/backlog-md-cc/debug.jsonl`
(`~/.local/state/...` by default; `doctor` prints the path). Off by default,
and with it unset nothing is read, written or created. It exists because every
Claude hook body runs inside a guard that swallows exceptions, which is right
for the session and otherwise leaves no diagnostic. Writing the log is
best-effort: an unwritable location costs the hook nothing.

OMP logs adapter exceptions through its native logger and also keeps unresolved
runtime failures in bounded per-project state under
`$XDG_STATE_HOME/backlog-md-cc/<project>/health/omp.json`. The file holds at
most 16 latest failures, one per operation; a newer successful attempt clears
its failure. `/backlog-md:doctor` reports only unresolved failures, never a
cached success.

There is no plugin configuration file. `BACKLOG_MD_GUARD` applies to both
hosts; `BACKLOG_MD_NODE` selects their worker Node; `BACKLOG_MD_DEBUG` is the
Claude hook diagnostic switch.

## The git hooks

`/backlog-md:setup` offers two, both optional and both fail-open:
`prepare-commit-msg` appends a `Task: <id>` trailer, and `pre-commit` rejects
a staged task file the CLI can no longer read.

Neither depends on where the plugin happens to live. Each one resolves it when
it runs, in this order: `git config backlog-md.pluginRoot` (recorded by the
installer, and the way to point a hook at a development checkout), the path
noted at install time, `CLAUDE_PLUGIN_ROOT`, the nearest OMP install found by
walking from the repository root through its ancestors for
`.omp/plugins/node_modules/backlog-md`, an OMP user install under
`~/.omp/plugins/node_modules/backlog-md` or
`$XDG_DATA_HOME/omp/plugins/node_modules/backlog-md`, and finally the newest
`~/.claude/plugins/cache/*/backlog-md/*` that holds the plugin. Nothing found
means the hook exits 0 and the commit proceeds — an uninstalled plugin must
not be able to block a commit. `PI_CONFIG_DIR` is honored for a relocated OMP
config root. `lib/plugin-root.mjs` is the reference implementation of that
order, each hook carries its own copy in POSIX sh so no hook depends on a
second file being present, and `/backlog-md:doctor` reports what the installed
hooks resolve to.

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
- The direct-write guard does not match shell tools, so a shell write to a task
  file is not redirected: `sed -i`, `echo >`, `tee`, an in-place editor,
  anything that reaches the file through a shell. Claude Code guards
  `Write|Edit|NotebookEdit`; OMP guards its native `write`, `edit`, `ast_edit`,
  and mutating `lsp` operations. Recognising a write in an arbitrary shell
  command means parsing shell — redirections, pipelines, `sh -c`, aliases, an
  editor nobody thought of — and a guard that gets that wrong either blocks
  legitimate work or gives false assurance. The guard is a signpost against
  reaching for the wrong tool by habit, not a control against someone routing
  around it. The pre-commit hook catches part of what passes here afterwards,
  by rejecting a staged task file the CLI can no longer read — a tripwire, one
  commit later, and only for damage that makes the file unreadable.
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
- Session shutdown does not always run: a crash never fires it. A normal quit
  no longer loses it — both host adapters hand the flush to a detached child
  and return, so host shutdown has nothing left to cancel —
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
- The behavior counters `backlog-cc doctor` reports are derived from the same
  journal the flush removes, so a session that ends cleanly is frozen into a
  small `<session>.metrics` file beside it, written at shutdown before the
  flush worker is spawned. Only the newest twenty are kept, and a session that
  is killed outright never writes one: its counters go with its journal at the
  next sweep.
- Claude Code injects nothing *before* a compaction, only after it. The plugin
  used to register a `PreCompact` hook for that, and Claude Code 2.1.238
  rejects its output: `hookSpecificOutput` has no `PreCompact` variant, so the
  hook could only fail loudly at every `/compact`. It is gone; the fresh brief
  arrives with the `SessionStart` that follows. OMP has a native
  `session_compact` event and injects the same fresh brief there.
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
```bash
npm run eval -- --model-a minimax-code/MiniMax-M2 --model-b <other-model>
```

The runner gives each invocation an isolated OMP state directory. For
`minimax-code/*`, it writes that directory's `models.yml` with
`requiresThinkingAsText: true`: OMP 18.0.11 otherwise drops MiniMax reasoning
before the tool-result request. The provider receives the preserved reasoning
as MiniMax `<thinking>` assistant history; no provider setting or credential is
changed outside that temporary directory.

That isolation cuts both ways. OMP keeps credentials in `<agent dir>/agent.db`
(table `auth_credentials`), so a run pointed at a temporary agent directory
starts with an empty credential store and cannot use an `/login` session from
`~/.omp`. Real evaluation runs therefore need the provider API key in the
environment — the runner passes the ambient environment through to OMP —
for example `MINIMAX_API_KEY=… npm run eval -- …`.

The runner also refuses to start when `OMP_PROFILE` or `PI_PROFILE` is set:
OMP ignores `PI_CODING_AGENT_DIR` under a profile and would read the profile's
`models.yml`, silently dropping the MiniMax compatibility override.

OMP discovers commands, skills, rules, agents and MCP servers from a
`--plugin-dir` root, but none of its plugin providers register the
extension-module capability, so `omp/index.mjs` is not loaded from an injected
root. The runner adds `--no-extensions -e <root>/omp/index.mjs` to measure the
work tree's extension rather than an installed copy. A run that records no
session state is reported with `ok: false` and `metrics: null` instead of zeros.


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
measured: 0 of 30, including the ones that only touch git or the plugin's
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
