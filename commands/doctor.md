---
description: Diagnose the backlog-md plugin — CLI reachability, project discovery, active task, cache, and hook health.
---

Run the diagnosis once:

```bash
"${BACKLOG_MD_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/scripts/backlog-cc.mjs" doctor
```

Then report it in this shape and no other: the output as-is, followed by one
line per `warn` and one line per `FAIL`, in the order they appear, each naming
the consequence and the fix. No summary, no second run, no repetition, and no
fix attempt unless the user asks for one.

A `warn` is a Backlog.md setting somebody chose, not a broken install:

- **autoCommit: true** — the `SessionEnd` flush becomes a commit nobody
  reviewed, with a `Task:` trailer.
- **bypassGitHooks: true** — Backlog.md commits with `--no-verify`; CI's
  `tasks` job is the only check left.
- **onStatusChange** — a shell command of the project's own runs on every
  status change, `/backlog-md:start`'s included.

A `FAIL` and what fixes it:

- **worker node not reachable** — detached workers, command wrappers and git
  hooks cannot run; set `BACKLOG_MD_NODE` to an absolute Node 18+ executable.
- **OMP `<operation>` failed** — no newer success for it; give its timestamp
  and retry that lifecycle action before calling it recovered.
- **backlog not reachable** — the plugin is inert; `npm i -g backlog.md`.
- **no Backlog.md project** — run `backlog init` here first.
- **no 'In Progress' column** — status resolution is off; name the task in the
  branch, or `backlog task edit <id> -s "In Progress"`.
- **active task: ambiguous** — ask which one; do not pick.
- **registered but the directory is gone** — an uninstall in the other scope
  took the shared copy; reinstall with `--force`.
- **git hooks resolve to no plugin** — they are silent no-ops; re-run
  `/backlog-md:setup` from the copy they should run.
- **no hook has recorded a run** — Claude Code only; inspect host hook
  configuration and the worker-node line, which absence alone cannot choose
  between.
- **no session state recorded** — every other host, where the in-process
  extension replaces the hooks; check that it is installed and loaded here.
