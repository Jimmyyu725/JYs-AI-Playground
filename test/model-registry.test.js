import assert from "node:assert/strict";
import test from "node:test";
import { deepseekApiKeyForGame, modelProvider, normalizeModelConfig, publicModelRegistry } from "../src/platform/model-registry.js";

test("publishes every selectable model and reasoning effort", () => {
  const registry = publicModelRegistry();
  assert.deepEqual(registry.models.map((model) => model.id), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
  ]);
  assert.deepEqual(registry.reasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
});

test("normalizes game defaults and rejects arbitrary model configuration", () => {
  assert.deepEqual(normalizeModelConfig("go"), { model: "gpt-5.6-terra", reasoningEffort: "medium" });
  assert.deepEqual(normalizeModelConfig("wuziqi", { model: "gpt-5.6-sol", reasoningEffort: "MAX" }), {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
  });
  assert.deepEqual(normalizeModelConfig("holdem", { model: "deepseek-v4-flash", reasoningEffort: "high" }), {
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
  });
  assert.throws(() => normalizeModelConfig("holdem", { model: "local-model" }), /Unsupported model/);
  assert.throws(() => normalizeModelConfig("holdem", { reasoningEffort: "automatic" }), /Unsupported reasoning effort/);
});

test("maps every model to its provider", () => {
  assert.equal(modelProvider("gpt-5.6-luna"), "openai");
  assert.equal(modelProvider("deepseek-v4-pro"), "deepseek");
  assert.equal(modelProvider("deepseek-v4-flash"), "deepseek");
  assert.equal(modelProvider("local-model"), null);
});

test("resolves DeepSeek credentials per room with a shared fallback", () => {
  process.env.DEEPSEEK_API_KEY = "shared-key";
  delete process.env.DEEPSEEK_GO_API_KEY;
  assert.equal(deepseekApiKeyForGame("go").value, "shared-key");
  process.env.DEEPSEEK_GO_API_KEY = "go-key";
  assert.equal(deepseekApiKeyForGame("go").value, "go-key");
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_GO_API_KEY;
});
