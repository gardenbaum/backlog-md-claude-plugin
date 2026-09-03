---
id: BCC-10
title: Fix what the third clean OMP run exposed
status: Done
assignee: []
created_date: '2026-09-03 08:49'
updated_date: '2026-09-03 09:17'
labels: []
dependencies: []
modified_files:
  - lib/criteria.mjs
  - lib/quoting.mjs
  - lib/integration.mjs
  - omp/tools.mjs
  - omp/index.mjs
  - hooks/pre-tool-use.mjs
  - hooks/post-tool-use.mjs
  - rules/backlog-md-quoting.md
  - rules/backlog-md-contract.md
  - commands/start.md
  - commands/finish.md
  - commands/decompose.md
  - agents/backlog-decomposer.md
  - agents/backlog-planner.md
  - agents/backlog-verifier.md
  - skills/backlog-workflow/SKILL.md
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A full decompose-start-finish run in edgemaker (EDG-2, 2026-09-03) produced 12 failed CLI calls, a compound criterion that was reintroduced by hand after the create-time check had passed, and instrumentation that recorded none of it. Nine findings, from the acceptance-criteria surgery that has no native path down to a hook that counts failed commands as mutations.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 QUOTING_RULES names the three append flags the CLI actually has, not the glob --append-*.
- [x] #2 A quoting rule tells agents that direct backlog commands must run one at a time.
- [x] #3 Every prompt file that carries the quoting rules carries the new one verbatim.
- [x] #4 A native tool edits acceptance criteria without a shell command.
- [x] #5 The compound-criterion check also runs on a backlog task edit command that adds criteria.
- [x] #6 A full acceptance-criteria replacement restores the checkmarks of criteria whose text is unchanged.
- [x] #7 The evidence line in the implementation notes contains the text of the criterion it checks.
- [x] #8 /backlog-md:start sets the status through backlog_task_start when that tool exists.
- [x] #9 backlog_task_finish names /backlog-md:verify when this session checked the criteria itself.
- [x] #10 The Claude Code PostToolUse hook records no backlog mutation for a command that failed.
- [x] #11 The decomposer prompt requires a self-check of its own criteria before it returns them.
- [x] #12 npm test exits 0.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add lib/criteria.mjs: move compoundCriteria out of omp/tools.mjs, add the shared notice text and a parser that pulls --ac / --acceptance-criteria values out of a shell command.

Extend lib/quoting.mjs: name the three real append flags, add the one-command-at-a-time rule. Propagate both to rules/backlog-md-quoting.md, skills/backlog-workflow/SKILL.md, the three agent prompts and commands/decompose.md.

Register backlog_edit_ac in omp/tools.mjs: remove/add in one exclusive call, or a full replacement that restores the checkmarks of unchanged criteria. Flag compound additions in its result.

Warn before the run on the CLI path: advisoryForToolCall in lib/integration.mjs, emitted by hooks/pre-tool-use.mjs and the OMP tool_call handler.

backlog_check_ac writes the criterion text into the evidence line so a renumbering becomes visible.

commands/start.md prefers backlog_task_start; backlog_task_finish names /backlog-md:verify when the session checked its own criteria; hooks/post-tool-use.mjs derives isError from the tool response; the decomposer prompt gains a self-check step.

Extend the test suite for each of the above, then run npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Evidence for acceptance criterion #1: "QUOTING_RULES names the three append flags the CLI actually has, not the glob --append-*." — lib/quoting.mjs rule 1 names --append-plan, --append-notes and --append-final-summary and adds how criteria are written instead. Pinned by test/unit/quoting.test.mjs "the append rule names the flags that exist instead of globbing at them" (pass).

Evidence for acceptance criterion #2: "A quoting rule tells agents that direct backlog commands must run one at a time." — QUOTING_RULES gained a fourth rule naming the per-task lock plus the exact error string. Pinned by test/unit/quoting.test.mjs "a rule tells agents to send one backlog command at a time" (pass), which also holds QUOTING_SHORT to it.

Evidence for acceptance criterion #3: "Every prompt file that carries the quoting rules carries the new one verbatim." — the three agent prompts, the skill, the quoting rule and commands/decompose.md were rewritten from QUOTING_RULES itself. test/unit/prompts.test.mjs iterates QUOTING_RULES over the agents and the skill (pass, 32 tests).

Evidence for acceptance criterion #4: "A native tool edits acceptance criteria without a shell command." — backlog_edit_ac registered in omp/tools.mjs with concurrency exclusive. test/contract/omp-extension.test.mjs "criteria are split in a single call, and the checkmarks of untouched criteria survive" ran a remove-plus-add against a real Backlog project and read the result back (pass).

Evidence for acceptance criterion #5: "The compound-criterion check also runs on a backlog task edit command that adds criteria." — advisoryForToolCall in lib/integration.mjs, emitted by hooks/pre-tool-use.mjs and the OMP tool_call handler. test/contract/pre-tool-use.test.mjs "a compound criterion written through the shell is warned about, not blocked" reads the hook JSON (pass); the same payload was run by hand against a scratch project and printed the notice.

Evidence for acceptance criterion #6: "A full acceptance-criteria replacement restores the checkmarks of criteria whose text is unchanged." — the CLI refuses to combine --acceptance-criteria with --check-ac (verified on 1.50.1), so the tool re-checks in a second call. test/contract/omp-extension.test.mjs "a full replacement restores the checkmarks of criteria whose text is unchanged" asserts the resulting checked state and the named drop (pass).

Evidence for acceptance criterion #7: "The evidence line in the implementation notes contains the text of the criterion it checks." — backlog_check_ac quotes criterion.text before the evidence. test/contract/omp-extension.test.mjs asserts the stored note reads: Evidence for acceptance criterion #2: "The file is there" — the file is on disk (pass).

Evidence for acceptance criterion #8: "/backlog-md:start sets the status through backlog_task_start when that tool exists." — commands/start.md names the tool first and keeps the CLI line under "Only if that tool is absent". test/unit/prompts.test.mjs "start prefers the native tool and keeps the CLI as its fallback" pins the order (pass).

Evidence for acceptance criterion #9: "backlog_task_finish names /backlog-md:verify when this session checked the criteria itself." — the tool reads acceptanceChecks off the session journal it already derives for modified files. test/contract/omp-extension.test.mjs "finishing a task this session checked itself names the verifier" (pass). The contract rule now puts the verify step before backlog_task_finish, pinned by its own test.

Evidence for acceptance criterion #10: "The Claude Code PostToolUse hook records no backlog mutation for a command that failed." — failedToolResponse reads is_error, isError, success and the exit-code fields, positive evidence only. test/contract/post-tool-use.test.mjs "a backlog command that failed is not recorded as a mutation" feeds the hook a rejected and an accepted command and reads derived.stale for both (pass).

Evidence for acceptance criterion #11: "The decomposer prompt requires a self-check of its own criteria before it returns them." — step 6 in agents/backlog-decomposer.md names "and", "sowie", the semicolon and the three-comma list. test/unit/prompts.test.mjs "the decomposer re-reads its own criteria before it returns them" (pass).

Evidence for acceptance criterion #12: "npm test exits 0." — 498 tests, 498 pass, 0 fail, exit code 0. npm run typecheck exit 0 and npx biome check exit 0 alongside it.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Nine findings from the third clean OMP run (edgemaker EDG-2, 2026-09-03), all fixed and pinned by tests. The acceptance-criteria surgery that had no native path now has one: backlog_edit_ac removes and adds in a single call — Backlog.md resolves repeated --remove-ac against the list as it stands, so twelve calls that had failed on the per-task lock become one — and a full replacement re-checks the criteria whose text is unchanged, which the CLI cannot do at all. The compound-criterion check moved to lib/criteria.mjs and now also runs before a shell command that writes criteria, which is where the criterion that slipped through was written. Evidence lines carry the criterion text, so a renumbering is visible. /backlog-md:start reaches for backlog_task_start and /backlog-md:finish for backlog_task_finish, both with the CLI as fallback: the shell path recorded none of the counters and none of the modified files. backlog_task_finish says so when a session checked its own criteria, and the contract rule puts /backlog-md:verify before it. The Claude Code PostToolUse hook stops counting rejected commands as mutations. Quoting rule 1 names the three append flags that exist instead of globbing at them, and a fourth rule states the per-task lock. Verified with npm test (498 pass, 0 fail, exit 0), npm run typecheck (exit 0) and biome check (exit 0); the PreToolUse advisory was additionally run by hand against a scratch Backlog project.
<!-- SECTION:FINAL_SUMMARY:END -->
