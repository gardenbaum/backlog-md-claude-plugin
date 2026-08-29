---
id: BCC-1
title: Support Claude Code and OMP from one plugin package
status: Done
assignee:
  - '@codex'
created_date: '2026-08-29 12:28'
updated_date: '2026-08-29 14:01'
labels: []
dependencies: []
type: feature
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ship the Backlog.md integration from one repository and marketplace package while preserving Claude Code behavior and adding native OMP lifecycle, command, agent, and Git-hook support.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 OMP marketplace installation loads a native extension declared by package.json without affecting Claude Code plugin loading
- [x] #2 OMP injects the active task at session start and after compaction and observes prompt changes through native extension events
- [x] #3 OMP blocks direct edits of Backlog.md-managed files with the same CLI redirect semantics, including BACKLOG_MD_GUARD=0 warning mode
- [x] #4 OMP records modified files and flushes them to the active task on session shutdown
- [x] #5 All backlog-md slash commands run under OMP without relying on an ambient CLAUDE_PLUGIN_ROOT variable
- [x] #6 The planner, verifier, and decomposer agents are discoverable with their intended tool restrictions in both harnesses
- [x] #7 Git hooks resolve both Claude Code and OMP plugin installations, including user, project, and XDG OMP roots
- [x] #8 Automated tests and README documentation cover installation and behavior in both Claude Code and OMP
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extract host-neutral lifecycle, prompt-observation, tool-guard, journaling, and shutdown operations from the Claude hook entrypoints while preserving their protocol contracts.
2. Add a manifest-declared OMP MJS extension that maps native session, prompt, tool, compaction, and shutdown events onto the shared operations.
3. Register OMP workflow commands from the existing Markdown templates with native argument expansion and plugin-root substitution.
4. Make shared agent metadata and Git-hook plugin-root discovery work for Claude Code and OMP user, project, and XDG installations.
5. Add adapter, manifest, agent, command, and root-resolution tests; document OMP installation and runtime behavior.
6. Verify focused contracts, complete project checks, an isolated marketplace installation, and a cold review before finalization.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented one package with Claude command hooks plus a native OMP extension. Shared lifecycle, prompt observation, direct-write guard, edit journal, detached flush, and command rendering live in host-neutral modules. OMP uses native session/input/tool/shutdown events, import.meta.url command roots, native resolve metadata for applied AST edits, and includes resumed-session recovery. Git-hook root discovery now covers OMP project, user, PI_CONFIG_DIR, and XDG installs. Canonical repository cache keys keep detached macOS children on the same journal.

Validation: isolated OMP marketplace add/install discovered package.json#omp.extensions; focused dual-host suite passed 81/81; unit suite passed with zero failures; contract suite passed 39/39; integration suite passed 54/54; final OMP lifecycle suite passed 5/5; npm run typecheck and npm run lint passed. Cold review replaced speculative AST-preview tracking with OMP xdev resolve metadata and fixed /var versus /private/var detached journal identity.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped v0.3.0 as one Claude Code and OMP marketplace package: shared behavior, native OMP events and commands, compatible agents, portable Git hooks, tests, and dual-host README/install guidance. Verified by isolated OMP installation, 54 integration tests, 39 contract tests, the complete unit suite, typecheck, and Biome.
<!-- SECTION:FINAL_SUMMARY:END -->
