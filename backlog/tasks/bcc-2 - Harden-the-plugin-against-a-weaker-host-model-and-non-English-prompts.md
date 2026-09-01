---
id: BCC-2
title: Harden the plugin against a weaker host model and non-English prompts
status: Done
assignee: []
created_date: '2026-09-01 07:50'
updated_date: '2026-09-01 07:58'
labels: []
dependencies: []
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An OMP session (plugin 0.3.2, MiniMax-M3) surfaced three defects, all reproducible from the transcript: (1) /backlog-md:decompose says only "Dispatch the backlog-decomposer agent" — when the host rejects the dispatch the model retried ten times and never fell back, burning minutes; (2) the model addressed backlog-cc.mjs as if it were the Backlog.md CLI ("task list", "instructions overview") and got the generic usage line back, which did not tell it to run "backlog" instead; (3) the build-intent heuristic is English-only, so a German prompt ("Bitte erstelle ...") with no active task never gets the nudge and no task is created at all.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every command that dispatches an agent says what to do when the dispatch is unavailable or fails, with an explicit retry ceiling and an inline fallback
- [x] #2 backlog-cc answers a Backlog.md CLI command (task, search, instructions, board, doc, decision, draft, milestone) with a hint naming the backlog command to run instead of the bare usage line
- [x] #3 looksLikeBuildIntent matches German build verbs, so a German request with no active task receives the intent nudge
- [x] #4 npm test and npm run lint pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. lib/observations.mjs: extend BUILD_INTENT with German verbs; German has separable prefixes and inflection, so match stems with an optional suffix rather than whole words. Extend test/unit/observations.test.mjs with the German prompts from the report.

2. scripts/backlog-cc.mjs: in the unknown-command branch, recognise the Backlog.md CLI subcommands and answer with the backlog invocation to use instead of the bare usage line.

3. commands/decompose.md, plan.md, verify.md: add a dispatch-failure fallback with a retry ceiling, so a host that cannot dispatch the agent falls back to inline research instead of looping.

4. npm test, npm run lint, npm run typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Root causes, all confirmed against the transcript and the code: (1) commands/decompose.md named the agent and nothing else, so a host that refuses the dispatch left the model with no next step; (2) scripts/backlog-cc.mjs answered a Backlog.md command with a usage line that never named the backlog CLI; (3) lib/observations.mjs BUILD_INTENT was English-only.

The German pattern uses letter lookarounds instead of \b: JS \b is ASCII-only and refuses to open a match on "ändere". Stems carry explicit inflection endings rather than \w*, so "bau" does not fire on "Baum" — pinned by a negative case in the test.

Not fixed, and not fixable here: the first call in the transcript used a stale 0.3.1 plugin-cache path and got MODULE_NOT_FOUND. That path came from the host model recalling an earlier session, not from anything this plugin emits; the command templates render the live CLAUDE_PLUGIN_ROOT.

Validation: npm test 446/446, npm run lint clean, npm run typecheck clean. The new prompts test was checked for vacuity — its regex matches decompose, plan and verify, not zero commands.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Three defects from an OMP/MiniMax-M3 session, fixed independently. commands/decompose.md, plan.md and verify.md now bound the agent dispatch to one retry and name the agent prompt file to follow inline instead, so a host that cannot dispatch produces a result rather than a loop; a new prompts test pins the ceiling and the fallback for every command that dispatches. scripts/backlog-cc.mjs recognises Backlog.md CLI commands sent to it by mistake and answers with the runnable backlog invocation, quoted, instead of a bare usage line. lib/observations.mjs adds a German build-intent pattern, so a German request with no active task gets the nudge that English requests already got. Verified with npm test (446 pass), npm run lint and npm run typecheck, plus direct runs of the CLI hint.
<!-- SECTION:FINAL_SUMMARY:END -->
