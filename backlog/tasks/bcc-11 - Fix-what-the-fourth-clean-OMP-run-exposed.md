---
id: BCC-11
title: Fix what the fourth clean OMP run exposed
status: Done
assignee: []
created_date: '2026-09-03 13:43'
updated_date: '2026-09-03 14:09'
labels: []
dependencies: []
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A 0.3.10 run in edgemaker (EDG-3) lost twelve of thirteen approved acceptance criteria at create time without saying so, and skipped its only independent check because the finish note reads like a script path. Both losses were silent. This task makes the write tools state what they wrote, repairs an array that the host serialised into one string, points the verify note at the slash command it means, stops a display-only basename from being recorded as a modified file, and closes the wording gaps that let a decomposition dispatch be briefed with its own job.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A tool parameter that arrives as a one-element array holding a JSON array of strings is unwrapped before use
- [x] #2 backlog_task_create names in its result how many acceptance criteria it wrote
- [x] #3 backlog_task_plan names in its result how many plan steps it appended
- [x] #4 The backlog_task_finish note calls /backlog-md:verify a slash command rather than a script path
- [x] #5 backlog_task_finish names any unchecked definition-of-done item it found
- [x] #6 backlog_task_finish states that it does not commit the files it recorded
- [x] #7 An edited path that does not exist on disk is not recorded as a modified file
- [x] #8 The compound-criteria notice reads "Criterion #1 carries" for a single position
- [x] #9 The compound-criteria notice says that a bound written as a range is one assertion
- [x] #10 commands/decompose.md says what belongs in a context field the host requires
- [x] #11 commands/verify.md says what belongs in a context field the host requires
- [x] #12 The full test suite passes
- [x] #13 npx biome check . reports no error
- [x] #14 npx tsc -p jsconfig.json reports no error
- [x] #15 The plugin version is raised in all four manifests
- [x] #16 CHANGELOG.md carries an entry for the new version
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a `stringList` helper to `omp/tools.mjs` that unwraps a one-element array whose single string parses as a JSON array of strings, and route every array parameter through it: acceptanceCriteria, dependencies, steps, add, criteria.

2. Have `backlog_task_create` and `backlog_task_plan` state in their result how many criteria or steps they wrote, so a truncated array is visible in the answer the model reads.

3. Rework the `backlog_task_finish` closing note: call `/backlog-md:verify` a slash command explicitly, list unchecked definition-of-done items off the task view it already reads, and say that the recorded files are not committed.

4. In `lib/integration.mjs`, drop an edit target that does not exist on disk before it becomes a journal `edit` event — a display-only basename resolves to a repo-root path that was recorded as a second modified file.

5. In `lib/criteria.mjs`, make the single-position wording read "Criterion #1 carries" and add one line saying a bound written as a range is one assertion, not two.

6. In `commands/decompose.md` and `commands/verify.md`, say what belongs in a context field the host demands: the idea or the task id verbatim, never orientation and never a restatement of the agent job.

7. Pin every change with a test, then run biome, the typecheck and the full suite, bump the four manifests and write the CHANGELOG entry.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented all seven plan steps. `stringList` in `omp/tools.mjs` unwraps a host-serialised array and every array parameter routes through it; `optionalStringList` keeps an explicit empty `dependencies` array legal (BCC-6).

Six existing tests named source files their fixtures never created. They now write them, which is what the new existence check asserts about a real run: PostToolUse fires after the write.

Not done, deliberately: batching `backlog_check_ac`. It would cut 70 CLI starts to 2, but the per-call answer that quotes the criterion back is what catches a wrong tick, and a batch returns all of them after every box is already ticked. Raised with the user instead.

Evidence #1: "A tool parameter that arrives as a one-element array holding a JSON array of strings is unwrapped before use" — `stringList` in omp/tools.mjs. Contract tests "a criteria array the host serialised into one string is unwrapped, and the count is reported" and "a plan that arrives as one serialised string is appended as its own steps" both read the task back and find the separate items; "a lone plan step that merely looks like a list is stored as written" pins that a step beginning with a bracket is left alone. All pass.

Evidence #2: "backlog_task_create names in its result how many acceptance criteria it wrote" — the create result now carries "Wrote N acceptance criteria to this task", asserted as /Wrote 3 acceptance criteria/ in the serialised-array contract test (pass).

Evidence #3: "backlog_task_plan names in its result how many plan steps it appended" — the plan result carries "Appended N plan steps", asserted as /Appended 2 plan steps/ and /Appended 1 plan step\b/ in the two plan contract tests (pass).

Evidence #4: "The backlog_task_finish note calls /backlog-md:verify a slash command rather than a script path" — the note reads "Type `/backlog-md:verify` as a slash command — it is not a script, and nothing under scripts/ answers to that name". Contract test "the verifier note says the slash command is not a script" asserts both halves (pass).

Evidence #5: "backlog_task_finish names any unchecked definition-of-done item it found" — read off the task view the tool already takes, so no extra CLI call. Contract test "finishing names a definition-of-done item nobody checked" creates a task with --dod, finishes it, and finds "1 definition-of-done item is still unchecked" plus the item text (pass).

Evidence #6: "backlog_task_finish states that it does not commit the files it recorded" — contract test "finishing says the files it recorded are not committed" records a real edit, finishes, and finds "Recorded as modified: src/one.mjs" and "Recorded, not committed" (pass).

Evidence #7: "An edited path that does not exist on disk is not recorded as a modified file" — lib/integration.mjs skips a target that is not on disk. Contract test "a display-only basename in an edit result is not a second modified file" sends a payload carrying both the real path and the bare filename and finds exactly one recorded path. Checked non-vacuous: with the guard line removed the same test fails 0 pass / 1 fail.

Evidence #8: "The compound-criteria notice reads Criterion #1 carries for a single position" — unit test "one flagged criterion is a criterion, not criteria" asserts /^Criterion #1 carries/ and /^Criteria #1, #3 carry/ (pass). The contract assertion for a single added criterion was updated to match.

Evidence #9: "The compound-criteria notice says that a bound written as a range is one assertion" — unit test "the notice says a bound is one assertion however many numbers it names" asserts both the sentence and the list of shapes it covers (pass).

Evidence #10 and #11: "commands/decompose.md says what belongs in a context field the host requires" and the same for verify.md — unit test "a context field the host demands takes the argument, not a briefing" asserts the sentence in each file, and that decompose.md names the required `context` field the run actually hit (pass).

Evidence #12, #13, #14: npm test reports 508 pass / 0 fail. npx biome check . reports "Checked 79 files. No fixes applied." npx tsc -p jsconfig.json exits 0 with no output. All three run after the last edit.

Evidence #15 and #16: grep over the JSON manifests shows 0.3.11 in package.json:3, package-lock.json:3 and :9, .claude-plugin/marketplace.json:12 and .claude-plugin/plugin.json:4 — the four the manifest test compares. CHANGELOG.md carries a "## 0.3.11 — 2026-09-03" section above the 0.3.10 heading.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Eight findings from the fourth clean OMP run (edgemaker EDG-3, 2026-09-03), all fixed and pinned by tests. The two that damaged the run were silent losses: thirteen approved acceptance criteria arrived as one string holding the list as JSON and the task was created with one, and the finish note read as a path, so the session ran a script that does not exist and concluded the verifier was gone.

Both are now recoverable and visible: `stringList` unwraps a host-serialised array before use, and `backlog_task_create` and `backlog_task_plan` state how much they wrote. The finish note names the slash command as one, lists unchecked definition-of-done items off the view it already takes, and says the recorded files are not committed. A recorded edit path must exist on disk, so a display-only basename stops becoming a second modified file. The compound notice reads "Criterion #1 carries" and says a bound is one assertion. Both dispatching commands say what belongs in a context field a host demands.

Verified with npm test (508 pass, 0 fail), npx biome check . (clean) and npx tsc -p jsconfig.json (exit 0). The path guard was additionally checked non-vacuous by removing it and watching its test fail. Released as 0.3.11.
<!-- SECTION:FINAL_SUMMARY:END -->
