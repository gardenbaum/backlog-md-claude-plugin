import { test } from "node:test";
import assert from "node:assert/strict";
import { initialisesBacklog, mutatesBacklog, writesTaskNotes } from "../../lib/bash.mjs";

test("mutatesBacklog recognises the mutating subcommands", () => {
  for (const cmd of [
    "backlog task edit BACK-1 -s 'In Progress'",
    "backlog task create 'New thing'",
    "backlog task archive 7",
    "backlog task demote 5",
    "backlog task remove 6",
    "backlog task add dep 1 2",
    "backlog task complete BACK-1",
    "backlog draft promote 3.1",
    "backlog milestone rename m-1 'Release 2'",
    "backlog doc create 'Guide'",
    "backlog decision create 'Use Postgres'",
    "npx backlog.md task edit BACK-1 -s 'In Progress'",
    "npx backlog.md task create 'New thing'",
    "bunx backlog.md task edit 2",
  ]) {
    assert.equal(mutatesBacklog(cmd), true, cmd);
  }
});

test("mutatesBacklog ignores read-only and unrelated commands", () => {
  for (const cmd of [
    "backlog task list --json",
    "backlog task BACK-1 --json",
    "backlog search 'auth' --plain",
    "backlog board export",
    "backlog config get statuses",
    "git commit -m 'wip'",
    "npm test",
    "echo backlog",
    "echo backlog.md",
    // A real, read-only subcommand (lists completed tasks) — `complete`
    // must not incidentally match as a prefix of it.
    "backlog task completed",
    "backlog task completed --json",
  ]) {
    assert.equal(mutatesBacklog(cmd), false, cmd);
  }
});

test("mutatesBacklog finds the call inside a chain", () => {
  assert.equal(mutatesBacklog("cd sub && backlog task edit 3 --check-ac 1"), true);
  assert.equal(mutatesBacklog("npm test && backlog task list"), false);
});

test("writesTaskNotes recognises both notes flags and nothing else", () => {
  assert.equal(writesTaskNotes("backlog task edit 1 --append-notes 'x'"), true);
  assert.equal(writesTaskNotes("backlog task edit 1 --notes 'x'"), true);
  assert.equal(writesTaskNotes("backlog task edit 1 --append-plan 'x'"), false);
  assert.equal(writesTaskNotes("backlog task edit 1 --check-ac 2"), false);
});

test("initialisesBacklog recognises the invocation, at the start and inside a chain", () => {
  for (const cmd of [
    "backlog init",
    "backlog init --defaults",
    "backlog.md init",
    "cd sub && backlog init",
    "git init; backlog init",
  ]) {
    assert.equal(initialisesBacklog(cmd), true, cmd);
  }
});

// The refusal costs a whole call, so a command that only mentions the words
// must not trigger it — task titles about `backlog init` are the likely case.
test("initialisesBacklog ignores commands that only name it", () => {
  for (const cmd of [
    "echo backlog init",
    "backlog task create 'backlog init overwrote the config'",
    "backlog initialise everything",
    "backlog task list",
    "git init",
  ]) {
    assert.equal(initialisesBacklog(cmd), false, cmd);
  }
});

test("all three predicates tolerate empty and non-string input", () => {
  for (const value of ["", null, undefined, 42]) {
    assert.equal(mutatesBacklog(value), false);
    assert.equal(writesTaskNotes(value), false);
    assert.equal(initialisesBacklog(value), false);
  }
});
