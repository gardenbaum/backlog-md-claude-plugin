import { test } from "node:test";
import assert from "node:assert/strict";
import { compareMetrics, ignoredAgentDirOverride, modelsConfigFor } from "../../eval/run.mjs";
import { EVALUATION_TASKS } from "../../eval/tasks.mjs";

test("comparative evaluation fixes five distinct workflow scenarios", () => {
  assert.deepEqual(
    EVALUATION_TASKS.map((task) => task.id),
    ["next", "plan-before-start", "acceptance-evidence", "correct-denial", "finish-verified"],
  );
  for (const task of EVALUATION_TASKS) {
    assert.equal(typeof task.prompt, "string");
    assert.ok(task.prompt.trim());
    assert.equal(typeof task.seed.title, "string");
    assert.ok(task.seed.criteria.length > 0);
  }
});

test("comparative evaluation totals each model independently", () => {
  assert.deepEqual(
    compareMetrics([
      {
        model: "first",
        metrics: {
          guards: 1,
          toolCalls: { backlog_next: 1 },
          acceptanceChecks: 0,
          unplannedStarts: 0,
          unfinishedSessions: 0,
          steeringMessages: 0,
        },
      },
      {
        model: "first",
        metrics: {
          guards: 0,
          toolCalls: { backlog_next: 2 },
          acceptanceChecks: 1,
          unplannedStarts: 1,
          unfinishedSessions: 0,
          steeringMessages: 1,
        },
      },
      { model: "second", metrics: null },
    ]),
    {
      first: {
        guards: 1,
        toolCalls: { backlog_next: 3 },
        acceptanceChecks: 1,
        unplannedStarts: 1,
        unfinishedSessions: 0,
        steeringMessages: 1,
      },
      second: {
        guards: 0,
        toolCalls: {},
        acceptanceChecks: 0,
        unplannedStarts: 0,
        unfinishedSessions: 0,
        steeringMessages: 0,
      },
    },
  );
});

test("comparative evaluation replays MiniMax reasoning as textual history", () => {
  assert.equal(
    modelsConfigFor("minimax-code/MiniMax-M2"),
    [
      "providers:",
      "  minimax-code:",
      "    modelOverrides:",
      "      MiniMax-M2:",
      "        compat:",
      "          requiresThinkingAsText: true",
      "",
    ].join("\n"),
  );
  assert.equal(modelsConfigFor("openai/gpt-5"), null);
});

test("comparative evaluation refuses to run under an OMP profile", () => {
  assert.equal(ignoredAgentDirOverride({}), null);
  assert.equal(ignoredAgentDirOverride({ OMP_PROFILE: "  " }), null);
  assert.equal(ignoredAgentDirOverride({ OMP_PROFILE: "work" }), "OMP_PROFILE");
  assert.equal(ignoredAgentDirOverride({ PI_PROFILE: "work" }), "PI_PROFILE");
});
