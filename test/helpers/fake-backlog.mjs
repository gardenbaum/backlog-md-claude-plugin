#!/usr/bin/env node
// Stand-in for the `backlog` binary, used only by unit tests.
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_BACKLOG_MODE || "task-view";
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

// Lets a test prove exactly which arguments the wrapper passed, instead of
// only observing that some call succeeded.
if (process.env.FAKE_BACKLOG_ARGV_FILE) {
  writeFileSync(process.env.FAKE_BACKLOG_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
}

switch (mode) {
  case "task-view":
    out({ schemaVersion: 1, kind: "task-view", task: { id: "BACK-1", title: "Fake", status: "In Progress" } });
    break;
  case "task-list":
    out({ schemaVersion: 1, kind: "task-list", tasks: [{ id: "BACK-1", title: "Fake" }] });
    break;
  case "task-list-empty":
    out({ schemaVersion: 1, kind: "task-list", tasks: [] });
    break;
  case "task-list-malformed":
    out({ schemaVersion: 1, kind: "task-list" }); // "tasks" missing under an otherwise valid envelope
    break;
  case "statuses":
    process.stdout.write("To Do, In Progress, Done\n");
    break;
  case "statuses-renamed":
    process.stdout.write("Backlog, Doing, Shipped\n");
    break;
  case "default-assignees":
    process.stdout.write("alice, bob\n");
    break;
  case "default-assignees-empty":
    process.stdout.write("\n");
    break;
  case "priorities":
    process.stdout.write("High, Medium, Low\n");
    break;
  case "priorities-empty":
    process.stdout.write("\n");
    break;
  case "default-status":
    process.stdout.write("To Do\n");
    break;
  case "default-status-not-set":
    process.stdout.write("(not set)\n");
    break;
  // Argv-aware, unlike every mode above: `findNext` calls the same binary
  // several times for different subcommands, and this is the only way to
  // make one of them fail while the others succeed — needed to tell apart
  // "the status/priority lookup failed" from "the task list itself failed"
  // (lib/next.mjs's two independent fail-closed branches).
  case "next-list-fails": {
    const argv = process.argv.slice(2);
    if (argv[0] === "task" && argv[1] === "list") {
      process.stderr.write("Task list temporarily unavailable.\n");
      process.exit(1);
    }
    if (argv[0] === "config" && argv[1] === "get" && argv[2] === "defaultStatus") {
      process.stdout.write("To Do\n");
      break;
    }
    if (argv[0] === "config" && argv[1] === "get" && argv[2] === "priorities") {
      process.stdout.write("High, Medium, Low\n");
      break;
    }
    if (argv[0] === "config" && argv[1] === "get" && argv[2] === "statuses") {
      process.stdout.write("To Do, In Progress, Done\n");
      break;
    }
    process.stderr.write(`next-list-fails: unexpected argv ${JSON.stringify(argv)}\n`);
    process.exit(2);
    break;
  }
  // defaultStatus ("Doing") deliberately differs from statuses[0]
  // ("In Progress"), which is the only shape that can tell apart the two
  // definitions of "the to-do column" (BCC-9).
  case "divergent-todo": {
    const argv = process.argv.slice(2);
    if (argv[0] === "config" && argv[1] === "get" && argv[2] === "statuses") {
      process.stdout.write("In Progress, Doing, Shipped\n");
      break;
    }
    if (argv[0] === "config" && argv[1] === "get" && argv[2] === "defaultStatus") {
      process.stdout.write("Doing\n");
      break;
    }
    if (argv[0] === "config" && argv[1] === "get" && argv[2] === "priorities") {
      process.stdout.write("High, Medium, Low\n");
      break;
    }
    if (argv[0] === "task" && argv[1] === "list") {
      const status = argv.includes("-s") ? argv[argv.indexOf("-s") + 1] : null;
      const all = [
        { id: "BACK-1", title: "In the to-do column", status: "Doing" },
        { id: "BACK-2", title: "Already shipped", status: "Shipped" },
      ];
      out({
        schemaVersion: 1,
        kind: "task-list",
        tasks: status ? all.filter((t) => t.status === status) : all,
      });
      break;
    }
    process.stderr.write(`divergent-todo: unexpected argv ${JSON.stringify(argv)}\n`);
    process.exit(2);
    break;
  }
  case "schema-drift":
    out({ schemaVersion: 2, kind: "task-view", task: { id: "BACK-1" } });
    break;
  case "garbage":
    process.stdout.write("not json at all\n");
    break;
  case "error":
    process.stderr.write("Task BACK-9 not found. Task lookups read only the local working copy.\n");
    process.exit(1);
    break;
  case "hang":
    setTimeout(() => {}, 60000);
    break;
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(2);
}
