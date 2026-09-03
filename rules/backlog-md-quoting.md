---
description: Safe Backlog.md CLI quoting
condition: "backlog task edit [A-Za-z0-9]|backlog task create|--append-"
---

Multi-line values: repeated `--append-plan`, `--append-notes` or `--append-final-summary` flags, one invocation per line, is the recommended form. Those three are the only append flags there are — acceptance criteria are added with `--ac` and replaced with `--acceptance-criteria`. A real newline inside the quoted value works too. A literal `\n` does not — it is stored as text.
Never use ANSI-C quoting such as `$'a\nb'` — the tree-sitter-based sandbox agents run in rejects it (Backlog.md issue #595).
Single-quote any value containing backticks. Inside double quotes they are command substitution, and the original text cannot be recovered afterwards.
One `backlog` command at a time. Backlog.md locks a task per process, so several issued in one parallel batch fail with `is being modified by another process` — twelve did in one run, and the retries re-applied what had already landed. Wait for each to return before sending the next.
Use the native `backlog_task_plan`, `backlog_task_create`, and `backlog_task_finish` tools when available; they build argv directly and avoid shell quoting.
