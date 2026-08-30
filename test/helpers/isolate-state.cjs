const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const state = mkdtempSync(join(tmpdir(), "backlog-md-test-state-"));
process.env.XDG_STATE_HOME = state;
process.once("exit", () => rmSync(state, { recursive: true, force: true }));
