---
description: First-run setup for the backlog-md plugin — diagnosis and the optional git hooks.
---

```bash
"${BACKLOG_MD_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/scripts/backlog-cc.mjs" setup
```

Present the output in two parts, and **write nothing without asking first**:

1. **Diagnosis.** Any line marked `FAIL` comes first, with its consequence in
   one sentence. If `backlog` is not reachable the plugin is inert and nothing
   else here matters — say that and stop.

2. **The git hooks.** Explain what each does in one line — `prepare-commit-msg`
   appends a `Task: <id>` trailer and never fails a commit; `pre-commit`
   rejects a staged task file the CLI can no longer read. Then ask whether to
   install. Only if they agree, run the command shown. `--shared` changes
   behaviour for everyone who clones the repository, so name that difference
   before offering it. If the install is skipped because `core.hooksPath`
   points at another tool's directory, that is the correct outcome, not a
   problem to work around: report it, say whose hooks live there, and offer
   chaining. Do not run `--force` to get past it without asking — in that
   repository it writes into a directory somebody else's tool owns. If the install reports a hook already installed that
   is not ours, it was never overwritten — chain it by hand from the message
   it prints, or offer `install-hooks --force`, which replaces it and keeps
   the replaced hook next to it as `<name>.backlog-md.bak`. Say that chaining
   keeps their hook running and `--force` does not.

Two things worth saying out loud once, here:

- `git commit --no-verify` bypasses the pre-commit check. It is a tripwire
  against mistakes, not a control.
- The hooks find the plugin when they run, so a plugin update does not retire
  them, and `--shared` writes no machine-specific path into the committed
  hook. If the plugin is gone entirely they do nothing rather than fail a
  commit; `/backlog-md:doctor` is where that shows up.
