import assert from "node:assert/strict";
import test from "node:test";
import {
  apiKeyFor,
  normalizeModelConfig,
  providerForModel,
  publicModelRegistry,
  registerGameDefaults,
} from "../src/platform/model-registry.js";

test("publishes every selectable model, provider, and reasoning effort", () => {
  const registry = publicModelRegistry();
  assert.deepEqual(registry.models.map((model) => model.id), [
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-luna",
    "gpt-6-astra",
    "deepseek-v4-pro",
    "deepseek-flash",
  ]);
  assert.ok(!registry.models.some((model) => model.id.startsWith("gpt-5.6")));
  assert.deepEqual(registry.providers.map((provider) => provider.id), ["openai", "deepseek"]);
  assert.deepEqual(registry.reasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(registry.defaultConfig, { model: "gpt-6-luna", reasoningEffort: "low" });
});

test("defaults every game to GPT-6 Luna at low effort and rejects arbitrary configuration", () => {
  for (const gameId of ["holdem", "go", "wuziqi", "doudizhu", "liars-dice"]) {
    assert.deepEqual(normalizeModelConfig(gameId), { model: "gpt-6-luna", reasoningEffort: "low" });
  }
  assert.deepEqual(normalizeModelConfig("wuziqi", { model: "gpt-6.1-sol", reasoningEffort: "MAX" }), {
    model: "gpt-6.1-sol",
    reasoningEffort: "max",
  });
  assert.throws(() => normalizeModelConfig("holdem", { model: "local-model" }), /Unsupported model/);
  assert.throws(() => normalizeModelConfig("holdem", { model: "gpt-5.6-luna" }), /Unsupported model/);
  assert.throws(() => normalizeModelConfig("holdem", { reasoningEffort: "automatic" }), /Unsupported reasoning effort/);
  assert.throws(() => normalizeModelConfig("../etc", {}), /Unknown game/);
});

test("uses a room's registered defaults", () => {
  registerGameDefaults("test-room", { model: "gpt-6.1-terra", reasoningEffort: "medium" });
  assert.deepEqual(normalizeModelConfig("test-room"), { model: "gpt-6.1-terra", reasoningEffort: "medium" });
  assert.deepEqual(publicModelRegistry().defaults["test-room"], { model: "gpt-6.1-terra", reasoningEffort: "medium" });
});

test("accepts DeepSeek V4 Pro at every reasoning effort and maps the legacy flash id", () => {
  for (const gameId of ["holdem", "go", "wuziqi", "doudizhu"]) {
    for (const reasoningEffort of ["none", "low", "medium", "high", "xhigh", "max"]) {
      assert.deepEqual(normalizeModelConfig(gameId, { model: "deepseek-v4-pro", reasoningEffort }), {
        model: "deepseek-v4-pro",
        reasoningEffort,
      });
    }
  }
  assert.equal(normalizeModelConfig("go", { model: "deepseek-v4-flash" }).model, "deepseek-flash");
});

test("routes each model to its owning provider", () => {
  assert.equal(providerForModel("gpt-6.1-sol"), "openai");
  assert.equal(providerForModel("deepseek-v4-pro"), "deepseek");
  assert.throws(() => providerForModel("local-model"), /Unsupported model/);
});

test("prefers a room-specific key and falls back to the provider-wide key", () => {
  const managed = ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_GO_API_KEY", "OPENAI_GO_API_KEY", "OPENAI_WUZIQI_API_KEY", "OPENAI_LIARS_DICE_API_KEY"];
  const restore = Object.fromEntries(managed.map((name) => [name, process.env[name]]));
  try {
    delete process.env.DEEPSEEK_GO_API_KEY;
    process.env.DEEPSEEK_API_KEY = "shared-deepseek";
    process.env.OPENAI_API_KEY = "shared-openai";
    process.env.OPENAI_GO_API_KEY = "openai-go";

    assert.deepEqual(apiKeyFor("deepseek", "go"), { envName: "DEEPSEEK_API_KEY", value: "shared-deepseek" });
    assert.deepEqual(apiKeyFor("openai", "go"), { envName: "OPENAI_GO_API_KEY", value: "openai-go" });

    process.env.DEEPSEEK_GO_API_KEY = "dedicated-go";
    assert.deepEqual(apiKeyFor("deepseek", "go"), { envName: "DEEPSEEK_GO_API_KEY", value: "dedicated-go" });

    delete process.env.OPENAI_WUZIQI_API_KEY;
    assert.deepEqual(apiKeyFor("openai", "wuziqi"), { envName: "OPENAI_API_KEY", value: "shared-openai" });

    process.env.OPENAI_LIARS_DICE_API_KEY = "dice";
    assert.deepEqual(apiKeyFor("openai", "liars-dice"), { envName: "OPENAI_LIARS_DICE_API_KEY", value: "dice" });

    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_WUZIQI_API_KEY;
    assert.deepEqual(apiKeyFor("openai", "wuziqi"), { envName: "OPENAI_WUZIQI_API_KEY", value: undefined });
  } finally {
    for (const name of managed) {
      if (restore[name] === undefined) delete process.env[name];
      else process.env[name] = restore[name];
    }
  }
});
