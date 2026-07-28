export const OPENAI_MODELS = Object.freeze([
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", shortLabel: "Sol", description: "Frontier capability" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", shortLabel: "Terra", description: "Balanced intelligence and cost" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", shortLabel: "Luna", description: "Fast, cost-conscious play" },
]);

export const REASONING_EFFORTS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);

export const GAME_DEFAULTS = Object.freeze({
  holdem: Object.freeze({ model: "gpt-5.6-luna", reasoningEffort: "medium" }),
  go: Object.freeze({ model: "gpt-5.6-terra", reasoningEffort: "medium" }),
  wuziqi: Object.freeze({ model: "gpt-5.6-luna", reasoningEffort: "medium" }),
});

const modelIds = new Set(OPENAI_MODELS.map((model) => model.id));
const reasoningEfforts = new Set(REASONING_EFFORTS);

export function normalizeModelConfig(gameId, config = {}) {
  const defaults = GAME_DEFAULTS[gameId];
  if (!defaults) throw new Error(`Unknown game “${gameId}”`);
  const model = String(config.model ?? defaults.model);
  const reasoningEffort = String(config.reasoningEffort ?? defaults.reasoningEffort).toLowerCase();
  if (!modelIds.has(model)) throw new Error(`Unsupported OpenAI model “${model}”`);
  if (!reasoningEfforts.has(reasoningEffort)) throw new Error(`Unsupported reasoning effort “${reasoningEffort}”`);
  return { model, reasoningEffort };
}

export function modelMetadata(modelId) {
  return OPENAI_MODELS.find((model) => model.id === modelId) ?? null;
}

export function apiKeyForGame(gameId) {
  const envNames = {
    holdem: "OPENAI_API_KEY",
    go: "OPENAI_GO_API_KEY",
    wuziqi: "OPENAI_WUZIQI_API_KEY",
  };
  const envName = envNames[gameId];
  if (!envName) throw new Error(`Unknown game “${gameId}”`);
  return { envName, value: process.env[envName] };
}

export function publicModelRegistry() {
  return {
    models: OPENAI_MODELS.map(({ id, label, shortLabel, description }) => ({ id, label, shortLabel, description })),
    reasoningEfforts: [...REASONING_EFFORTS],
    defaults: Object.fromEntries(Object.entries(GAME_DEFAULTS).map(([gameId, config]) => [gameId, { ...config }])),
  };
}
