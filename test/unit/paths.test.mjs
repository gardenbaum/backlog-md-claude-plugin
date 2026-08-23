import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProject, readBacklogDirectory, classifyBacklogPath } from "../../lib/paths.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "bcc-paths-"));
}

test("findProject discovers a folder-local backlog/config.yml", () => {
  const root = scratch();
  mkdirSync(join(root, "backlog"));
  writeFileSync(join(root, "backlog", "config.yml"), "statuses: [To Do]\n");
  const p = findProject(root);
  assert.equal(p.root, root);
  assert.equal(p.backlogDir, join(root, "backlog"));
});

test("findProject discovers a dot-prefixed .backlog directory", () => {
  const root = scratch();
  mkdirSync(join(root, ".backlog"));
  writeFileSync(join(root, ".backlog", "config.yml"), "statuses: [To Do]\n");
  assert.equal(findProject(root).backlogDir, join(root, ".backlog"));
});

test("findProject walks up from a subdirectory", () => {
  const root = scratch();
  mkdirSync(join(root, "backlog"));
  writeFileSync(join(root, "backlog", "config.yml"), "\n");
  const deep = join(root, "src", "a", "b");
  mkdirSync(deep, { recursive: true });
  assert.equal(findProject(deep).root, root);
});

test("findProject honours backlog_directory from the root config", () => {
  const root = scratch();
  writeFileSync(join(root, "backlog.config.yml"), 'backlog_directory: "my-backlog"\n');
  mkdirSync(join(root, "my-backlog"));
  const p = findProject(root);
  assert.equal(p.backlogDir, join(root, "my-backlog"));
  assert.equal(p.configPath, join(root, "backlog.config.yml"));
});

test("findProject returns null when there is no project", () => {
  assert.equal(findProject(scratch()), null);
});

test("readBacklogDirectory accepts a plain, quoted or commented scalar", () => {
  const root = scratch();
  const write = (body) => {
    const p = join(root, "backlog.config.yml");
    writeFileSync(p, body);
    return p;
  };
  assert.equal(readBacklogDirectory(write("backlog_directory: work\n")), "work");
  assert.equal(readBacklogDirectory(write("backlog_directory: 'work'\n")), "work");
  assert.equal(readBacklogDirectory(write("backlog_directory: work  # why\n")), "work");
  assert.equal(readBacklogDirectory(write("other: 1\nbacklog_directory: nested/dir\n")), "nested/dir");
});

test("readBacklogDirectory rejects absolute paths and traversal", () => {
  const root = scratch();
  const write = (body) => {
    const p = join(root, "backlog.config.yml");
    writeFileSync(p, body);
    return p;
  };
  assert.equal(readBacklogDirectory(write("backlog_directory: /etc\n")), null);
  assert.equal(readBacklogDirectory(write("backlog_directory: C:\\\\temp\n")), null);
  assert.equal(readBacklogDirectory(write("backlog_directory: ../outside\n")), null);
  assert.equal(readBacklogDirectory(write("backlog_directory: a/../../b\n")), null);
  assert.equal(readBacklogDirectory(write("nothing: here\n")), null);
});

test("readBacklogDirectory returns null for an unreadable file", () => {
  assert.equal(readBacklogDirectory(join(scratch(), "nope.yml")), null);
});

function project() {
  const root = scratch();
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(root, "backlog", "config.yml"), "\n");
  return findProject(root);
}

test("classifyBacklogPath identifies a task file and its id", () => {
  const p = project();
  const c = classifyBacklogPath(join(p.backlogDir, "tasks", "BACK-12 - Add OAuth.md"), p);
  assert.deepEqual(c, { managed: true, kind: "task", taskId: "BACK-12" });
});

test("classifyBacklogPath recognises every managed directory", () => {
  const p = project();
  const kinds = {
    tasks: "task",
    drafts: "draft",
    completed: "completed",
    archive: "archive",
    milestones: "milestone",
    docs: "doc",
    decisions: "decision",
  };
  for (const [dir, kind] of Object.entries(kinds)) {
    const c = classifyBacklogPath(join(p.backlogDir, dir, "anything.md"), p);
    assert.equal(c.managed, true, dir);
    assert.equal(c.kind, kind, dir);
  }
});

test("classifyBacklogPath finds ids nested deeper and in subtask or padded form", () => {
  const p = project();
  assert.equal(classifyBacklogPath(join(p.backlogDir, "docs", "guides", "doc-3 - Guide.md"), p).taskId, "doc-3");
  assert.equal(classifyBacklogPath(join(p.backlogDir, "tasks", "BACK-14.1 - Sub.md"), p).taskId, "BACK-14.1");
  assert.equal(classifyBacklogPath(join(p.backlogDir, "tasks", "BACK-007 - Padded.md"), p).taskId, "BACK-007");
});

test("classifyBacklogPath treats a task file with no parsable id as managed without an id", () => {
  const p = project();
  const c = classifyBacklogPath(join(p.backlogDir, "tasks", "notes.md"), p);
  assert.equal(c.managed, true);
  assert.equal(c.taskId, null);
});

test("classifyBacklogPath identifies both config locations", () => {
  const p = project();
  assert.equal(classifyBacklogPath(join(p.backlogDir, "config.yml"), p).kind, "config");
  assert.equal(classifyBacklogPath(join(p.root, "backlog.config.yml"), p).kind, "config");
});

test("classifyBacklogPath leaves source files alone", () => {
  const p = project();
  for (const rel of ["src/index.ts", "README.md", "package.json"]) {
    assert.equal(classifyBacklogPath(join(p.root, rel), p).managed, false, rel);
  }
});

test("classifyBacklogPath fails open on an unknown subdirectory inside the backlog folder", () => {
  const p = project();
  const c = classifyBacklogPath(join(p.backlogDir, "scratch", "whatever.md"), p);
  assert.equal(c.managed, false, "a deny requires positive identification, not proximity");
});

test("classifyBacklogPath rejects paths outside the project and a missing project", () => {
  const p = project();
  assert.equal(classifyBacklogPath("/etc/passwd", p).managed, false);
  assert.equal(classifyBacklogPath(join(p.backlogDir, "..", "..", "elsewhere", "tasks", "x.md"), p).managed, false);
  assert.equal(classifyBacklogPath(join(p.backlogDir, "tasks", "x.md"), null).managed, false);
});

test("classifyBacklogPath handles a relative path against the project root", () => {
  const p = project();
  const c = classifyBacklogPath("backlog/tasks/BACK-1 - X.md", p);
  assert.equal(c.managed, true);
  assert.equal(c.taskId, "BACK-1");
});

test("case-insensitive filesystem probe returns a boolean", () => {
  const p = project();
  assert.equal(typeof p.caseInsensitive, "boolean");
});

test("classifyBacklogPath handles case differences in the managed directory on case-insensitive filesystems", (t) => {
  const p = project();
  if (!p.caseInsensitive) return t.skip("requires a case-insensitive filesystem");
  const c = classifyBacklogPath(join(p.backlogDir, "Tasks", "BACK-1 - X.md"), p);
  assert.equal(c.managed, true, "Tasks/ should match tasks/ on case-insensitive fs");
  assert.equal(c.kind, "task");
});

test("classifyBacklogPath handles case differences in the root config path on case-insensitive filesystems", (t) => {
  const p = project();
  if (!p.caseInsensitive) return t.skip("requires a case-insensitive filesystem");
  const c = classifyBacklogPath(join(p.root, "BACKLOG.CONFIG.YML"), p);
  assert.equal(c.managed, true, "BACKLOG.CONFIG.YML should match backlog.config.yml on case-insensitive fs");
  assert.equal(c.kind, "config");
});

test("classifyBacklogPath preserves taskId casing in original form", () => {
  const p = project();
  const c = classifyBacklogPath(join(p.backlogDir, "tasks", "BACK-007 - Task.md"), p);
  assert.equal(c.taskId, "BACK-007", "taskId should preserve original casing");
});

test("classifyBacklogPath handles prefix case difference with backlog_directory: Backlog", (t) => {
  const root = scratch();
  // Create a project with backlog_directory: Backlog (capital B)
  writeFileSync(join(root, "backlog.config.yml"), 'backlog_directory: "Backlog"\n');
  mkdirSync(join(root, "Backlog", "tasks"), { recursive: true });
  writeFileSync(join(root, "Backlog", "config.yml"), "\n");

  const p = findProject(root);
  // Case folding of the backlog_directory prefix only happens on a
  // case-insensitive filesystem; on Linux this pairing cannot match.
  if (!p.caseInsensitive) return t.skip("requires a case-insensitive filesystem");

  // Query with lowercase path: backlog/tasks/... (conventional lowercase)
  // This is the reachable route that the whole fix exists for
  const c = classifyBacklogPath(join(root, "backlog", "tasks", "BACK-1 - X.md"), p);
  assert.equal(c.managed, true, "lowercase backlog/ should match Backlog/ on case-insensitive fs");
  assert.equal(c.kind, "task");
  assert.equal(c.taskId, "BACK-1");
});

test("classifyBacklogPath preserves taskId casing even when prefix differs", (t) => {
  const root = scratch();
  writeFileSync(join(root, "backlog.config.yml"), 'backlog_directory: "Backlog"\n');
  mkdirSync(join(root, "Backlog", "tasks"), { recursive: true });
  writeFileSync(join(root, "Backlog", "config.yml"), "\n");

  const p = findProject(root);
  if (!p.caseInsensitive) return t.skip("requires a case-insensitive filesystem");

  // Query with a genuinely lowercase id in the filename
  const c = classifyBacklogPath(join(root, "backlog", "tasks", "back-1 - x.md"), p);
  assert.equal(c.taskId, "back-1", "taskId should remain lowercase when that is the original");
});

test("classifyBacklogPath still denies unknown subdirs and source files", () => {
  const root = scratch();
  writeFileSync(join(root, "backlog.config.yml"), 'backlog_directory: "Backlog"\n');
  mkdirSync(join(root, "Backlog", "scratch"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "Backlog", "config.yml"), "\n");

  const p = findProject(root);

  // Unknown subdirectory inside backlog should be unmanaged
  const unknown = classifyBacklogPath(join(p.backlogDir, "scratch", "file.md"), p);
  assert.equal(unknown.managed, false, "unknown subdirs remain unmanaged");

  // Source file should be unmanaged
  const source = classifyBacklogPath(join(root, "src", "index.ts"), p);
  assert.equal(source.managed, false, "source files remain unmanaged");
});

// Classification is lexical: no realpath, so a symlink outside the backlog
// directory that points at a managed task file is not recognised as managed.
// Pinned rather than fixed, and documented under Limitations — resolving
// symlinks would put syscalls inside a guard contracted to fail open (BCC-10).
test("a symlink pointing at a managed task file classifies as unmanaged", {
  skip: process.platform === "win32",
}, () => {
  const p = project();
  const target = join(p.backlogDir, "tasks", "BACK-1 - X.md");
  writeFileSync(target, "# task\n");
  const link = join(p.root, "shortcut.md");
  symlinkSync(target, link);

  const direct = classifyBacklogPath(target, p);
  assert.equal(direct.managed, true, "the real path is still managed");

  const viaLink = classifyBacklogPath(link, p);
  assert.equal(viaLink.managed, false, "lexical classification cannot see through a symlink");
});
