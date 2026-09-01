---
id: BCC-4
title: Close three gaps in the native OMP Backlog tools
status: Done
assignee:
  - '@claude'
created_date: '2026-09-01 09:24'
updated_date: '2026-09-01 09:31'
labels: []
dependencies: []
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Measured in the same OMP 18.0.11 / MiniMax-M3 session as BCC-3, in the part of the transcript that was cut off the first time. Three independent gaps in omp/tools.mjs: (1) seven `backlog_check_ac` calls issued as one batch collided on the Backlog.md per-task lock — five came back "Edit failed: EDG-1 is being modified by another process", the model retried all seven, and the two that had already succeeded got duplicate evidence notes. Reproduced outside the plugin with four parallel `--check-ac` invocations. (2) `backlog_task_create` accepts only title, description and acceptance criteria, so the dependency graph `/backlog-md:decompose` is built to produce cannot be created through the native path at all, while the always-applied contract rule forbids reaching for a handwritten shell command instead. (3) `backlog_task_finish` marks a task Done without looking at its acceptance criteria, and the Backlog.md CLI permits that too — verified in a scratch project: status Done with both criteria still unchecked.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The five mutating Backlog tools declare exclusive concurrency so OMP serialises them; backlog_next stays shared
- [x] #2 backlog_task_create accepts optional dependencies, milestone and parent and passes them to the CLI
- [x] #3 backlog_task_finish refuses a task that still has unchecked acceptance criteria and names their indices
- [x] #4 Contract tests cover all three, and the full suite, lint and typecheck pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. `taskTool()` in omp/tools.mjs gains `concurrency: name === "backlog_next" ? "shared" : "exclusive"`, next to `approval`. The field is not in OMP `ToolDefinition`, but `applyToolProxy` copies every own key onto the adapter and the agent-core batch scheduler reads `tool?.concurrency`, where exclusive is a full barrier.
2. `backlog_task_create` schema gains optional `dependencies` (array of task ids), `milestone` and `parent`; emit one `--dep` per id (verified equivalent to the comma form), `-m`, `-p`. All three stay optional so the common call is unchanged.
3. `backlog_task_finish` reads the task with `taskView` first and refuses with the open indices when any criterion is unchecked. Refusal, not a warning: a criterion that cannot be met belongs corrected or removed, not carried silently into Done.
4. Contract tests for all three, plus npm test / lint / typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
All three in omp/tools.mjs.

1. `taskTool()` sets `concurrency: name === "backlog_next" ? "shared" : "exclusive"` beside `approval`. OMP does not declare the field on `ToolDefinition`, but `applyToolProxy` (extensibility/tool-proxy.ts) walks `Reflect.ownKeys` of the definition and defines a forwarding getter for each on the adapter, and the agent-core batch scheduler reads `tool?.concurrency` — exclusive waits for every call queued before it and becomes the barrier for those after, so it also serialises against a parallel Bash `backlog task edit`.

2. `backlog_task_create` takes optional `dependencies`, `milestone`, `parent`. One `--dep` per id: verified equivalent to the documented comma form (both record `Dependencies: TASK-1, TASK-2`), and it cannot be confused by an id containing a comma.

3. `backlog_task_finish` reads the task with `taskView` and refuses while any criterion is unchecked, naming the open indices. A task the CLI cannot read is still allowed through — refusing on a failed read would put an unreachable CLI between the model and a finished task.

Validation: npm test 449/449 (447 before), lint clean over 77 files after `npm run format` reflowed two call chains in the test file, typecheck clean. Each new assertion fails against the previous code: concurrency was undefined, dependencies were dropped, and the finish went through.

Noted, not fixed: the Backlog.md id counter was reset at some point, so BCC-2, BCC-3 and BCC-4 now each name two different pieces of work — the historical comments in scripts/backlog-cc.mjs, test/unit/doctor.test.mjs and test/unit/prompts.test.mjs cite the old ones. Raised with the user rather than rewritten.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The native OMP tools no longer collide on the Backlog.md task lock, can express a dependency graph, and refuse to mark a task Done while its acceptance criteria are open. Three contract tests in test/contract/omp-extension.test.mjs, each failing against the previous code; suite 449/449 with lint and typecheck clean.
<!-- SECTION:FINAL_SUMMARY:END -->
