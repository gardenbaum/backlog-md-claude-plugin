import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import backlogMdExtension from "../../omp/index.mjs";
import { COMMAND_NAMES } from "../../lib/commands.mjs";
import { deriveSession, readRuntimeFailures } from "../../lib/cache.mjs";
import { collectDoctor, formatDoctor } from "../../scripts/backlog-cc.mjs";
import { backlogAvailable, makeProject } from "../helpers/fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function mockExtensionApi() {
  const events = new Map();
  const commands = new Map();
  const messages = [];
  const commandRegistrations = [];
  const userMessages = [];
  const warnings = [];
  const api = {
    events,
    commands,
    commandRegistrations,
    messages,
    userMessages,
    warnings,
    logger: { warn: (...args) => warnings.push(args) },
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, options) => {
      commandRegistrations.push(name);
      commands.set(name, options);
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
    "session_switch",
    "session_tree",
    "tool_call",
    "tool_result",
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
  const editInput = { input: `[${taskPath}#A1B2]\nPUT >1:\n+changed` };

  const blocked = pi.events.get("tool_call")({ toolName: "edit", input: editInput }, ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /BACK-12[\s\S]*backlog task edit --help/);

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
    assert.match(pi.messages.at(-1).message.content, /Warning, not blocked/);
    assert.deepEqual(pi.messages.at(-1).options, { deliverAs: "nextTurn" });
    const mountedWarning = pi.events.get("tool_call")({ toolName: "write", input: mountedLsp }, ctx);
    assert.equal(mountedWarning, undefined);
    assert.match(pi.messages.at(-1).message.content, /Warning, not blocked/);
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
  assert.match(pi.messages.at(-1).message.content, new RegExp(active));
  assert.deepEqual(pi.messages.at(-1).options, { deliverAs: "nextTurn" });

  await pi.events.get("session_compact")({}, ctx);
  assert.match(pi.messages.at(-1).message.content, new RegExp(active));
  assert.deepEqual(pi.messages.at(-1).options, { deliverAs: "nextTurn" });

  pi.events.get("input")({ text: `Review ${foreign}`, source: "interactive" }, ctx);
  const observation = await pi.events.get("before_agent_start")({ prompt: `Review ${currentForeign}` }, ctx);
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
