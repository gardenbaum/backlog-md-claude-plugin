---
id: BCC-6
title: Stop the native create path from deadlocking an empty backlog
status: Done
assignee:
  - '@claude'
created_date: '2026-09-01 13:38'
updated_date: '2026-09-01 13:54'
labels: []
dependencies: []
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A decompose run against an empty backlog produced no task at all: backlog_task_create rejected every call because the optional dependencies array is declared minItems: 1, so an explicit empty list fails OMP schema validation before execute() runs and before any plugin message can name a way out. The surrounding surface then closed every other door — decompose.md reads as if dependencies were mandatory, the contract rule allows the CLI only when the tools are absent rather than when one refuses the input, the bash branch of the guard let a hand-written task file through, and the empty-backlog message from backlog_next talks about blocked dependencies instead of creating a task. Measured on plugin 0.3.5 with OMP v18.0.11 and Backlog.md 1.50.1.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 backlog_task_create accepts an explicit empty dependencies array and creates the task
- [x] #2 decompose.md states that a task with no predecessor omits dependencies
- [x] #3 The contract rule names the CLI as the fallback when a Backlog tool refuses a call, and stays under its byte ceiling
- [x] #4 A shell command that writes into a managed backlog path is refused with the same reason the write tools give
- [x] #5 The deny reason for a task file that does not exist yet states that a hand-written file is invisible to the CLI
- [x] #6 backlog_next names task creation when the backlog holds no tasks at all
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Drop minItems from the dependencies schema in omp/tools.mjs and say in its description that a task with no predecessor omits it; add a contract test that creates with an explicit empty array.

2. Name the no-predecessor case in commands/decompose.md and hold it with a prompts test.

3. Rewrite the contract rule's fallback line to cover a tool that refuses a call, keeping the file under its byte ceiling.

4. Extract redirect and tee targets in lib/bash.mjs, route the bash branch of evaluateToolGuard through the same classify/deny chain as the write tools, and cover it in the pre-tool-use contract suite.

5. Split lib/deny.mjs taskReason on whether the file exists: a new one names backlog task create and the lowercase-filename requirement measured on 1.50.1.

6. Count the whole backlog in findNext when nothing is ready, and let renderNext name task creation for an empty one.

7. Run the full suite, lint and typecheck; bump the four manifests and CHANGELOG to 0.3.6; commit the fix and the release separately.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Evidence for acceptance criterion #1: the create tool declares no minItems on dependencies, and a call with an explicit empty array creates the task — test/contract/omp-extension.test.mjs "the create tool requires a criterion but never a dependency" and the "Waits for nothing" create in "a created task can name its dependencies, milestone and parent", both against a real backlog fixture, 28/28.

Evidence for acceptance criterion #2: commands/decompose.md now states that a task waiting for nothing leaves dependencies out, and that --dep is left off in the CLI form; pinned by test/unit/prompts.test.mjs "decompose creates through the native tool, with the CLI form as its fallback", 26/26.

Evidence for acceptance criterion #3: rules/backlog-md-contract.md says "If a tool is missing, or refuses the call, keep the same order through the `backlog` CLI"; asserted in the OMP-rules test and measured at 972 bytes against the < 1000 ceiling in test/unit/prompts.test.mjs.

Evidence for acceptance criterion #4: the bash branch of evaluateToolGuard routes shellWriteTargets through the same classify/deny chain as Write and Edit — test/contract/pre-tool-use.test.mjs "a shell redirect into a task file is denied like the write tools" (deny, names BACK-12 and --append-notes) and "a shell command that only reads a task file is not the guard's business" (no decision at all), 14/14 through the real hook process.

Evidence for acceptance criterion #5: denyReason splits on classification.exists — test/unit/deny.test.mjs "a task file that does not exist yet points at task create, not task edit" asserts the create command, the absence of any task edit, the lowercase-filename fact, and that every command line parses as shell. The fact itself was measured on Backlog.md 1.50.1: two identical task files, EDG-1 - x.md absent from `backlog task list` and edg-2 - x.md listed; renaming the first to lowercase made it appear.

Evidence for acceptance criterion #6: findNext counts the whole backlog only when nothing is ready and renderNext branches on it — test/unit/next.test.mjs "findNext counts the whole backlog when nothing is ready" (total 0 through the fake CLI) and "an empty backlog is told to create the first task; a blocked one is not" (create named at total 0, absent at total 4).

Full verification: npm test 462/462 (454 before, eight new), npm run lint clean over 77 files, npm run typecheck clean, manifest and readme suites 16/16 after the 0.3.6 bump.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Removed the minItems constraint that made every task in an empty backlog impossible to create, and closed the five paths that kept the session from routing around it: decompose.md now names the no-predecessor case, the contract rule names the CLI as the fallback for a refused tool call, a shell redirect into a Backlog.md file is refused like a write tool, the refusal for a task file that does not exist yet names `backlog task create` and the lowercase-filename rule that made the hand-written file invisible, and `backlog_next` tells an empty backlog apart from a blocked one. Verified by 462 tests (eight new, covering the schema, both guard surfaces, both refusal texts and both empty-backlog messages), Biome over 77 files and tsc; the filename behaviour was measured directly on Backlog.md 1.50.1.
<!-- SECTION:FINAL_SUMMARY:END -->
