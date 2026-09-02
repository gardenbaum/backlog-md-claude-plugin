---
id: BCC-9
title: Make a checked criterion mean something again
status: Done
assignee: []
created_date: '2026-09-02 06:28'
updated_date: '2026-09-02 06:43'
labels: []
dependencies: []
modified_files:
  - omp/tools.mjs
  - lib/cache.mjs
  - commands/decompose.md
  - test/contract/omp-extension.test.mjs
  - test/unit/cache.test.mjs
  - test/unit/prompts.test.mjs
  - CHANGELOG.md
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A 0.3.8 run in edgemaker ticked a criterion reading "3-5 inhaltliche Hauptabschnitte" over a post with six, and named the six in its own evidence. Two places let that through: checkpoint 1 shows the user an acceptance-criteria count instead of the criteria, and backlog_check_ac answers "Updated task EDG-1" so the criterion text is never beside the claim. The same run returned four compound criteria despite the decomposer prompt saying one assertion each, surveyed the repo with ten commands before a dispatch that forbids it, and finished a task without recording the file it had edited.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 backlog_check_ac includes the checked criterion own text in its successful result.
- [x] #2 backlog_check_ac result names --uncheck-ac as the correction for evidence that does not meet the criterion.
- [x] #3 commands/decompose.md requires the acceptance criteria to be shown in full at checkpoint 1 for a proposal of three tasks or fewer.
- [x] #4 commands/decompose.md names the specific orientation commands that must not run before the dispatch.
- [x] #5 backlog_task_create names the indices of criteria that carry more than one assertion.
- [x] #6 backlog_task_create stays silent for criteria that carry exactly one assertion.
- [x] #7 backlog_task_finish passes --modified-file for every source file the session edited.
- [x] #8 backlog_task_finish records a notes event so the next task finished in the same session does not inherit these files.
- [x] #9 npm test reports zero failing tests.
- [x] #10 Every version manifest in the repo reports 0.3.9.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. backlog_check_ac: reuse the taskView it already makes, and answer with the criterion it just checked plus the --uncheck-ac correction.

2. backlog_task_create: name the indices of criteria carrying more than one assertion, parentheticals stripped before the test.

3. backlog_task_finish: pass --modified-file for the session pending files and append a notes event so the next task does not inherit them.

4. commands/decompose.md: show the criteria in full at checkpoint 1 for small proposals, and name ls/grep/find/backlog task list as forbidden before the dispatch.

5. Tests for each: the check_ac echo, the create warning and its silence, the finish modified-file argv, and the two decompose.md prompt assertions.

6. npm test, biome, tsc; then bump the four manifests to 0.3.9 and write the CHANGELOG section.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Evidence for acceptance criterion #1: test/contract/omp-extension.test.mjs "a checked criterion comes back with its own text and the way to undo it" asserts the result matches /The post has 3-5 main sections/, the criterion the tool was asked to check. omp/tools.mjs reuses the taskView already made for the evidence, so no extra CLI call was added. 474/474 pass.

Evidence for acceptance criterion #2: The same test asserts /--uncheck-ac 1/ in the result text; the message names the full command backlog task edit <id> --uncheck-ac <n> (omp/tools.mjs, backlog_check_ac).

Evidence for acceptance criterion #3: test/unit/prompts.test.mjs "checkpoint 1 shows the criteria themselves, not how many there are" reads commands/decompose.md, locates "this is checkpoint 1" and asserts the 700 characters after it match /criteria out in full/ and /three tasks or fewer/. The words "the acceptance criteria count" are gone from that sentence.

Evidence for acceptance criterion #4: test/unit/prompts.test.mjs "decompose dispatches without a briefing and ends before the implementation" now asserts the flattened text contains each of "no `ls`", "no `find`", "no `grep`", "no `backlog task list`" plus /this command.s first tool call/ and /nothing appended to the idea/.

Evidence for acceptance criterion #5: test/contract/omp-extension.test.mjs "criteria carrying more than one assertion are named at creation, single ones are not" creates three criteria and asserts the result matches /Criteria (#N, #N) carry/ with the captured group exactly "#1, #3" — the "and" criterion and the seven-comma one, not the parenthesised clarification.

Evidence for acceptance criterion #6: The same test creates two single-assertion criteria and asserts doesNotMatch(/more than one assertion/). Measured against the nine edgemaker criteria the heuristic flags six and stays silent on the three that carry one assertion each.

Evidence for acceptance criterion #7: test/contract/omp-extension.test.mjs "a finished task records the files the session edited and takes them with it" seeds two edit events, finishes through the tool and asserts task.modifiedFiles deepEquals ["src/content/posts/one.mdoc", "src/lib/two.mjs"] read back from backlog task <id> --json.

Evidence for acceptance criterion #8: The same test asserts deriveSession(root, session).pendingModifiedFiles is [] after the finish. test/unit/cache.test.mjs "deriveSession: notes clear the pending files, a later edit makes one pending again" covers the fold change on its own: [] after a notes event, ["a"] after a further edit.

Evidence for acceptance criterion #9: npm test: tests 474, pass 474, fail 0 (250.8s), run after the manifest bump. npx biome check . — Checked 77 files, no fixes applied. npx tsc -p jsconfig.json — silent, exit 0.

Evidence for acceptance criterion #10: grep -rn "0.3.9" over package.json, package-lock.json, .claude-plugin/plugin.json and .claude-plugin/marketplace.json returns 5 lines (package-lock carries it twice); the manifest-agreement test in the suite passes.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A checked box now carries its criterion. backlog_check_ac answers with the criterion it ticked and the --uncheck-ac that undoes it, reusing the task view it already reads for the evidence. backlog_task_create names the criteria that carry more than one assertion in the reply to the call that writes them — the decomposer prompt has asked for one assertion each since 0.3.8 and a 0.3.8 run still returned six compound criteria out of nine. Checkpoint 1 in decompose.md shows the criteria instead of counting them, and the dispatch rule names ls, find, grep and backlog task list rather than forbidding "surveying". backlog_task_finish records what the session edited through --modified-file, and a notes event now clears the pending files as the turn_end guard has claimed it does since the journal replaced the snapshot, so the next task finished in the same session does not inherit them. Verified with 474/474 tests (5 new), biome clean over 77 files, tsc silent. Released as 0.3.9.
<!-- SECTION:FINAL_SUMMARY:END -->
