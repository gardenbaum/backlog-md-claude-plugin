---
id: BCC-7
title: Close the workflow gaps a clean OMP run exposed
status: Done
assignee: []
created_date: '2026-09-01 17:58'
updated_date: '2026-09-01 18:13'
labels: []
dependencies: []
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A 0.3.6 run in the edgemaker repository created and finished a task without ever writing a plan, started it after the work was done, spent an extra agent and eight CLI calls on research the decomposer agent does itself, and left its journal behind because the task it finished was no longer active. Each gap is small on its own; together they turn a correct run into one that records almost nothing about how the work happened.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 backlog_task_start names the missing implementation plan in its result when the task has none, and stays silent when it has one
- [x] #2 commands/decompose.md tells the session to pass the idea and repository path verbatim, without pre-research and without dictating what the agent should propose
- [x] #3 commands/decompose.md ends by naming /backlog-md:start as the way into implementation, so creating tasks is not silently followed by doing them
- [x] #4 A session whose task is Done no longer leaves its journal behind when it shuts down, while a transient resolve or write failure still keeps it
- [x] #5 A session that recorded no counters and has no pending files writes no summary file
- [x] #6 Version 0.3.7 across all four manifests, a CHANGELOG entry, and the full test suite, lint and typecheck green
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. startTask (omp/tools.mjs): keep the unplanned-start metric, and append a named line to the tool result when the task has no implementation plan — the same treatment the multiple-In-Progress branch already gives its finding.

2. commands/decompose.md: pass the idea and repository path verbatim, no pre-research, no dictated proposals; and end the command by naming /backlog-md:start as the way into implementation.

3. flushSession (lib/session-sweep.mjs): treat resolveActiveTask state "none" as terminal — the session is over and no task will appear for it — while unavailable and ambiguous stay retryable. sweepAbandoned keeps its current semantics.

4. Doctor (scripts/backlog-cc.mjs): list only sessions that recorded something, while extension.active keeps reading the newest session of any kind.

5. Tests: one per change — start without and with a plan, both decompose rules in prompts.test, a finished-task flush, and a doctor listing that skips empty sessions.

6. Release: 0.3.7 across the four manifests and the lockfile, CHANGELOG entry, full suite plus lint and typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC #1 verified by the new contract test "starting a planned task adds no warning, starting an unplanned one names the plan": the first backlog_task_start on a plan-less task returns text matching /<id> has no implementation plan/ and /backlog_task_plan before the work/, a backlog_task_plan call follows, and the second start returns text that does not match /implementation plan/i. unplannedStarts stays 1 across both. The lifecycle test additionally asserts the notice on its own unplanned start.

AC #2 and #3 verified by the new prompts test "decompose dispatches without a briefing and ends before the implementation": commands/decompose.md matches /verbatim and nothing else/, /Do not survey the backlog or the code first/ and /do not tell it what to propose/, and the text after the index of "Creating them is where this command ends" contains "/backlog-md:start".

AC #4 verified by the new integration test "a session that finished its task writes to that task and lets the journal go": an identity event plus a pending edit, the task then set Done, and the real flush command writes ["src/existing.ts","src/post.md"] onto it and leaves readJournal at length 0. The three tests that pin BCC-47 — "nothing is written when no task can be resolved", "an unresolvable task keeps the journal too", "the snapshot goes even when the journal is kept" — still pass unchanged, so a session that never had a task keeps its second chance.

AC #5 verified by the new doctor test "Doctor lists only the sessions that recorded something": three summaries written for sessions with no events plus one session with an acceptance-check event, and report.sessionMetrics comes back as ["real-session"] alone while report.extension.active stays true.

AC #6 verified by command output: grep reports "0.3.7" in package.json:3, .claude-plugin/plugin.json:4, .claude-plugin/marketplace.json:12 and package-lock.json:3,9; CHANGELOG.md carries a 0.3.7 section above 0.3.6; npm test reports 466 pass / 0 fail (462 before, +4 new tests); npx biome check . reports "Checked 77 files, no fixes applied"; npx tsc -p jsconfig.json exits silently.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Five gaps a clean 0.3.6 run exposed, all closed. backlog_task_start now names a missing implementation plan in its result instead of only counting it in unplannedStarts, using the same shape the multiple-In-Progress branch beside it already had. commands/decompose.md dispatches the decomposer with the idea and repository path verbatim — no survey first, no dictated proposals — and says where the command ends, naming /backlog-md:start as the way into the work. The end-of-session flush no longer strands the session that did everything right: native tool calls record which task they name, so lib/session-sweep.mjs can write the pending files onto that task by id once nothing is In Progress any more, and drop the journal; a session that never had a task keeps its journal, so BCC-47 is untouched and its three tests pass unchanged. The doctor lists only sessions that recorded something, because every subagent dispatch ends as an all-zero session and three of those per turn crowded a five-row report. Verified by four new tests (466 pass, 0 fail, up from 462), biome clean over 77 files, tsc silent; released as 0.3.7 across the four manifests with a CHANGELOG entry.
<!-- SECTION:FINAL_SUMMARY:END -->
