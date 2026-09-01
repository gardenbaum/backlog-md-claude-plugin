---
id: BCC-5
title: Stop the plugin surface from stranding the work it tracks
status: Done
assignee: []
created_date: '2026-09-01 10:12'
updated_date: '2026-09-01 10:20'
labels: []
dependencies: []
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A third OMP session on the same host model left an audit task open forever and a decision record permanently empty. Six defects, all in the surface the model reads: a deny with no way forward, a steering that goes silent exactly when several tasks are In Progress, a decompose template that still teaches the CLI form so the new dependency parameters are never used, no named way to move a status the tools do not cover, a correction line that a truncated tail hides, and a finish refusal that makes fabricated evidence the cheapest exit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A hand-edit of an existing decision record is allowed through; creating one by hand is still refused and names backlog decision create.
- [x] #2 backlog_task_start reports the other In Progress tasks when there is at least one, so the session sees the state that disables active-task resolution.
- [x] #3 commands/decompose.md creates tasks through backlog_task_create with dependencies, milestone and parent, and keeps the CLI form only as the fallback for hosts without the native tools.
- [x] #4 The always-applied contract rule names the CLI command for a status change no tool covers, and still measures under 1000 bytes.
- [x] #5 backlog-cc prints the runnable backlog correction after the usage line, so a tail-truncated output still shows it.
- [x] #6 The backlog_task_finish refusal tells the model to remove or correct a criterion it cannot verify rather than check it with an excuse.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. deny: allow a hand-edit of an existing decision file, refuse only its creation, and rewrite decisionReason to name 'backlog decision create'.

2. omp/tools.mjs: startTask appends the other In Progress task ids to its result.

3. commands/decompose.md: native backlog_task_create with dependencies/milestone/parent, CLI form demoted to the no-tools fallback.

4. rules/backlog-md-contract.md: name 'backlog task edit <id> -s' for uncovered status changes, stay under 1000 bytes.

5. scripts/backlog-cc.mjs: usage first, correction last.

6. omp/tools.mjs: finish refusal names removing or correcting an unverifiable criterion.

7. Tests for all six, then lint, typecheck, full suite, version bump and CHANGELOG.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC1: test/contract/pre-tool-use.test.mjs — 'a decision record that already exists may be written by hand' (empty stdout, no deny) and 'a decision file that does not exist yet is denied, and points at decision create'; both pass in the 11-test contract file. lib/integration.mjs skips the deny for an existing decision path, lib/deny.mjs now names backlog decision create.

AC2: test/contract/omp-extension.test.mjs — 'starting a task while another is In Progress names the others': first start carries no warning, second lists the first id and the -s 'To Do' way back. 27/27 in that file.

AC3: test/unit/prompts.test.mjs — 'decompose creates through the native tool, with the CLI form as its fallback' asserts backlog_task_create precedes backlog task create and that dependencies, milestone and parent are all named. 25/25.

AC4: rules/backlog-md-contract.md is 978 bytes (wc -c), under the 1000-byte ceiling the existing prompts test pins; the status line names backlog task edit <id> -s '<status>'.

AC5: test/unit/doctor.test.mjs — 'the CLI hint is the last thing an unknown command prints' spawns the script and asserts the usage line comes before the hint. 41/41.

AC6: the finish refusal names --remove-ac; asserted in the existing premature-finish contract test. Full run: npm test 454/454 (was 449), npm run lint clean over 77 files, npm run typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Six fixes to the surface an OMP session reads, all measured in one transcript. The guard lets a hand-edit of an existing decision record through, since backlog decision create writes a template no CLI command can fill in; creating one by hand is still refused and names that command. backlog_task_start reports the other In Progress tasks, because more than one makes active-task resolution ambiguous and silences the brief, the acceptance reminder and the flush together. decompose.md creates through backlog_task_create with dependencies, milestone and parent, with the CLI form demoted to the no-tools fallback. The contract rule names backlog task edit -s for a status change no tool covers and stays at 978 bytes. backlog-cc prints its correction after the usage line so a tail-truncated output keeps it. The finish refusal names --remove-ac, so a criterion that cannot be verified has an honest exit. Verified by npm test 454/454 (five new tests, up from 449), npm run lint over 77 files and npm run typecheck, all clean.
<!-- SECTION:FINAL_SUMMARY:END -->
