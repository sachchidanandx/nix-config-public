// Run: node --test pi/agent/extensions/plan-mode/*.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFreshSession, modelFlagGiven, readModeDefaults } from "./models.ts";

describe("mode defaults", () => {
  it("reads planMode.plan / planMode.execute", () => {
    assert.deepEqual(
      readModeDefaults({
        planMode: {
          plan: { model: "fireworks/accounts/fireworks/routers/kimi-latest", thinking: "high" },
          execute: { model: " anthropic/claude-sonnet-5-5 " },
        },
      }),
      {
        defaults: {
          plan: { provider: "fireworks", id: "accounts/fireworks/routers/kimi-latest", thinking: "high" },
          execute: { provider: "anthropic", id: "claude-sonnet-5-5" },
        },
        problems: [],
      },
    );
  });

  it("treats missing settings as no defaults", () => {
    assert.deepEqual(readModeDefaults(undefined), { defaults: {}, problems: [] });
    assert.deepEqual(readModeDefaults({ planMode: "x" }), { defaults: {}, problems: [] });
    assert.deepEqual(readModeDefaults({ planMode: {} }), { defaults: {}, problems: [] });
  });

  it("reports malformed entries and keeps the model when only thinking is bad", () => {
    const { defaults, problems } = readModeDefaults({
      planMode: { plan: { model: "kimi-latest" }, execute: { model: "fireworks/glm", thinking: "ultra" } },
    });
    assert.deepEqual(defaults, { execute: { provider: "fireworks", id: "glm" } });
    assert.deepEqual(problems, [
      'planMode.plan.model must be "provider/modelId"',
      "planMode.execute.thinking must be one of: off, minimal, low, medium, high, xhigh, max",
    ]);
    assert.deepEqual(readModeDefaults({ planMode: { plan: "fireworks/x", execute: { model: "a/" } } }).problems, [
      'planMode.plan.model must be "provider/modelId"',
      'planMode.execute.model must be "provider/modelId"',
    ]);
  });
});

describe("session start", () => {
  it("is fresh until the first user message", () => {
    assert.equal(isFreshSession([]), true);
    assert.equal(
      isFreshSession([
        { type: "model_change" },
        { type: "custom", customType: "plan-mode-state" },
        { type: "message", message: { role: "system" } },
      ]),
      true,
    );
    assert.equal(isFreshSession([{ type: "message", message: { role: "user" } }]), false);
  });

  it("detects an explicit startup model", () => {
    assert.equal(modelFlagGiven(["bun", "pi", "--model", "sonnet"]), true);
    assert.equal(modelFlagGiven(["bun", "pi", "--provider=anthropic"]), true);
    assert.equal(modelFlagGiven(["bun", "pi", "--models", "a,b", "--plan"]), false);
  });
});
