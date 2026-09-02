# Changelog

Versions come from `.claude-plugin/plugin.json` and are mirrored in
`.claude-plugin/marketplace.json`, `package.json`, and `package-lock.json`.
Tests fail when the public manifests diverge.

## After updating the plugin

Run `/backlog-md:setup` again.

The git hooks resolve the plugin when they run, so they survive an update on
their own — but the first thing they consult is `git config
backlog-md.pluginRoot`, which the installer recorded and which still names
wherever the plugin lived at the time. If that path is gone the hooks fall
through to the current install and everything works; if it still exists but
holds the previous version, they run that one. `/backlog-md:doctor` reports
what the installed hooks actually resolve to, and `/backlog-md:setup` rewrites
the record.

When installing in both Claude Code and OMP, keep the marketplace name
`gardenbaum` in both registries. The plugin ID is `backlog-md@gardenbaum`;
different marketplace names create separate IDs and leave both installations
active instead of allowing OMP's replacement rule to apply.

## 0.3.9 — 2026-09-02

The run where every fix from 0.3.8 held and a checkbox still lied. The third
`/backlog-md:decompose` in the same repository planned before it worked, wrote
one evidence block per criterion, and left no counter against a bystander — and
then ticked a criterion reading "3-5 inhaltliche Hauptabschnitte" over a post
with six sections, counting the six in its own evidence.

- `backlog_check_ac` answers with the criterion it just checked and the
  `--uncheck-ac` that undoes it. "Updated task EDG-1" was the whole reply to
  all nine ticks of that run, so the claim and the criterion it was measured
  against were never in the same place — for the model or for the reader.
- `backlog_task_create` names the criteria that carry more than one assertion,
  in the reply to the call that writes them. The decomposer prompt has asked
  for one assertion each since 0.3.8; the run that had it returned six compound
  criteria out of nine, one asserting that a title image "liegt unter
  public/images/posts/" while excusing its absence in the same sentence.
- Checkpoint 1 in `/backlog-md:decompose` shows the acceptance criteria
  themselves for a proposal of three tasks or fewer, not how many there are.
  The count is what the user approved before the criterion that could not fail
  was written into the task.
- `/backlog-md:decompose` names the commands that must not run before the
  dispatch — `ls`, `find`, `grep`, `backlog task list`. "Do not survey the
  backlog or the code first" was already in the file for the run that opened
  with ten orientation commands and then briefed the agent with the schema
  fields, and got back a criterion that was a checklist of exactly those.
- `backlog_task_finish` records the files the session edited with
  `--modified-file`. The journal has held them all along and the flag has been
  in the CLI all along; a finished task named the one file it changed inside a
  prose sentence of evidence and nowhere a reader can list.
- A notes event now clears the session's pending files, which is what the
  turn_end guard's comment has claimed since the journal replaced the snapshot.
  The fold never did it, so the first task finished in a session would have
  handed its files to the second.

## 0.3.8 — 2026-09-02

The second clean run, and what it recorded wrongly. A `/backlog-md:decompose`
in the same repository went the way 0.3.7 asked — a plan before the work, the
idea dispatched verbatim, the edited file found again at the end — and still
left contradictory evidence in the task, a counter against a session that did
nothing, and one criterion no checkbox could hold.

- `backlog_check_ac` replaces the evidence already recorded for a criterion
  instead of appending a second block. A run measured twice, corrected itself,
  and left both readings in the task: "description = 304 characters, violates
  the 1–300 limit" and, three paragraphs later, "245 characters (OK)", with
  nothing to say which one counts.
- `unfinished-session` is recorded only for a session that worked on the task
  still open. A sibling session shut down one minute before the working session
  finished, and counted the whole project's state against itself:
  `unfinishedSessions: 1` beside an empty `toolCalls`.
- The decomposer is asked for one assertion per criterion, not one criterion
  per line. It returned a single criterion carrying eight requirements — a
  checkbox that cannot record that six of them hold, and evidence that runs to
  a paragraph.
- `/backlog-md:decompose`, `/backlog-md:plan` and `/backlog-md:verify` tell a
  rejected call shape apart from an agent that is not there. "Retry once and no
  more" was written for a host without subagents; one host turned the dispatch
  down three times over the shape of the arguments and accepted the fourth,
  which the old ceiling would have abandoned for nothing.
- The quoting rule no longer fires on the contract rule's own example.
  `alwaysApply` carries `backlog task edit <id> -s` into every prompt and the
  condition matched its placeholder, so the rule announced itself in runs that
  wrote no command at all.

## 0.3.7 — 2026-09-01

What a run that went right still failed to record. A `/backlog-md:decompose`
against an empty backlog created its task, wrote the work and finished it with
evidence for all six criteria — and left no plan, started the task after the
work was done, spent an extra agent on research the decomposer does itself, and
leaked its journal because the task it had finished was no longer active.

- `backlog_task_start` names a missing implementation plan in its result
  instead of only counting it. `unplannedStarts` was the single trace that a
  session started, wrote a post, checked six criteria and finished without ever
  planning — a number in a state file nobody reads.
- `/backlog-md:decompose` dispatches the decomposer with the idea and the
  repository path, verbatim and nothing else: no survey first, no telling it
  what to propose. A session that briefed the agent with its own gap map and
  its own acceptance criteria got back one no measurement could fail.
- `/backlog-md:decompose` says where it ends and names `/backlog-md:start` as
  the way into the work. Sliding from creating a task straight into doing it is
  how the task got started after the fact and never planned.
- The end-of-session flush writes the pending files onto the task the session
  worked on, by id, when nothing is In Progress any more. The session that
  finished its task was the only one whose journal never went: no later sweep
  could find that task active again. A session that never had a task still
  keeps its journal for the resume that starts one.
- Native tool calls record which task they name, so the OMP path has a session
  task id at all — it had none, which is why the flush above had no target.
- `/backlog-md:doctor` lists only the sessions that recorded something. Each
  subagent dispatch is a session that ends with every counter at zero, and
  three of them per turn is enough to push the session that did the work off a
  five-row report.

## 0.3.6 — 2026-09-01

One defect and the five that hid it. A `/backlog-md:decompose` run against an
empty backlog created no task at all: every call was refused, and every other
door the plugin offers turned out to be closed too.

- `backlog_task_create` accepts a task that waits for nothing. `dependencies`
  was optional but declared `minItems: 1`, and the host validates the schema
  before the tool runs, so an explicit empty list was refused without a word
  from the plugin. Every task in an empty backlog is a root task, so the first
  one could not be created at all — measured: five refusals, then the model
  concluded that Backlog.md forbids a task without a predecessor.
- `/backlog-md:decompose` says that a task waiting for nothing leaves
  `dependencies` out. Read as if the field were mandatory, the page turned one
  proposed task into three invented ones — a content audit, an image, the post
  — purely to give the graph an edge, before failing to create any of them.
- The contract rule names the `backlog` CLI as the fallback when a tool
  *refuses* a call, not only when one is missing. `backlog task create` with no
  `--dep` would have worked throughout; the rule read as forbidding it, and the
  session called the deadlock structural instead.
- A shell redirect into a Backlog.md file is refused like a write tool.
  `Write` and `Edit` were guarded and the shell was not, so the refusal taught
  the detour: two denied writes were answered with `cat > 'backlog/tasks/EDG-1
  - ….md'`, narrated as such. Redirects and `tee` are covered; `cp`, `mv` and
  `sed -i` name their target positionally and stay unguarded, because the deny
  path refuses only what it can identify exactly.
- Refusing a task file that does not exist yet names `backlog task create`.
  It named `backlog task edit <id>`, which answers "not found" for a task with
  no files. The reason now also gives the fact behind the vanishing act:
  Backlog.md indexes tasks by filename and reads only a lowercase id prefix, so
  the hand-written `EDG-1 - ….md` was invisible to `backlog task list` while
  `edg-1 - ….md` is listed (measured on 1.50.1) — twenty turns of the session
  went into looking for that.
- `backlog_next` tells an empty backlog apart from a blocked one. Both used to
  print the same sentence about open dependencies, so a session with nothing to
  be blocked by went hunting for the blockage. The whole backlog is counted
  only when nothing is ready, so the ordinary call still costs one list.

## 0.3.5 — 2026-09-01

Six defects from a third OMP session on the same host model. All of them cost
the session something it had already done: an audit task left open forever, a
decision record that can never be filled in, a dependency graph described in
prose and recorded nowhere.

- A hand-edit of an existing decision record passes the guard. `backlog
  decision create` writes a template and the CLI has no command that fills one
  in, so the deny was a dead end by construction — measured: a session created
  `decision-1`, was refused the write, decided out loud that the write had
  succeeded, and its audit result exists nowhere. Creating a decision file by
  hand is still refused, and now names `backlog decision create`, which is the
  one part of a decision the CLI does own: its id and filename.
- `backlog_task_start` names the tasks already In Progress. More than one makes
  `resolveActiveTask` ambiguous, and the brief, the acceptance reminder and the
  end-of-session note all go quiet together — a session started thirteen tasks
  at once and never noticed the first one still had four unchecked criteria.
  Named, not refused: parallel work is legitimate, losing the safety net
  without being told is not. The message also names `backlog task edit <id> -s
  'To Do'`, since no native tool moves a status back.
- `/backlog-md:decompose` creates through `backlog_task_create` and its
  `dependencies`, `milestone` and `parent` parameters. They have existed since
  0.3.4, but the template still taught the shell form; the quoting rule then
  redirected the model to the native tools and the graph fell out on the way.
  Thirteen tasks were created with their dependencies stated in the summary
  table and recorded on no task. The CLI form stays as the fallback for a host
  without the tools.
- The always-applied contract rule names `backlog task edit <id> -s '<status>'`
  for a status change no tool covers. The rule reads as "never the CLI", and a
  model that wanted eleven tasks back in To Do reached twice for `backlog-cc`,
  got nothing that could do it, and left them all In Progress. Still under the
  1000-byte ceiling, at 978.
- `backlog-cc` prints its correction after the usage line. A loop of eleven
  wrong invocations produced 84 lines, and the host showed the tail: the one
  line naming the command to run instead was the one scrolled away.
- The `backlog_task_finish` refusal names `--remove-ac`. Introduced in 0.3.4,
  it made a fabricated evidence line the cheapest way past — eleven criteria
  were checked with "deferred to a later task" as their proof. A criterion that
  cannot be verified here belongs removed or rewritten, and the refusal now
  says so.

## 0.3.4 — 2026-09-01

Four defects from one further OMP session on the same host model, all in the
native OMP surface.

- The acceptance steering waits for the work it is about, and no longer
  cancels a tool call to arrive. `turn_end` fires after every LLM turn, not at
  the end of the exchange with the user, so the first boundary after a task
  was started — before any work existed — carried the "unchecked acceptance
  criteria … before finishing it" message, delivered as a `steer`. OMP cancels
  in-flight tool calls to deliver one, and the model got "Skipped due to
  pending system advisory" in place of the research it was waiting for. It now
  waits until the session has edited a file outside `backlog/` and queues via
  `nextTurn`, like the guard warning. The check also runs before
  `resolveActiveTask`, so a turn that cannot steer no longer spawns the CLI.
- The five mutating Backlog tools declare `concurrency: "exclusive"`.
  Backlog.md locks a task per process; seven `backlog_check_ac` calls issued
  as one batch left five with "is being modified by another process", and the
  retry re-checked what had already succeeded, doubling its evidence notes.
  The field is not part of OMP's `ToolDefinition`, but `applyToolProxy`
  forwards every own key to the adapter the batch scheduler reads, and a host
  that drops it is back to the previous behaviour rather than broken.
  `backlog_next` stays shared.
- `backlog_task_create` takes optional `dependencies`, `milestone` and
  `parent`. Without them the native path could create the nodes of a
  decomposition and nothing else, while the always-applied contract rule
  forbids reaching for a handwritten shell command instead. One `--dep` per
  id, which records the same graph as the documented comma form and cannot be
  confused by an id containing a comma.
- `backlog_task_finish` refuses a task whose acceptance criteria are still
  open, naming their indices. Backlog.md itself sets Done regardless — a task
  went Done with both of its criteria unchecked — so this is the only place
  the contract can hold. A task the CLI cannot read is still allowed through,
  rather than putting an unreachable CLI between the model and a finished
  task.

## 0.3.3 — 2026-09-01

Three defects measured in one OMP session on a smaller host model, fixed
independently.

- Every command that dispatches an agent now bounds the retries and names an
  inline fallback. `/backlog-md:decompose` said only "dispatch the
  `backlog-decomposer` agent"; a host whose dispatch tool rejected the call
  left the model with no next step, and it repeated the same rejected call ten
  times without ever producing a decomposition. `decompose`, `plan` and
  `verify` now say: retry once, then read the agent's own prompt file under
  `${CLAUDE_PLUGIN_ROOT}/agents/` and do that work in the session, reporting
  that the agent was unavailable. `finish` inherits it through `verify`'s
  flow. Verify's approval gates are restated as applying to a table the main
  agent wrote itself.
- `backlog-cc` recognises the Backlog.md CLI's own commands. An agent that
  meets the wrapper in a command template reads it as "the way to call
  Backlog.md here" and addresses it with `task list` or `instructions
  overview`; the usage line it got back named neither the real CLI nor a
  command to run, so the guess was simply repeated. The reply now names the
  `backlog` invocation to run instead, quoted so it is runnable as printed.
- The build-intent heuristic covers German. It was English-only, so a German
  request with no active task produced silence — no nudge, and no task
  created at all. The pattern uses letter lookarounds rather than `\b`, which
  is ASCII-only and refuses to open a match on `ändere`, and explicit
  inflection endings rather than `\w*`, so the stem `bau` does not fire on
  `Baum`.

## 0.3.2 — 2026-08-31

- `backlog init` is refused when the directory already belongs to a Backlog.md
  project. It replaced `config.yml` with defaults — project name, statuses and
  task prefix included — and did so silently. Both hosts route through
  `evaluateToolGuard`; Claude Code needed `Bash` in the `PreToolUse` matcher,
  OMP already forwarded every tool. The refusal names the file and both ways
  forward: `backlog config set` for one setting, moving or deleting the file
  for a deliberate re-init. An init where no project exists passes untouched.
- The doctor's hook check is host-aware. Claude Code keeps the cache path,
  snapshot and `hookRuns` line; every other host gets one extension-liveness
  line instead — ok with the age of the newest session state, FAIL when nothing
  was ever recorded. The `cli.json` fallback session is gone, so the report can
  no longer diagnose a session nobody writes.
- The always-applied contract rule covers the three ways an OMP session left the
  workflow before it started: it names `backlog_task_create` when no task
  matches, states that the native tools supersede the Backlog.md CLI
  instructions, and places the built-in todo list inside a task rather than
  against it. Still under the 1000-byte ceiling.
- A `session_stop` handler covers what end-of-turn steering structurally cannot:
  work for which no task was ever created. A session that ends having changed
  files outside `backlog/` with no task active and no Backlog.md engagement gets
  one continuation naming those files and `backlog_task_create`, counted as a
  taskless-continue metric. Once per session, and it never blocks.
- An emptied journal can no longer overwrite counters that were already frozen.
  `writeSessionSummary` keeps an existing summary when the derived metrics are
  all zero, and still writes one when none exists.
- The two OMP picker entries are distinguishable: the native registration ends
  its description in `(native)`, the Markdown file variant does not. Both run
  the same handler; the duplication cannot be removed, because both hosts read
  the same `commands` key.
- `commands/doctor.md` shortened to 44 lines while covering two more FAIL lines.
  The README carries measured prompt-side figures for both hosts, the per-event
  process floor behind the project-scope recommendation, and prewalk model
  mixing as a limitation of counters read outside the evaluator.

## 0.3.1 — 2026-08-31

- Native OMP interface hardened: full `/backlog-md:*` command parity, a
  duplicate-install check in Doctor, always-applied and conditional rules, the
  hidden workflow skill, six native `backlog_*` tools, executable deny
  corrections, and a direct-shell quoting guard.
- Session counters survive the journal that produced them. `spawnFlush` freezes
  them into a bounded `<session>.metrics` file before the detached worker
  removes the journal, and `sweepAbandoned` does the same for a session that was
  killed before it could shut down — stamped with its last heartbeat, so its
  numbers arrive one session later instead of being lost. Doctor merges live
  journals and stored summaries; the newest twenty are kept.
- The summary write reports on its own `onSummary` channel instead of sharing
  `onError` with the flush worker, where a later spawn would clear it.
  `writeAtomic` now removes its staging file when the rename fails.
- Project-scope OMP installs are resolved and reported: the
  `<project>/.omp/plugins/node_modules/backlog-md` symlink wins over a
  user-scope install, matching OMP's own shadowing, and Doctor names the repair
  for a registry entry whose cache directory an uninstall removed.
- Added `npm run eval`: five fixed comparative scenarios, plus
  `BACKLOG_MD_TIMEOUT_SCALE` for the protocol and prompt budgets.

## 0.3.0 — 2026-08-29

- The same marketplace package now installs natively in OMP through
  `package.json#omp.extensions`, while retaining Claude Code's five command
  hooks unchanged.
- OMP lifecycle, input, prompt-start, tool-call, tool-result, compaction, and
  shutdown events now drive the same active-task brief, observations,
  direct-write guard, edit journal, and detached flush as Claude Code.
- All eight `/backlog-md:*` commands are registered by the OMP extension from
  the existing command templates. Plugin-root placeholders are rendered from
  `import.meta.url`, so OMP does not depend on `CLAUDE_PLUGIN_ROOT`.
- The three read-only agents now declare stable `name` fields accepted by both
  hosts.
- Optional git hooks now recover project-scoped, user-scoped, custom-config,
  and XDG OMP installs before falling back to Claude Code's versioned cache.
- Session journals now key repositories by canonical path, so detached
  shutdown and sweep children on macOS read the same state when Node expands
  `/var` to `/private/var`.

## 0.2.0 — 2026-08-23

First published version, so everything below is the initial content rather
than a change against a predecessor. The number
skips 0.1.x deliberately — see the removals at the end of this section, which
break development installs that ran against the earlier working copy.

- Five hooks: `SessionStart` injects the active task's brief — at startup and
  again after a compaction, a clear or a resume —
  `UserPromptSubmit` reports turn-boundary observations, `PostToolUse` records
  edits and backlog mutations, `SessionEnd` flushes the edited-file list onto
  the task, and `PreToolUse` redirects a hand-edit of a Backlog.md file to the
  CLI command that should have made the change — the plugin's only `deny`.
- Eight commands (`doctor`, `next`, `start`, `decompose`, `plan`, `verify`,
  `finish`, `setup`) and three read-only agents behind them.
- Two optional git hooks, offered by `/backlog-md:setup`: a `Task: <id>`
  commit trailer and a pre-commit check that rejects a staged task file the
  CLI can no longer read. Both fail open.
- Two switches, `BACKLOG_MD_GUARD` and `BACKLOG_MD_DEBUG`. No config file.
- Late in development the hook installer moved from building `.git/hooks` by
  hand to asking `git rev-parse --git-path hooks`, so `core.hooksPath` and
  worktrees are respected and a foreign hooks directory is never written to;
  and the build-intent nudge no longer claims that no task is active in the
  two states where it cannot know that (`unavailable`, `ambiguous`).

**Removed during development:** the `PreCompact` hook, whose output Claude
Code rejects — `hookSpecificOutput` has no `PreCompact` variant, so it could
only report a hook failure at every compaction. `SessionStart` already covers
the other side of a compaction and its injection is accepted.

Also removed: the statusline snippet, and the command that
generated it. Anyone who copied it into their Claude Code settings should
delete that line; nothing regenerates it. Both removals break earlier
development installs, which is why this section is 0.2.0 rather than 0.1.0.
Work after it continues at 0.3.0.
