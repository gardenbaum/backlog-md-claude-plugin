---
id: BCC-12
title: Fix what the fifth clean OMP run exposed
status: Done
assignee: []
created_date: '2026-09-03 15:02'
updated_date: '2026-09-03 15:17'
labels: []
dependencies: []
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 0.3.11 run in edgemaker (EDG-4) confirmed every 0.3.11 fix and exposed two harder defects. The task finished naming a file it never touched: prose --append-notes cleared pendingModifiedFiles so finish wrote no --modified-file at all, and sweepAllSessions had earlier booked a dead session file onto whatever task happened to be active. The plan also carries a nested serialised array verbatim because unwrapped() only accepts a flat list. Three wording gaps round it out: a create that landed fewer criteria than sent was explained away as CLI deduplication, checkpoint 1 showed themed group counts instead of the criteria, and setup offered a hook install menu with invented --shared semantics because the command has no branch for hooks already installed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A `notes` event no longer clears `pendingModifiedFiles` in `deriveSession`.
- [x] #2 A `recorded` event clears `pendingModifiedFiles` in `deriveSession`.
- [x] #3 A `notes` event still advances `editsAtLastNotes`.
- [x] #4 `backlog_task_finish` appends a `recorded` event rather than a `notes` event when it writes modified files.
- [x] #5 A finish that follows prose `--append-notes` calls still records the files the session edited.
- [x] #6 A dead session with its own task identity has its pending files written to that task, not to whichever task is active now.
- [x] #7 A dead session with no task identity still falls back to the active task.
- [x] #8 A serialised array nested inside further arrays is unwrapped to its flat list of strings.
- [x] #9 A lone string that only looks bracketed is still passed through untouched.
- [x] #10 The count line after `backlog_task_create` says the CLI neither deduplicates nor drops criteria.
- [x] #11 The count line after `backlog_task_plan` says the same about plan steps.
- [x] #12 `commands/decompose.md` says that grouping criteria by theme is a count, not the wording checkpoint 1 asks for.
- [x] #13 `commands/setup.md` says what to do when the diagnosis already reports our hooks installed.
- [x] #14 The full test suite passes, `biome check` is clean and `tsc -p jsconfig.json` exits 0.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Split the "written down" signal in two: `notes` keeps feeding `editsAtLastNotes` for the turn-end guard; a new `recorded` event is the only thing that clears `pendingModifiedFiles`. Emit it from `backlog_task_finish` where `--modified-file` is actually written.

Route `sweepAllSessions` by each dead session own `taskId` the way `flushSession` already does, with the active task as the fallback for a session that never had one.

Flatten in `unwrapped()` so a nested serialised array reaches the CLI as its leaves, and keep the non-array string passthrough.

Say in the create and plan count lines that Backlog.md neither deduplicates nor drops, so a smaller number can only mean loss in transit.

Add the missing branches to `commands/decompose.md` (a themed group is a count) and `commands/setup.md` (hooks already installed means nothing to offer).

Cover every change with tests, run the suite, biome and tsc, then release 0.3.12.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Evidence #1: lib/cache.mjs deriveSession — the `notes` branch is now only `lastNotesIdx = i;`. Test "deriveSession: notes leave the pending files alone" (test/unit/cache.test.mjs) asserts pendingModifiedFiles is still ["a"] after two notes events. Non-vacuous: restoring the reset onto `notes` fails the contract test that depends on it (1 fail).

Evidence #2: lib/cache.mjs deriveSession — a new `recorded` branch clears pendingSeen and pendingOrder. Test "deriveSession: recorded clears the pending files, a later edit makes one pending again" passes; the previous notes-based test was rewritten onto it.

Evidence #3: same test as #1 asserts editsAtLastNotes === 1 after the notes event, so the turn-end guard still sees prose notes. "deriveSession: editsAtLastNotes counts only edits before the last notes event" is unchanged and passes.

Evidence #4: omp/tools.mjs backlog_task_finish appends { t: "recorded" } instead of { t: "notes" }. Disabling that branch makes the existing BCC-9 test "a finished task records the files the session edited and takes them with it" fail on its inheritance assertion — measured, 1 fail.

Evidence #5: new contract test "prose notes written mid-task do not cost the finish its file list" drives two real `backlog task edit --append-notes` commands through the tool_result event, asserts editsAtLastNotes >= 1 so the notes event provably fired, then finishes and reads modifiedFiles back as ["src/content/posts/one.mdoc"]. Non-vacuous: with the old notes-reset the test fails (measured, 1 fail).

Evidence #6: lib/session-sweep.mjs sweepAbandoned now groups carrying sessions by their own derived taskId. New integration test "a dead session's files go to the task it named, not to whatever is active now" asserts the named task gets the file and the In Progress bystander stays empty. Non-vacuous: forcing every session down the homeless path fails it (measured, 1 fail).

Evidence #7: new integration test "a dead session that never named a task still falls back to the active one" sweeps two journals at once — one with an identity event, one without — and asserts each file landed on its own target. The three pre-existing sweep tests use identity-less journals and still pass unchanged.

Evidence #8: omp/tools.mjs unwrapped() flattens with parsed.flat(Number.POSITIVE_INFINITY). New contract test "a serialised list nested in further arrays is flattened to its steps" sends [[[["Read it","Write it"]]]] as one step and asserts the plan holds two steps and no "[[" . Non-vacuous: reverting the flatten fails it (measured, 1 fail).

Evidence #9: the pre-existing test "a lone plan step that merely looks like a list is stored as written" sends "[WIP] rewrite the parser" and still passes — JSON.parse throws, so the string is returned as itself.

Evidence #10: new contract test "the count line rules out the deduplication a run invented to explain it" asserts the create output matches /does not merge duplicates and does not drop any/ and that --ac A --ac B --ac A really does write three criteria. Verified against the CLI by hand first.

Evidence #11: omp/tools.mjs backlog_task_plan says "Backlog.md appends every step it is given and drops none" and adds that a matching number is success, not a warning — the 0.3.11 wording was read as a loss report on a call that lost nothing, and six single-step calls followed.

Evidence #12: commands/decompose.md checkpoint 1 now says "In full means one line per criterion in the words it will be measured in. Grouping them by theme is a count with more words in it". New unit test "checkpoint 1 rules out grouping the criteria by theme" pins both sentences.

Evidence #13: commands/setup.md step 2 gained an already-installed branch before the offer. New unit test "setup has nothing to offer when the hooks are already installed" pins the branch, the stop, and that it precedes "ask whether to".

Evidence #14: npm test — 517 pass, 0 fail (508 before, nine tests added). npx biome check . — "Checked 79 files. No fixes applied." npx tsc -p jsconfig.json — exit 0.

Not done, deliberately: batching `backlog_check_ac`, raised after BCC-11 and left open again. The EDG-4 run is the argument for keeping it: the AC split shifted every index above 24, and the per-call echo is what let the run tick the shifted #24 and #25 against the right criteria. A batch returns all thirty-four echoes after all thirty-four boxes are already ticked.

Not done: the decomposer produced 33 criteria for one blog post, twelve of them frontmatter assertions that `astro check` proves in one run. Real waste — twelve exclusive tool calls for nothing — but steering the decomposer away from criteria a single check subsumes risks trading redundancy for criteria that measure nothing. Reported to the user instead of guessed at.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Two defects and four wording gaps from the 0.3.11 OMP run in edgemaker (EDG-4), all diagnosed from the session journal rather than the transcript.

The task that named the wrong file had two independent causes. `pendingModifiedFiles` was cleared by the `notes` event, which any prose `--append-notes` writes — six of them between the thirteen edits and the finish left the list empty, so `backlog_task_finish` wrote no `--modified-file` at all. The reset now hangs off a new `recorded` event, appended only where the paths actually reach the CLI flag; `notes` keeps feeding `editsAtLastNotes` for the turn-end guard. Separately, `sweepAbandoned` wrote every abandoned journal onto whichever task was In Progress when it ran, which is how an unrelated post from a dead session landed on EDG-4. It now groups by each session own derived `taskId` the way `flushSession` already did, falls back to the active task only for a journal that never named one, and no longer lets one unreadable task hold up the rest of the sweep.

`unwrapped()` flattens, so `[[[["a","b"]]]]` reaches the CLI as its leaves rather than as twelve brackets of stored text. Both count lines now say Backlog.md neither merges duplicates nor drops entries, so a smaller number can only mean loss in transit — verified against the CLI, `--ac A --ac B --ac A` writes three criteria. The plan line adds that a matching number is success, not a warning. `commands/decompose.md` defines in full as one line per criterion and rules out themed grouping by name; `commands/setup.md` gained the branch for hooks already installed, before the offer it replaces.

Verified: npm test 517 pass / 0 fail (508 before, nine tests added), `biome check` clean on 79 files, `tsc -p jsconfig.json` exit 0. Each of the four code changes was reverted in turn to confirm its test fails without it.
<!-- SECTION:FINAL_SUMMARY:END -->
