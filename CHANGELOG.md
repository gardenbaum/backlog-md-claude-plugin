# Changelog

Versions come from `.claude-plugin/plugin.json` and are mirrored in
`.claude-plugin/marketplace.json` and `package.json`; a test fails when the
three diverge.

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
Work after it continues at 0.2.1.
