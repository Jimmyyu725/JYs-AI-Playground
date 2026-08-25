export const OPENAI_MODELS = Object.freeze([
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", shortLabel: "Sol", description: "Frontier capability", provider: "openai" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", shortLabel: "Terra", description: "Balanced intelligence and cost", provider: "openai" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", shortLabel: "Luna", description: "Fast, cost-conscious play", provider: "openai" },
]);

export const DEEPSEEK_MODELS = Object.freeze([
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", shortLabel: "Pro", description: "Frontier DeepSeek reasoning", provider: "deepseek" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", shortLabel: "Flash", description: "Fast, cost-conscious DeepSeek play", provider: "deepseek" },
]);

export const ALL_MODELS = Object.freeze([...OPENAI_MODELS, ...DEEPSEEK_MODELS]);

export const REASONING_EFFORTS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);

export const GAME_DEFAULTS = Object.freeze({
  holdem: Object.freeze({ model: "gpt-5.6-luna", reasoningEffort: "medium" }),
  go: Object.freeze({ model: "gpt-5.6-terra", reasoningEffort: "medium" }),
  wuziqi: Object.freeze({ model: "gpt-5.6-luna", reasoningEffort: "medium" }),
  doudizhu: Object.freeze({ model: "gpt-5.6-luna", reasoningEffort: "medium" }),
});

const modelIds = new Set(ALL_MODELS.map((model) => model.id));
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
  return ALL_MODELS.find((model) => model.id === modelId) ?? null;
}

export function modelProvider(modelId) {
  return modelMetadata(modelId)?.provider ?? null;
}

export function apiKeyForGame(gameId) {
  const envNames = {
    holdem: "OPENAI_API_KEY",
    go: "OPENAI_GO_API_KEY",
    wuziqi: "OPENAI_WUZIQI_API_KEY",
    doudizhu: "OPENAI_DOUDIZHU_API_KEY",
  };
  const envName = envNames[gameId];
  if (!envName) throw new Error(`Unknown game “${gameId}”`);
  return { envName, value: process.env[envName] };
}

export function deepseekApiKeyForGame(gameId) {
  const envNames = {
    holdem: "DEEPSEEK_API_KEY",
    go: "DEEPSEEK_GO_API_KEY",
    wuziqi: "DEEPSEEK_WUZIQI_API_KEY",
    doudizhu: "DEEPSEEK_DOUDIZHU_API_KEY",
  };
  const envName = envNames[gameId];
  if (!envName) throw new Error(`Unknown game “${gameId}”`);
  return { envName, value: process.env[envName] || process.env.DEEPSEEK_API_KEY };
}

export function publicModelRegistry() {
  return {
    models: ALL_MODELS.map(({ id, label, shortLabel, description, provider }) => ({ id, label, shortLabel, description, provider })),
    reasoningEfforts: [...REASONING_EFFORTS],
    defaults: Object.fromEntries(Object.entries(GAME_DEFAULTS).map(([gameId, config]) => [gameId, { ...config }])),
  };
}
