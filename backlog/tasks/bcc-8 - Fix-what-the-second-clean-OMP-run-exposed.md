---
id: BCC-8
title: Fix what the second clean OMP run exposed
status: Done
assignee: []
created_date: '2026-09-02 05:44'
updated_date: '2026-09-02 06:05'
labels: []
dependencies: []
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A 0.3.7 run in the edgemaker repo (decompose to a finished blog post) confirmed the 0.3.7 fixes but exposed five smaller defects.

Evidence, from the run at ~/.local/state/backlog-md-cc/2f6945e28cc7fddf and the EDG-1 task file:

1. The executor miscounted twice while checking criteria, corrected itself, and both readings are now permanent in the task notes: EDG-1 records "description=304 Zeichen - verletzt Grenze 1-300" and, three paragraphs later, "245 Zeichen (OK)". backlog_check_ac always appends, so a correction never replaces what it corrects and a later reader finds two contradictory evidence blocks under the same criterion number.
2. Session 01a06096 ended at 07:35 with an empty journal and recorded unfinishedSessions 1, because EDG-1 was still In Progress at that moment - it was finished one minute later by a different session. The counter measures "some task was open when some session ended", not "this session left its task open". Same family as the doctor filter in 0.3.7.
3. The decomposer returned one acceptance criterion carrying eight separate requirements (section structure, glossary with two or more definition tags, at least one diagram, closing section, further-reading with three internal and two to three external links). One checkbox for eight assertions; partial completion cannot be expressed and the evidence becomes a paragraph. Its prompt asks for one criterion per line, which this was, and does not ask for one assertion per criterion.
4. The dispatch was rejected three times by the host with a schema message naming the missing field, and succeeded on the fourth attempt once the call shape matched. The decompose command says to retry once and no more, which was written for a host without subagents and would have sent this run inline for no reason.
5. The always-applied contract rule contains the literal example "backlog task edit <id> -s" and the quoting rule condition is "backlog task (edit|create)|--append-", so the contract matches the condition on its own. The quoting rule keeps announcing itself in runs that write no CLI command at all.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Re-checking an acceptance criterion replaces the evidence block already recorded for that index instead of appending a second one
- [x] #2 An unfinished-session metric is recorded only for a session whose own journal shows it worked on the task that is still active
- [x] #3 The decomposer prompt requires one assertion per acceptance criterion, not merely one criterion per line
- [x] #4 The decompose command tells a rejected call shape apart from a host without subagents, and only the second one ends the dispatch
- [x] #5 The quoting rule condition no longer matches the placeholder example carried by the always-applied contract rule
- [x] #6 npm test, npx biome check . and npx tsc -p jsconfig.json all pass
- [x] #7 The plugin version is 0.3.8 in package.json, package-lock.json, plugin.json and marketplace.json, with a CHANGELOG entry
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
P1 - omp/tools.mjs backlog_check_ac: build the evidence line, read the task first, and if implementationNotes already carries a paragraph starting with "Evidence for acceptance criterion #<index>: ", write the whole notes back with --notes and that paragraph replaced (dropping any duplicates of it); otherwise --append-notes as today. Collapse blank lines inside the evidence so a block is always exactly one paragraph and the match is unambiguous. Fall back to appending when the read fails - a check must never be lost to a failed lookup.

P2 - omp/index.mjs session_shutdown: record unfinished-session only when this session touched the work. Derive the session (deriveSession is already imported) and require either its own taskId to equal the active task id, case-insensitively, or a non-empty pendingModifiedFiles.

P3 - agents/backlog-decomposer.md: extend rule 4 so one criterion carries one assertion; a criterion whose evidence needs an "and" is two criteria.

P4 - commands/decompose.md: split the retry paragraph. A rejection that names what the call is missing is a call-shape problem: fix it and send it again. Only an unknown agent or a host without subagents ends the dispatch and moves the research inline.

P5 - rules/backlog-md-quoting.md: tighten the condition so a real task id is required, which stops the always-applied contract rule from matching its own placeholder example.

Tests: replace-not-append and first-check-appends in test/contract/omp-extension.test.mjs; a bystander session records no unfinished-session in the extension contract tests; the decomposer and decompose wording in test/unit/prompts.test.mjs.

Verify with npm test, npx biome check . and npx tsc -p jsconfig.json, then release 0.3.8 across the four manifests plus CHANGELOG, commit as fix + release, and push.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC #1 verified by the new contract test "re-checking a criterion replaces its evidence instead of stacking a second one": criterion 1 is checked with "counted 304 characters, over the limit", criterion 2 with "the file is on disk", then criterion 1 again with the corrected measurement. The task notes read back through the CLI match /245 characters, inside the limit/, do not match /304 characters/, contain exactly one "Evidence for acceptance criterion #1: " block, and still carry criterion 2 unchanged. omp/tools.mjs:replaceEvidence returns null when no block exists, so a first check still appends; a failed taskView also appends rather than losing the check.

AC #2 verified by the new contract test "a session that never touched the open task is not counted as unfinished": a task is put In Progress, session omp-bystander shuts down without a journal, and its frozen summary reports unfinishedSessions 0. The companion test "OMP shutdown freezes the session counters before the worker that deletes them" now appends an identity event for the active task first and still reports 1, so the metric survives for the session that did the work. omp/index.mjs:touchedTask requires the session own taskId to equal the active id, case-insensitively, or a non-empty pendingModifiedFiles.

AC #3 verified by the new unit test "the decomposer is told one assertion per criterion, not one line per criterion": agents/backlog-decomposer.md rule 4 now matches /One assertion each/i and /needs an "and" is two criteria/i.

AC #4 verified by the reworked unit test "every command that dispatches an agent bounds the retries and falls back inline": for every command that dispatches an agent - decompose, plan and verify - the text must match /names what the call is missing.*fix it and send it again/i and /the same rejection twice ends it/i, and still name the inline fallback path. The old assertion on /retry it once and no more/ is gone with the phrasing it pinned.

AC #5 verified by the extended unit test "OMP rules separate always-applied task ownership from CLI quoting guidance": the quoting condition, compiled to a RegExp, no longer matches the always-applied contract body (which carries "backlog task edit <id> -s"), and still matches both "backlog task edit BCC-1 --check-ac 1" and "backlog task create \(Title\) --ac \(One\)". The edit branch now requires an alphanumeric after the verb; the create branch stays broad because the real form is followed by a quoted title.

AC #6 verified by running all three: npm test reports tests 469, pass 469, fail 0 (462 before this task, 469 after; the suite grew by the three new tests and one lifecycle assertion). npx biome check . reports "Checked 77 files in 88ms. No fixes applied." npx tsc -p jsconfig.json exits silently - it first flagged TS2339 on derived.taskId, which was control-flow analysis reading a let assigned only inside deriveSession fold callback as still null; the returned field is now cast to string | null at the return.

AC #7 verified by grep over the manifests: package.json:3, package-lock.json:3 and :9, .claude-plugin/plugin.json:4 and .claude-plugin/marketplace.json:12 all read 0.3.8, and CHANGELOG.md carries a "## 0.3.8 — 2026-09-02" section with one bullet per finding.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Five defects that a clean 0.3.7 run in edgemaker exposed, all fixed and released as 0.3.8.

backlog_check_ac now reads the task before it writes: if a paragraph beginning "Evidence for acceptance criterion #N: " is already there, the whole notes go back through --notes with that paragraph replaced, otherwise --append-notes as before. Evidence is collapsed to a single paragraph on the way in, so the block stays findable. A failed read appends rather than dropping the check.

unfinished-session is recorded only when the shutting-down session is the one that worked on the open task, which is either its own journal identity matching the active id or files it edited that nothing has recorded yet. The existing counter test now seeds that identity; a new test proves a bystander records zero.

The decomposer is asked for one assertion per criterion. The three dispatching commands - decompose, plan, verify - now tell a rejected call shape, which is fixed and resent, from an agent that is not there, which ends the dispatch. The quoting rule condition requires a real task id after "backlog task edit", so the always-applied contract rule stops matching its own placeholder example.

Verified: npm test 469/469, npx biome check . over 77 files with no fixes, npx tsc -p jsconfig.json silent. Version 0.3.8 across the four manifests with a CHANGELOG section.
<!-- SECTION:FINAL_SUMMARY:END -->
