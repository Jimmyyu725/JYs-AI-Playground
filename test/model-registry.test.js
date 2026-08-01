import assert from "node:assert/strict";
import test from "node:test";
import { apiKeyFor, normalizeModelConfig, providerForModel, publicModelRegistry } from "../src/platform/model-registry.js";

test("publishes every selectable model, provider, and reasoning effort", () => {
  const registry = publicModelRegistry();
  assert.deepEqual(registry.models.map((model) => model.id), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "deepseek-v4-pro",
  ]);
  assert.deepEqual(registry.providers.map((provider) => provider.id), ["openai", "deepseek"]);
  assert.deepEqual(registry.reasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
});

test("normalizes game defaults and rejects arbitrary model configuration", () => {
  assert.deepEqual(normalizeModelConfig("go"), { model: "gpt-5.6-terra", reasoningEffort: "medium" });
  assert.deepEqual(normalizeModelConfig("wuziqi", { model: "gpt-5.6-sol", reasoningEffort: "MAX" }), {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
  });
  assert.throws(() => normalizeModelConfig("holdem", { model: "local-model" }), /Unsupported model/);
  assert.throws(() => normalizeModelConfig("holdem", { reasoningEffort: "automatic" }), /Unsupported reasoning effort/);
});

test("accepts DeepSeek V4 Pro at every reasoning effort in every game", () => {
  for (const gameId of ["holdem", "go", "wuziqi"]) {
    for (const reasoningEffort of ["none", "low", "medium", "high", "xhigh", "max"]) {
      assert.deepEqual(normalizeModelConfig(gameId, { model: "deepseek-v4-pro", reasoningEffort }), {
        model: "deepseek-v4-pro",
        reasoningEffort,
      });
    }
  }
});

test("routes each model to its owning provider", () => {
  assert.equal(providerForModel("gpt-5.6-sol"), "openai");
  assert.equal(providerForModel("deepseek-v4-pro"), "deepseek");
  assert.throws(() => providerForModel("local-model"), /Unsupported model/);
});

test("keeps provider credentials separate and falls back to the shared DeepSeek key", () => {
  const managed = ["DEEPSEEK_API_KEY", "DEEPSEEK_GO_API_KEY", "OPENAI_GO_API_KEY", "OPENAI_WUZIQI_API_KEY"];
  const restore = Object.fromEntries(managed.map((name) => [name, process.env[name]]));
  try {
    delete process.env.DEEPSEEK_GO_API_KEY;
    process.env.DEEPSEEK_API_KEY = "shared-deepseek";
    process.env.OPENAI_GO_API_KEY = "openai-go";

    assert.deepEqual(apiKeyFor("deepseek", "go"), { envName: "DEEPSEEK_API_KEY", value: "shared-deepseek" });
    assert.deepEqual(apiKeyFor("openai", "go"), { envName: "OPENAI_GO_API_KEY", value: "openai-go" });

    process.env.DEEPSEEK_GO_API_KEY = "dedicated-go";
    assert.deepEqual(apiKeyFor("deepseek", "go"), { envName: "DEEPSEEK_GO_API_KEY", value: "dedicated-go" });

    // An OpenAI game never falls back to another room's credential.
    delete process.env.OPENAI_WUZIQI_API_KEY;
    assert.deepEqual(apiKeyFor("openai", "wuziqi"), { envName: "OPENAI_WUZIQI_API_KEY", value: undefined });
  } finally {
    for (const name of managed) {
      if (restore[name] === undefined) delete process.env[name];
      else process.env[name] = restore[name];
    }
  }
});
