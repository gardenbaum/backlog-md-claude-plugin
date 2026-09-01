---
id: BCC-3
title: Stop the acceptance steering from cancelling a tool call mid-work
status: Done
assignee:
  - '@claude'
created_date: '2026-09-01 08:32'
updated_date: '2026-09-01 08:36'
labels: []
dependencies: []
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The OMP acceptance steering hangs on `turn_end`, which fires after every LLM turn rather than at the end of the exchange with the user. Measured in an OMP 18.0.11 / MiniMax-M3 session: one turn after `Start Backlog task`, before any work existed, the plugin sent "Task EDG-1 has unchecked acceptance criteria ... before finishing it" with `deliverAs: "steer"`. OMP delivers a system-attributed steer by cancelling in-flight tool calls, so a pending Bash call came back as "Skipped due to pending system advisory" and the model broke off its research to answer the nudge. The steering is right; its trigger and its delivery are wrong.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The acceptance steering does not fire for a session that has not yet changed any file outside backlog/
- [x] #2 The steering is delivered so that it queues for the next turn instead of cancelling an in-flight tool call
- [x] #3 A session that has done work and left criteria unchecked still gets exactly one steering message per task
- [x] #4 Unit tests cover both the suppressed early case and the surviving late case
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. In omp/index.mjs `turn_end`, gate the steering on `deriveSession(...).sourceEdits > 0` — the session has actually edited a file. Place the check before `resolveActiveTask` so the CLI subprocess is not spawned on every turn either.
2. Use `sourceEdits` rather than `pendingModifiedFiles`: the latter resets once implementation notes are written, which would silence the nudge for exactly the session that got furthest.
3. Change the delivery from `deliverAs: "steer"` to `deliverAs: "nextTurn"`, matching the guard warning, so OMP queues it instead of cancelling in-flight tool calls.
4. Update the contract test: record an edit before the two `turn_end` calls, assert `nextTurn`, and add a test that a session with no edits gets no message.
5. npm test, lint, typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Gate on `deriveSession(...).sourceEdits > 0` in the `turn_end` handler, placed before `resolveActiveTask` so the CLI subprocess is skipped too on a turn that cannot steer. `sourceEdits` over `pendingModifiedFiles`: the latter resets when implementation notes are written, which would silence the nudge for the session that got furthest. Edit events already exclude the managed backlog/ paths (lib/integration.mjs:183), so the gate means "changed something outside backlog/" without a second filter.

Delivery moved from `deliverAs: "steer"` to `"nextTurn"`, matching the guard warning. OMP cancels in-flight tool calls to deliver a system-attributed steer — agent-core renders the victim as "Skipped due to pending system advisory. Do not count this skipped result as completed work" — which is what threw away a research call in the measured session.

Validation: npm test 447/447 (446 before, +1 new), npm run lint clean over 77 files, npm run typecheck clean. Both contract tests fail against the old handler: the existing one now asserts `nextTurn`, the new one asserts silence where the old code sent a message.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The OMP acceptance steering no longer fires before the work it is about, and no longer cancels a tool call to arrive. It waits until the session has edited a file outside backlog/ and queues via `nextTurn` instead of `steer`. Verified by two contract tests in test/contract/omp-extension.test.mjs, both of which fail against the previous handler; full suite 447/447 with lint and typecheck clean.
<!-- SECTION:FINAL_SUMMARY:END -->
