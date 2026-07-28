import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelConfig, publicModelRegistry } from "../src/platform/model-registry.js";

test("publishes every selectable GPT-5.6 model and reasoning effort", () => {
  const registry = publicModelRegistry();
  assert.deepEqual(registry.models.map((model) => model.id), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  assert.deepEqual(registry.reasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
});

test("normalizes game defaults and rejects arbitrary model configuration", () => {
  assert.deepEqual(normalizeModelConfig("go"), { model: "gpt-5.6-terra", reasoningEffort: "medium" });
  assert.deepEqual(normalizeModelConfig("wuziqi", { model: "gpt-5.6-sol", reasoningEffort: "MAX" }), {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
  });
  assert.throws(() => normalizeModelConfig("holdem", { model: "local-model" }), /Unsupported OpenAI model/);
  assert.throws(() => normalizeModelConfig("holdem", { reasoningEffort: "automatic" }), /Unsupported reasoning effort/);
});
