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
