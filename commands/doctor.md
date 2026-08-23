---
description: Diagnose the backlog-md plugin — CLI reachability, project discovery, active task, cache, and hook health.
---

Run the diagnosis and report it to the user:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/backlog-cc.mjs" doctor
```

Present the output as-is. A line marked `warn` is a Backlog.md setting that
changes what this plugin does — somebody's decision, not a broken install, so
report it and leave it alone unless the user asks:

- **autoCommit: true** — the `SessionEnd` flush of modified files lands as a
  commit nobody reviewed, carrying a `Task:` trailer.
- **bypassGitHooks: true** — Backlog.md commits with `--no-verify`, so the
  pre-commit tripwire runs on no commit it makes; CI's `tasks` job is then the
  only check left.
- **onStatusChange** — a shell command of the project's own runs on every
  status change, including the one `/backlog-md:start` performs, so that
  command's latency and side effects are not the plugin's.

Then, for any line marked `FAIL`, explain the consequence and the fix in one
sentence each:

- **backlog not reachable** — the plugin is inert; install it with `npm i -g backlog.md`.
- **no Backlog.md project** — run `backlog init` in this repository first.
- **no 'In Progress' column** — status-based resolution is off; use a branch
  named after the task, or set it explicitly with
  `backlog task edit <id> -s "In Progress"`.
- **active task: ambiguous** — more than one task is In Progress. Ask the user
  which one; do not pick for them.
- **git hooks installed but they resolve to no plugin** — the hooks look for
  the plugin when they run and found none, so they are silent no-ops;
  reinstall the plugin, or re-run `/backlog-md:setup` from the copy you want
  them to use.
- **no hook has recorded a run** — if this persists after a fresh session, the
  hook environment cannot find `node`. Report the `node.execPath` from the
  diagnosis so the user can put that directory on their `PATH`.

Do not attempt to fix anything without being asked.
