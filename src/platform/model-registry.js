export const PROVIDERS = Object.freeze({
  openai: Object.freeze({
    id: "openai",
    label: "OpenAI",
    // Each game keeps its own credential so a leaked key cannot reach the other rooms.
    envNames: Object.freeze({ holdem: "OPENAI_API_KEY", go: "OPENAI_GO_API_KEY", wuziqi: "OPENAI_WUZIQI_API_KEY" }),
    sharedEnvName: null,
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    envNames: Object.freeze({ holdem: "DEEPSEEK_API_KEY", go: "DEEPSEEK_GO_API_KEY", wuziqi: "DEEPSEEK_WUZIQI_API_KEY" }),
    // A single DEEPSEEK_API_KEY covers every room until per-game keys are configured.
    sharedEnvName: "DEEPSEEK_API_KEY",
  }),
});

export const AI_MODELS = Object.freeze([
  { id: "gpt-5.6-sol", provider: "openai", label: "GPT-5.6 Sol", shortLabel: "Sol", description: "Frontier capability" },
  { id: "gpt-5.6-terra", provider: "openai", label: "GPT-5.6 Terra", shortLabel: "Terra", description: "Balanced intelligence and cost" },
  { id: "gpt-5.6-luna", provider: "openai", label: "GPT-5.6 Luna", shortLabel: "Luna", description: "Fast, cost-conscious play" },
  { id: "deepseek-v4-pro", provider: "deepseek", label: "DeepSeek V4 Pro", shortLabel: "V4 Pro", description: "DeepSeek reasoning flagship" },
]);

export const REASONING_EFFORTS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);

export const GAME_DEFAULTS = Object.freeze({
  holdem: Object.freeze({ model: "gpt-5.6-luna", reasoningEffort: "medium" }),
  go: Object.freeze({ model: "gpt-5.6-terra", reasoningEffort: "medium" }),
  wuziqi: Object.freeze({ model: "gpt-5.6-luna", reasoningEffort: "medium" }),
});

const modelIds = new Set(AI_MODELS.map((model) => model.id));
const reasoningEfforts = new Set(REASONING_EFFORTS);

export function normalizeModelConfig(gameId, config = {}) {
  const defaults = GAME_DEFAULTS[gameId];
  if (!defaults) throw new Error(`Unknown game “${gameId}”`);
  const model = String(config.model ?? defaults.model);
  const reasoningEffort = String(config.reasoningEffort ?? defaults.reasoningEffort).toLowerCase();
  if (!modelIds.has(model)) throw new Error(`Unsupported model “${model}”`);
  if (!reasoningEfforts.has(reasoningEffort)) throw new Error(`Unsupported reasoning effort “${reasoningEffort}”`);
  return { model, reasoningEffort };
}

export function modelMetadata(modelId) {
  return AI_MODELS.find((model) => model.id === modelId) ?? null;
}

export function providerForModel(modelId) {
  const model = modelMetadata(modelId);
  if (!model) throw new Error(`Unsupported model “${modelId}”`);
  return model.provider;
}

export function apiKeyFor(provider, gameId) {
  const descriptor = PROVIDERS[provider];
  if (!descriptor) throw new Error(`Unknown provider “${provider}”`);
  const envName = descriptor.envNames[gameId];
  if (!envName) throw new Error(`Unknown game “${gameId}”`);
  if (process.env[envName]) return { envName, value: process.env[envName] };
  const shared = descriptor.sharedEnvName;
  if (shared && process.env[shared]) return { envName: shared, value: process.env[shared] };
  return { envName, value: undefined };
}

export function apiKeyForGame(gameId) {
  return apiKeyFor("openai", gameId);
}

export function configuredProviderKeys() {
  return Object.fromEntries(
    Object.keys(PROVIDERS).map((provider) => [
      provider,
      Object.fromEntries(Object.keys(GAME_DEFAULTS).map((gameId) => [gameId, Boolean(apiKeyFor(provider, gameId).value)])),
    ]),
  );
}

export function publicModelRegistry() {
  return {
    models: AI_MODELS.map(({ id, provider, label, shortLabel, description }) => ({ id, provider, label, shortLabel, description })),
    providers: Object.values(PROVIDERS).map(({ id, label }) => ({ id, label })),
    reasoningEfforts: [...REASONING_EFFORTS],
    defaults: Object.fromEntries(Object.entries(GAME_DEFAULTS).map(([gameId, config]) => [gameId, { ...config }])),
  };
}
