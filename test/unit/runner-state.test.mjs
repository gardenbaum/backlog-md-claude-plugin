import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { stateBase } from "../../lib/cache.mjs";

test("the Node test worker owns a private plugin state directory", () => {
  const state = process.env.XDG_STATE_HOME;
  assert.ok(state, "the runner must provide XDG_STATE_HOME");
  assert.match(basename(state), /^backlog-md-test-state-/);
  assert.equal(stateBase(), state);
});
