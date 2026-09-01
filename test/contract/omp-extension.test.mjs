import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import backlogMdExtension from "../../omp/index.mjs";
import { COMMAND_NAMES } from "../../lib/commands.mjs";
import {
  appendEvent,
  clearJournal,
  deriveSession,
  listSessionSummaries,
  readRuntimeFailures,
  summaryPath,
} from "../../lib/cache.mjs";
import { collectDoctor, formatDoctor } from "../../scripts/backlog-cc.mjs";
import { backlogAvailable, makeProject } from "../helpers/fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The newest message the extension sent, or a named failure.
 *
 * An empty queue means the adapter produced nothing — under a shrunk
 * `BACKLOG_MD_TIMEOUT_SCALE` or heavy parallel load that is the prompt budget
 * expiring, and `.at(-1).message` would report it as a property access on
 * undefined instead.
 */
function lastMessage(pi, event) {
  const sent = pi.messages.at(-1);
  if (!sent) {
    throw new Error(
      `${event}: the extension sent no message — its Backlog.md lookup exceeded the prompt budget. Raise BACKLOG_MD_TIMEOUT_SCALE when running under load.`,
    );
  }
  return sent;
}

function mockExtensionApi() {
  const events = new Map();
  const commands = new Map();
  const messages = [];
  const commandRegistrations = [];
  const userMessages = [];
  const warnings = [];
  const tools = new Map();
  const activeToolSets = [];
  let activeTools = [];
  const api = {
    events,
    commands,
    commandRegistrations,
    messages,
    userMessages,
    warnings,
    tools,
    activeToolSets,
    logger: { warn: (...args) => warnings.push(args) },
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, options) => {
      commandRegistrations.push(name);
      commands.set(name, options);
    },
    registerTool: (definition) => tools.set(definition.name, definition),
    getActiveTools: () => activeTools,
    setActiveTools: async (names) => {
      activeTools = names;
      activeToolSets.push(names);
    },
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: (message, options) => userMessages.push({ message, options }),
    setLabel: (label) => {
      api.label = label;
    },
  };
  return api;
}

function context(cwd, id = "omp-session") {
  return {
    cwd,
    sessionManager: { getSessionId: () => id },
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for detached OMP lifecycle child");
}

test("the package adapter registers native OMP lifecycle, prompt, tool, and command contracts", () => {
  const pi = mockExtensionApi();
  backlogMdExtension(pi);

  assert.equal(pi.label, "Backlog.md");
  assert.deepEqual([...pi.events.keys()].sort(), [
    "before_agent_start",
    "input",
    "session_branch",
    "session_compact",
    "session_shutdown",
    "session_start",
    "session_stop",
    "session_switch",
    "session_tree",
    "tool_call",
    "tool_result",
    "turn_end",
  ]);
  assert.deepEqual([...pi.commands.keys()].sort(), [
    "backlog-md:decompose",
    "backlog-md:doctor",
    "backlog-md:finish",
    "backlog-md:next",
    "backlog-md:plan",
    "backlog-md:setup",
    "backlog-md:start",
    "backlog-md:verify",
  ]);
  assert.equal(pi.commandRegistrations.length, pi.commands.size, "each OMP command is registered exactly once");
});

test("native Backlog tools are essential, inactive by default, and require acceptance evidence", () => {
  const pi = mockExtensionApi();
  backlogMdExtension(pi);

  const names = [
    "backlog_check_ac",
    "backlog_next",
    "backlog_task_create",
    "backlog_task_finish",
    "backlog_task_plan",
    "backlog_task_start",
  ];
  assert.deepEqual([...pi.tools.keys()].sort(), names);
  assert.deepEqual(pi.getActiveTools(), []);
  for (const name of names) {
    const tool = pi.tools.get(name);
    assert.equal(tool.loadMode, "essential");
    assert.equal(tool.defaultInactive, true);
    // Backlog.md locks a task per process, so a batch of them must not run at
    // once (BCC-4). Reading alongside a write is fine.
    assert.equal(tool.concurrency, name === "backlog_next" ? "shared" : "exclusive", name);
  }
  const check = pi.tools.get("backlog_check_ac");
  assert.equal(check.approval, "write");
  assert.deepEqual(check.parameters.required, ["taskId", "index", "evidence"]);
});

test("native Backlog tools activate only after an OMP session starts in a Backlog project", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);

  await pi.events.get("session_start")({}, context(project.root, "omp-native-tools"));

  assert.deepEqual(pi.activeToolSets, [[...pi.tools.keys()]]);
});

test("an unchecked active task gets one end-of-turn steering message", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const id = await project.createTask("Steer me", ["--ac", "Criterion remains open"]);
  await project.cli(["task", "edit", id, "-s", "In Progress"]);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const turn = { toolResults: [] };
  const ctx = context(project.root, "omp-steering");
  appendEvent(project.root, "omp-steering", { t: "edit", p: "src/post.md" });

  await pi.events.get("turn_end")(turn, ctx);
  await pi.events.get("turn_end")(turn, ctx);

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message.content, new RegExp(id));
  // `steer` here cancels whatever tool call is in flight (BCC-3).
  assert.deepEqual(pi.messages[0].options, { deliverAs: "nextTurn" });
  assert.equal(deriveSession(project.root, "omp-steering").metrics.steeringMessages, 1);
});

// The turn boundary right after a task is started is a turn boundary like any
// other, and it arrives before the work does (BCC-3).
test("a task that has been started but not worked on yet is not steered", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const id = await project.createTask("Just started", ["--ac", "Criterion remains open"]);
  await project.cli(["task", "edit", id, "-s", "In Progress"]);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);

  await pi.events.get("turn_end")({ toolResults: [] }, context(project.root, "omp-unworked"));

  assert.deepEqual(pi.messages, []);
  assert.equal(deriveSession(project.root, "omp-unworked").metrics.steeringMessages, 0);
});

// The case the end-of-turn steering above cannot reach: no task was ever
// created, so there is nothing to steer about until the model stops (BCC-4).
test("work without any task is continued once at session stop", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const ctx = context(project.root, "omp-taskless");
  appendEvent(project.root, "omp-taskless", { t: "edit", p: "src/post.md" });

  const first = await pi.events.get("session_stop")({}, ctx);
  const second = await pi.events.get("session_stop")({}, ctx);

  assert.equal(first.continue, true);
  assert.equal(first.decision, undefined, "the user must stay able to end the session");
  assert.match(first.additionalContext, /src\/post\.md/);
  assert.match(first.additionalContext, /backlog_task_create/);
  assert.equal(second, undefined, "one continuation per session, not the host's eight");
  assert.equal(deriveSession(project.root, "omp-taskless").metrics.tasklessContinues, 1);
});

test("an active task ends its session without a taskless continuation", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const id = await project.createTask("Already tracked", ["--ac", "Criterion remains open"]);
  await project.cli(["task", "edit", id, "-s", "In Progress"]);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  appendEvent(project.root, "omp-tracked", { t: "edit", p: "src/post.md" });

  assert.equal(await pi.events.get("session_stop")({}, context(project.root, "omp-tracked")), undefined);
  assert.equal(deriveSession(project.root, "omp-tracked").metrics.tasklessContinues, 0);
});

test("a session that already worked through Backlog.md is left alone", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  // What a finished task leaves behind: tools were used, and no task is active
  // any more because the model set the last one to Done.
  appendEvent(project.root, "omp-finished", { t: "metric", name: "tool", tool: "backlog_task_finish" });
  appendEvent(project.root, "omp-finished", { t: "edit", p: "src/post.md" });

  assert.equal(await pi.events.get("session_stop")({}, context(project.root, "omp-finished")), undefined);
});

test("a session that changed nothing is never held open for a task", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);

  assert.equal(await pi.events.get("session_stop")({}, context(project.root, "omp-question")), undefined);
});

test("native Backlog tools execute lifecycle mutations without a shell command", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const ctx = context(project.root, "omp-native-lifecycle");

  const create = await pi.tools.get("backlog_task_create").execute(
    "call-create",
    {
      title: "Native tool task",
      description: "Created without shell quoting.",
      acceptanceCriteria: ["The native tool records evidence."],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(create.isError, undefined, create.content[0].text);
  const id = JSON.parse((await project.cli(["task", "list", "--json"])).stdout).tasks.find(
    (task) => task.title === "Native tool task",
  ).id;

  const start = await pi.tools
    .get("backlog_task_start")
    .execute("call-start", { taskId: id }, undefined, undefined, ctx);
  assert.equal(start.isError, undefined, start.content[0].text);
  const plan = await pi.tools
    .get("backlog_task_plan")
    .execute("call-plan", { taskId: id, steps: ["Run the focused contract test."] }, undefined, undefined, ctx);
  assert.equal(plan.isError, undefined, plan.content[0].text);
  const checked = await pi.tools
    .get("backlog_check_ac")
    .execute("call-check", { taskId: id, index: 1, evidence: "native tool contract test" }, undefined, undefined, ctx);
  assert.equal(checked.isError, undefined, checked.content[0].text);
  const finished = await pi.tools
    .get("backlog_task_finish")
    .execute("call-finish", { taskId: id, summary: "Completed through native tools." }, undefined, undefined, ctx);
  assert.equal(finished.isError, undefined, finished.content[0].text);

  const task = JSON.parse((await project.cli(["task", id, "--json"])).stdout).task;
  assert.equal(task.status, "Done");
  assert.equal(task.acceptanceCriteria[0].checked, true);
  assert.match(task.implementationNotes, /native tool contract test/);
  assert.match(task.implementationPlan, /Run the focused contract test/);
  assert.match(task.finalSummary, /Completed through native tools/);
  assert.deepEqual(deriveSession(project.root, "omp-native-lifecycle").metrics, {
    guards: 0,
    toolCalls: {
      backlog_task_create: 1,
      backlog_task_start: 1,
      backlog_task_plan: 1,
      backlog_check_ac: 1,
      backlog_task_finish: 1,
    },
    acceptanceChecks: 1,
    unplannedStarts: 1,
    unfinishedSessions: 0,
    steeringMessages: 0,
    tasklessContinues: 0,
  });
});

// A decomposition is a dependency graph. Without these three the native path
// could create the nodes and nothing else, while the contract rule forbids
// reaching for a handwritten shell command instead (BCC-4).
test("a created task can name its dependencies, milestone and parent", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const ctx = context(project.root, "omp-create-graph");
  const first = await project.createTask("Comes first");
  const second = await project.createTask("Comes second");
  const parent = await project.createTask("Holds the work");
  const create = (title, extra) =>
    pi.tools
      .get("backlog_task_create")
      .execute(
        "call-create",
        { title, description: "Created with a graph around it.", acceptanceCriteria: ["It is recorded."], ...extra },
        undefined,
        undefined,
        ctx,
      );
  // `dependencies` is absent from `task list --json`, and `-p` renumbers the id,
  // so the title is the only stable handle back to the created task.
  const read = async (title) => {
    const listed = JSON.parse((await project.cli(["task", "list", "--json"])).stdout).tasks.find(
      (candidate) => candidate.title === title,
    );
    return JSON.parse((await project.cli(["task", listed.id, "--json"])).stdout).task;
  };

  const graph = await create("Depends on both", { dependencies: [first, second], milestone: "First release" });
  const child = await create("Belongs to a parent", { parent });
  const rootTask = await create("Waits for nothing", { dependencies: [] });

  assert.equal(graph.isError, undefined, graph.content[0].text);
  assert.equal(child.isError, undefined, child.content[0].text);
  assert.equal(rootTask.isError, undefined, rootTask.content[0].text);
  const created = await read("Depends on both");
  assert.deepEqual([...created.dependencies].sort(), [first, second].sort());
  assert.equal(created.milestone, "First release");
  assert.equal((await read("Belongs to a parent")).parentTaskId, parent);
  assert.deepEqual((await read("Waits for nothing")).dependencies, []);
});

// `minItems: 1` on an optional array rejects an explicit empty one, and the
// host validates before the tool runs, so nothing the plugin says is reached.
// Every task in an empty backlog waits for nothing, so a decompose run against
// one created no task at all — five refusals, then the model concluded the
// first task was impossible and wrote a file by hand (BCC-6).
test("the create tool requires a criterion but never a dependency", () => {
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const properties = pi.tools.get("backlog_task_create").parameters.properties;
  assert.equal(properties.dependencies.minItems, undefined);
  assert.equal(properties.acceptanceCriteria.minItems, 1, "a task with no criterion cannot be finished");
  assert.match(properties.dependencies.description, /omit it for a task with no predecessor/i);
});

// More than one task In Progress makes `resolveActiveTask` ambiguous, and the
// brief, the acceptance reminder and the end-of-session note go silent
// together. A session started thirteen at once and left the first one open
// with four unchecked criteria, unnoticed (BCC-5).
test("starting a task while another is In Progress names the others", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const ctx = context(project.root, "omp-parallel-start");
  const first = await project.createTask("Already running");
  const second = await project.createTask("Started next");
  const start = (id) =>
    pi.tools.get("backlog_task_start").execute("call-start", { taskId: id }, undefined, undefined, ctx);

  const one = await start(first);
  const two = await start(second);

  assert.equal(one.isError, undefined, one.content[0].text);
  assert.doesNotMatch(one.content[0].text, /Also In Progress/, "the only task in the column warns about nothing");
  assert.equal(two.isError, undefined, two.content[0].text);
  assert.match(two.content[0].text, new RegExp(`Also In Progress: ${first}\\b`));
  assert.match(two.content[0].text, /-s 'To Do'/, "the way back is named, since no native tool covers it");
});

// Backlog.md itself sets Done whatever the criteria say, so this is the only
// place the contract can hold (BCC-4).
test("a task with an unchecked criterion cannot be finished", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const ctx = context(project.root, "omp-premature-finish");
  const id = await project.createTask("Half done", ["--ac", "Checked later", "--ac", "Never checked"]);
  await pi.tools
    .get("backlog_check_ac")
    .execute("c", { taskId: id, index: 1, evidence: "e" }, undefined, undefined, ctx);

  const refused = await pi.tools
    .get("backlog_task_finish")
    .execute("call-finish", { taskId: id, summary: "Calling it done." }, undefined, undefined, ctx);

  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /#2/);
  assert.doesNotMatch(refused.content[0].text, /#1/, "a criterion with evidence is not part of the complaint");
  assert.match(refused.content[0].text, /backlog_check_ac/);
  // Eleven criteria were checked with "deferred to a later task" as their
  // evidence once this refusal existed: the cheapest exit has to be the honest
  // one (BCC-5).
  assert.match(refused.content[0].text, /--remove-ac/, "a criterion that cannot be verified has a way out");
  const task = JSON.parse((await project.cli(["task", id, "--json"])).stdout).task;
  assert.notEqual(task.status, "Done");
  assert.equal(task.finalSummary ?? "", "");
});

test("every file command has a native OMP registration", () => {
  const fileCommands = readdirSync(join(root, "commands"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -".md".length))
    .sort();

  assert.deepEqual([...COMMAND_NAMES].sort(), fileCommands);

  // OMP does not substitute ${CLAUDE_PLUGIN_ROOT} in a command body, so a
  // command that exists only as a file would ship that literal to the model.
  // The registration has to come from the directory, not from a list beside it.
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  assert.deepEqual(
    [...pi.commands.keys()].sort(),
    fileCommands.map((name) => `backlog-md:${name}`),
  );
  // Both entries appear in the picker under the same name; only this one runs.
  for (const [, options] of pi.commands) assert.match(options.description, /\(native\)$/);
});

test("OMP commands render the installed root and arguments without ambient Claude variables", async () => {
  const pi = mockExtensionApi();
  backlogMdExtension(pi);

  await pi.commands.get("backlog-md:start").handler("BACK-42");
  assert.equal(pi.userMessages.length, 1);
  const prompt = pi.userMessages[0].message;
  assert.match(prompt, /BACK-42/);
  assert.match(prompt, new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/scripts/backlog-cc\\.mjs`));
  assert.doesNotMatch(prompt, /CLAUDE_PLUGIN_ROOT|OMP_PLUGIN_ROOT|\$ARGUMENTS/);
  assert.match(prompt, /BACKLOG_MD_NODE:-node/);
});

test("one missing or malformed command template does not disable the OMP adapter", () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), "bcc-omp-commands-"));
  mkdirSync(join(pluginRoot, "commands"));
  for (const name of COMMAND_NAMES) {
    if (name === "doctor") continue;
    if (name === "next") writeFileSync(join(pluginRoot, "commands", "next.md"), "not frontmatter\n");
    else copyFileSync(join(root, "commands", `${name}.md`), join(pluginRoot, "commands", `${name}.md`));
  }

  try {
    const pi = mockExtensionApi();
    backlogMdExtension(pi, { pluginRoot });
    assert.equal(pi.commands.size, COMMAND_NAMES.length - 2);
    assert.equal(pi.events.has("tool_call"), true);
    assert.equal(pi.events.has("tool_result"), true);
    assert.equal(pi.events.has("session_shutdown"), true);
    assert.equal(pi.warnings.length, 2);
    assert.match(pi.warnings[0][0], /command (doctor|next) registration failed/);
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("OMP command-template failures persist for doctor and clear after recovery", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "bcc-omp-template-health-"));
  const pluginRoot = mkdtempSync(join(tmpdir(), "bcc-omp-template-root-"));
  mkdirSync(join(projectRoot, "backlog"));
  writeFileSync(join(projectRoot, "backlog", "config.yml"), "statuses: [To Do]\n");
  mkdirSync(join(pluginRoot, "commands"));
  for (const name of COMMAND_NAMES) {
    if (name === "doctor") continue;
    copyFileSync(join(root, "commands", `${name}.md`), join(pluginRoot, "commands", `${name}.md`));
  }

  try {
    backlogMdExtension(mockExtensionApi(), { pluginRoot, diagnosticCwd: projectRoot });
    assert.equal(
      readRuntimeFailures(projectRoot).some((failure) => failure.operation === "command doctor registration"),
      true,
    );
    assert.match(
      formatDoctor(await collectDoctor({ cwd: projectRoot, sessionId: "omp-template-health" })),
      /FAIL OMP command doctor registration failed/,
    );

    copyFileSync(join(root, "commands", "doctor.md"), join(pluginRoot, "commands", "doctor.md"));
    backlogMdExtension(mockExtensionApi(), { pluginRoot, diagnosticCwd: projectRoot });
    assert.equal(
      readRuntimeFailures(projectRoot).some((failure) => failure.operation === "command doctor registration"),
      false,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("OMP health resolves nested CWDs and ignores non-AST resolver results", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const nestedCwd = join(project.root, "packages", "adapter");
  mkdirSync(nestedCwd, { recursive: true });
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const ctx = context(nestedCwd, "omp-contract-health");
  const originalDateNow = Date.now;
  t.after(() => {
    Date.now = originalDateNow;
  });
  Date.now = () => 1;

  for (const [path, action] of [
    ["xd://resolve", "apply"],
    ["xd://reject", "discard"],
  ]) {
    pi.events.get("tool_result")(
      {
        toolName: "write",
        input: { path },
        details: { xdev: { inner: { action, sourceToolName: "custom-tool" } } },
        isError: false,
      },
      ctx,
    );
  }
  assert.equal(deriveSession(project.root, "omp-contract-health").sourceEdits, 0);
  assert.deepEqual(readRuntimeFailures(project.root), []);

  pi.events.get("tool_result")(
    {
      toolName: "write",
      input: { path: "xd://resolve" },
      details: {
        xdev: {
          inner: {
            action: "apply",
            sourceToolName: "ast_edit",
            sourceResultDetails: { applied: true, files: [] },
          },
        },
      },
      isError: false,
    },
    ctx,
  );
  assert.equal(deriveSession(project.root, "omp-contract-health").sourceEdits, 0);
  assert.deepEqual(readRuntimeFailures(project.root), []);

  pi.events.get("tool_result")(
    {
      toolName: "write",
      input: { path: "xd://resolve" },
      details: { xdev: { inner: { action: "apply", sourceToolName: "ast_edit" } } },
      isError: false,
    },
    ctx,
  );
  assert.equal(
    readRuntimeFailures(project.root).some((failure) => failure.operation === "tool recording"),
    true,
  );
  Date.now = originalDateNow;
  assert.match(
    formatDoctor(await collectDoctor({ cwd: nestedCwd, sessionId: "omp-contract-health" })),
    /FAIL OMP tool recording.*failed/,
  );
});

test("OMP sweeps unknown sessions without including itself when the manager is absent", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const bin = mkdtempSync(join(tmpdir(), "bcc-omp-node-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = join(bin, "args.log");
  const node = join(bin, "node");
  writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$*" > "$OMP_TEST_LOG"\n`);
  chmodSync(node, 0o755);

  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const previousNode = process.env.BACKLOG_MD_NODE;
  const previousLog = process.env.OMP_TEST_LOG;
  process.env.BACKLOG_MD_NODE = node;
  process.env.OMP_TEST_LOG = log;
  try {
    await pi.events.get("session_start")({}, { cwd: project.root });
    await waitFor(() => {
      try {
        return readFileSync(log, "utf8").length > 0;
      } catch {
        return false;
      }
    });
  } finally {
    if (previousNode === undefined) delete process.env.BACKLOG_MD_NODE;
    else process.env.BACKLOG_MD_NODE = previousNode;
    if (previousLog === undefined) delete process.env.OMP_TEST_LOG;
    else process.env.OMP_TEST_LOG = previousLog;
  }

  assert.equal(
    readRuntimeFailures(project.root).some((failure) => failure.operation === "OMP session manager contract"),
    true,
  );
  const args = readFileSync(log, "utf8");
  assert.match(args, /backlog-cc\.mjs sweep/);
  assert.doesNotMatch(args, /--include-self/);
});

test("OMP blocks direct Backlog edits, warns in guard-off mode, and records source edits", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const ctx = context(project.root, "omp-tools");
  const taskPath = join(project.root, "backlog", "tasks", "BACK-12 - Guard.md");
  // Written first: an edit of a file that does not exist is a create, and gets
  // the create reason instead (BCC-6).
  writeFileSync(taskPath, "---\nid: BACK-12\n---\n");
  const editInput = { input: `[${taskPath}#A1B2]\nPUT >1:\n+changed` };

  const blocked = pi.events.get("tool_call")({ toolName: "edit", input: editInput }, ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /BACK-12[\s\S]*backlog task edit BACK-12 --help/);

  const mountedAst = {
    path: "xd://ast_edit",
    content: JSON.stringify({ ops: [{ pat: "$A", out: "$A" }], paths: [taskPath] }),
  };
  const mountedLsp = {
    path: "xd://lsp",
    content: JSON.stringify({ action: "rename_file", file: taskPath, new_name: "renamed.md" }),
  };
  assert.equal(pi.events.get("tool_call")({ toolName: "write", input: mountedAst }, ctx).block, true);
  assert.equal(pi.events.get("tool_call")({ toolName: "write", input: mountedLsp }, ctx).block, true);
  assert.equal(
    pi.events.get("tool_call")({ toolName: "write", input: { path: "xd://lsp", content: "{bad json" } }, ctx),
    undefined,
  );

  const previousGuard = process.env.BACKLOG_MD_GUARD;
  process.env.BACKLOG_MD_GUARD = "0";
  try {
    const warned = pi.events.get("tool_call")({ toolName: "edit", input: editInput }, ctx);
    assert.equal(warned, undefined);
    assert.match(lastMessage(pi, "message").message.content, /Warning, not blocked/);
    assert.deepEqual(lastMessage(pi, "message").options, { deliverAs: "nextTurn" });
    const mountedWarning = pi.events.get("tool_call")({ toolName: "write", input: mountedLsp }, ctx);
    assert.equal(mountedWarning, undefined);
    assert.match(lastMessage(pi, "message").message.content, /Warning, not blocked/);
  } finally {
    if (previousGuard === undefined) delete process.env.BACKLOG_MD_GUARD;
    else process.env.BACKLOG_MD_GUARD = previousGuard;
  }

  await pi.events.get("tool_result")(
    {
      toolName: "edit",
      input: { input: "[src/a.mjs#B2C3]\nPUT >1:\n+changed" },
      details: undefined,
      isError: false,
    },
    ctx,
  );
  const derived = deriveSession(project.root, "omp-tools");
  assert.equal(derived.sourceEdits, 1);
  assert.deepEqual(derived.pendingModifiedFiles, ["src/a.mjs"]);
  assert.equal(derived.metrics.guards, 5);

  const preview = {
    toolName: "ast_edit",
    input: { paths: ["src/staged.mjs"] },
    details: { applied: false, files: ["src/staged.mjs"], totalReplacements: 1 },
    isError: false,
  };
  pi.events.get("tool_result")(preview, ctx);
  assert.equal(deriveSession(project.root, "omp-tools").sourceEdits, 1, "a staged preview is not an edit");
  pi.events.get("tool_result")(
    {
      toolName: "write",
      input: { path: "xd://ast_edit", content: JSON.stringify({ paths: ["src/mounted-preview.mjs"] }) },
      details: { xdev: { inner: { sourceResultDetails: { files: ["src/mounted-preview.mjs"] } } } },
      isError: false,
    },
    ctx,
  );
  assert.equal(deriveSession(project.root, "omp-tools").sourceEdits, 1, "a mounted AST preview is not an edit");
  pi.events.get("tool_result")(
    {
      toolName: "write",
      input: { path: "xd://reject", content: "not applicable" },
      details: { xdev: { inner: { action: "discard", sourceToolName: "ast_edit" } } },
      isError: false,
    },
    ctx,
  );
  assert.equal(deriveSession(project.root, "omp-tools").sourceEdits, 1, "a rejected preview stays unrecorded");

  pi.events.get("tool_result")(preview, ctx);
  pi.events.get("tool_result")(
    {
      toolName: "write",
      input: { path: "xd://resolve", content: "apply the proposed rewrite" },
      details: {
        xdev: {
          inner: {
            action: "apply",
            sourceToolName: "ast_edit",
            sourceResultDetails: { applied: true, files: ["src/staged.mjs"] },
          },
        },
      },
      isError: false,
    },
    ctx,
  );
  const resolved = deriveSession(project.root, "omp-tools");
  assert.equal(resolved.sourceEdits, 2);
  assert.deepEqual(resolved.pendingModifiedFiles.sort(), ["src/a.mjs", "src/staged.mjs"]);
});

test("OMP blocks unsafe quoting in direct Backlog shell commands", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);

  const blocked = pi.events.get("tool_call")(
    { toolName: "bash", input: { command: "backlog task edit BCC-9 --append-plan $'one\\ntwo'" } },
    context(project.root, "omp-quoting"),
  );

  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /unsafe shell quoting/i);
  assert.match(blocked.reason, /backlog task edit BCC-9 --append-plan 'one\ntwo'/);
});

test("OMP injects active-task and prompt observations through native events", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const active = await project.createTask("Active OMP task");
  const foreign = await project.createTask("Foreign OMP task");
  const currentForeign = await project.createTask("Current foreign OMP task");
  const started = await project.cli(["task", "edit", active, "-s", "In Progress"]);
  assert.equal(started.ok, true, started.stderr || started.stdout);

  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const ctx = context(project.root, "omp-context");
  await pi.events.get("session_start")({}, ctx);
  assert.match(lastMessage(pi, "message").message.content, new RegExp(active));
  assert.deepEqual(lastMessage(pi, "message").options, { deliverAs: "nextTurn" });

  await pi.events.get("session_compact")({}, ctx);
  assert.match(lastMessage(pi, "message").message.content, new RegExp(active));
  assert.deepEqual(lastMessage(pi, "message").options, { deliverAs: "nextTurn" });

  pi.events.get("input")({ text: `Review ${foreign}`, source: "interactive" }, ctx);
  const observation = await pi.events.get("before_agent_start")({ prompt: `Review ${currentForeign}` }, ctx);
  assert.ok(
    observation,
    "before_agent_start returned nothing — the prompt observation exceeded its budget. Raise BACKLOG_MD_TIMEOUT_SCALE when running under load.",
  );
  assert.match(observation.message.content, new RegExp(currentForeign));
  assert.doesNotMatch(observation.message.content, new RegExp(foreign));
  assert.equal(observation.message.display, false);
});

test("OMP shutdown delegates the session flush to a detached Node child", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const bin = mkdtempSync(join(tmpdir(), "bcc-omp-node-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = join(bin, "args.log");
  const node = join(bin, "node");
  writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$*" > "$OMP_TEST_LOG"\n`);
  chmodSync(node, 0o755);

  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const previousNode = process.env.BACKLOG_MD_NODE;
  const previousLog = process.env.OMP_TEST_LOG;
  process.env.BACKLOG_MD_NODE = node;
  process.env.OMP_TEST_LOG = log;
  try {
    await pi.events.get("session_shutdown")({}, context(project.root, "omp-shutdown"));
    await waitFor(() => {
      try {
        return readFileSync(log, "utf8").length > 0;
      } catch {
        return false;
      }
    });
  } finally {
    if (previousNode === undefined) delete process.env.BACKLOG_MD_NODE;
    else process.env.BACKLOG_MD_NODE = previousNode;
    if (previousLog === undefined) delete process.env.OMP_TEST_LOG;
    else process.env.OMP_TEST_LOG = previousLog;
  }

  const args = readFileSync(log, "utf8");
  assert.match(args, /scripts\/backlog-cc\.mjs flush omp-shutdown/);
});

test("OMP worker spawn failures persist until a newer spawn succeeds", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const ctx = context(project.root, "omp-worker-health");
  const previousNode = process.env.BACKLOG_MD_NODE;

  try {
    process.env.BACKLOG_MD_NODE = join(project.root, "missing-node");
    await pi.events.get("session_shutdown")({}, ctx);
    assert.equal(
      readRuntimeFailures(project.root).some((failure) => failure.operation === "session flush worker"),
      true,
    );

    process.env.BACKLOG_MD_NODE = process.execPath;
    await pi.events.get("session_shutdown")({}, ctx);
    assert.equal(
      readRuntimeFailures(project.root).some((failure) => failure.operation === "session flush worker"),
      false,
    );
  } finally {
    if (previousNode === undefined) delete process.env.BACKLOG_MD_NODE;
    else process.env.BACKLOG_MD_NODE = previousNode;
  }
});

test("OMP message failures persist for doctor and clear after a newer success", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const active = await project.createTask("OMP health task");
  const started = await project.cli(["task", "edit", active, "-s", "In Progress"]);
  assert.equal(started.ok, true, started.stderr || started.stdout);

  const pi = mockExtensionApi();
  pi.logger.warn = () => {
    throw new Error("logger unavailable");
  };
  backlogMdExtension(pi);
  const ctx = context(project.root, "omp-message-health");
  pi.sendMessage = () => {
    throw new Error("message channel unavailable");
  };
  await pi.events.get("session_compact")({}, ctx);
  assert.equal(
    readRuntimeFailures(project.root).some(
      (failure) => failure.operation === "OMP session_compact" && /message channel unavailable/.test(failure.message),
    ),
    true,
  );

  pi.sendMessage = (message, options) => pi.messages.push({ message, options });
  await pi.events.get("session_compact")({}, ctx);
  assert.equal(
    readRuntimeFailures(project.root).some((failure) => failure.operation === "OMP session_compact"),
    false,
  );
});

// The counters used to live only in the journal, which the flush worker deletes
// on every terminal outcome — so a clean session lost them, and
// `unfinished-session`, recorded one statement before that worker is spawned,
// was never observable at all.
test("OMP shutdown freezes the session counters before the worker that deletes them", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);
  const active = await project.createTask("OMP unfinished task");
  const started = await project.cli(["task", "edit", active, "-s", "In Progress"]);
  assert.equal(started.ok, true, started.stderr || started.stdout);

  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const previousNode = process.env.BACKLOG_MD_NODE;
  process.env.BACKLOG_MD_NODE = join(project.root, "missing-node");
  try {
    await pi.events.get("session_shutdown")({}, context(project.root, "omp-summary"));
  } finally {
    if (previousNode === undefined) delete process.env.BACKLOG_MD_NODE;
    else process.env.BACKLOG_MD_NODE = previousNode;
  }

  clearJournal(project.root, "omp-summary");
  assert.equal(deriveSession(project.root, "omp-summary").metrics.unfinishedSessions, 0);

  const [summary] = listSessionSummaries(project.root);
  assert.equal(summary?.sessionId, "omp-summary");
  assert.equal(summary.metrics.unfinishedSessions, 1);
});

// The summary write used to report through the flush worker's callback, and a
// worker that spawns clears every failure recorded at or before its own
// attempt — so the entry was deleted microseconds after it was written, and a
// full state directory or an unwritable one stayed invisible.
test("a summary the shutdown cannot write is reported apart from the worker that succeeds", async (t) => {
  if (!(await backlogAvailable())) return t.skip("backlog not installed");
  const project = await makeProject();
  t.after(project.cleanup);

  const pi = mockExtensionApi();
  backlogMdExtension(pi);
  const ctx = context(project.root, "omp-summary-health");
  // A directory where the summary file belongs: the rename that publishes it
  // fails and nothing else does, so the two channels can be told apart.
  const blocked = summaryPath(project.root, "omp-summary-health");
  mkdirSync(blocked, { recursive: true });

  const previousNode = process.env.BACKLOG_MD_NODE;
  process.env.BACKLOG_MD_NODE = process.execPath;
  try {
    await pi.events.get("session_shutdown")({}, ctx);
    const failures = readRuntimeFailures(project.root);
    assert.equal(
      failures.some((failure) => failure.operation === "session summary"),
      true,
    );
    assert.equal(
      failures.some((failure) => failure.operation === "session flush worker"),
      false,
    );

    rmSync(blocked, { recursive: true, force: true });
    await pi.events.get("session_shutdown")({}, ctx);
    assert.equal(
      readRuntimeFailures(project.root).some((failure) => failure.operation === "session summary"),
      false,
    );
  } finally {
    if (previousNode === undefined) delete process.env.BACKLOG_MD_NODE;
    else process.env.BACKLOG_MD_NODE = previousNode;
  }
});
