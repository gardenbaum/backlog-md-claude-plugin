---
description: Safe Backlog.md CLI quoting
condition: "backlog task edit [A-Za-z0-9]|backlog task create|--append-"
---

Multi-line values: repeated `--append-*` flags, one invocation per line, is the recommended form. A real newline inside the quoted value works too. A literal `\n` does not — it is stored as text.
Never use ANSI-C quoting such as `$'a\nb'` — the tree-sitter-based sandbox agents run in rejects it (Backlog.md issue #595).
Single-quote any value containing backticks. Inside double quotes they are command substitution, and the original text cannot be recovered afterwards.
Use the native `backlog_task_plan`, `backlog_task_create`, and `backlog_task_finish` tools when available; they build argv directly and avoid shell quoting.
