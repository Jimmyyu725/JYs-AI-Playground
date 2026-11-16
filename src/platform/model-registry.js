export const PROVIDERS = Object.freeze({
  openai: Object.freeze({
    id: "openai",
    label: "OpenAI",
    // A room may carry its own credential (OPENAI_<ROOM>_API_KEY); otherwise it shares OPENAI_API_KEY.
    envPrefix: "OPENAI",
    sharedEnvName: "OPENAI_API_KEY",
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    envPrefix: "DEEPSEEK",
    sharedEnvName: "DEEPSEEK_API_KEY",
  }),
});

// Every id below was verified on 2026-11-17 to answer a strict structured-output request
// with the same request shape the gateways send.
export const AI_MODELS = Object.freeze([
  { id: "gpt-6.1-sol", provider: "openai", label: "GPT-6.1 Sol", shortLabel: "Sol", description: "Frontier capability", vision: true },
  { id: "gpt-6.1-terra", provider: "openai", label: "GPT-6.1 Terra", shortLabel: "Terra", description: "Balanced intelligence and cost", vision: true },
  { id: "gpt-6-luna", provider: "openai", label: "GPT-6 Luna", shortLabel: "Luna", description: "Fast, cost-conscious play", vision: true },
  { id: "gpt-6-astra", provider: "openai", label: "GPT-6 Astra", shortLabel: "Astra", description: "Deliberate, slower thinker", vision: true },
  { id: "deepseek-v4-pro", provider: "deepseek", label: "DeepSeek V4 Pro", shortLabel: "V4 Pro", description: "DeepSeek reasoning flagship", vision: false },
  { id: "deepseek-flash", provider: "deepseek", label: "DeepSeek Flash", shortLabel: "Flash", description: "Fast, cost-conscious DeepSeek play", vision: false },
]);

// Older ids that saved games or bookmarked setups may still send.
const MODEL_ALIASES = Object.freeze({ "deepseek-v4-flash": "deepseek-flash" });

export const REASONING_EFFORTS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_MODEL_CONFIG = Object.freeze({ model: "gpt-6-luna", reasoningEffort: "low" });

const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const gameDefaults = new Map();

/** Rooms call this (through server.js) so their own defaults apply; unregistered ids use DEFAULT_MODEL_CONFIG. */
export function registerGameDefaults(gameId, defaults = DEFAULT_MODEL_CONFIG) {
  assertGameId(gameId);
  const normalized = normalizeAgainst({ ...DEFAULT_MODEL_CONFIG, ...defaults }, DEFAULT_MODEL_CONFIG);
  gameDefaults.set(gameId, Object.freeze(normalized));
  return normalized;
}

export function registeredGameIds() {
  return [...gameDefaults.keys()];
}

function assertGameId(gameId) {
  if (typeof gameId !== "string" || !GAME_ID_PATTERN.test(gameId)) throw new Error(`Unknown game “${gameId}”`);
}

const modelIds = new Set(AI_MODELS.map((model) => model.id));
const reasoningEfforts = new Set(REASONING_EFFORTS);

function normalizeAgainst(config, defaults) {
  let model = String(config.model ?? defaults.model);
  model = MODEL_ALIASES[model] ?? model;
  const reasoningEffort = String(config.reasoningEffort ?? defaults.reasoningEffort).toLowerCase();
  if (!modelIds.has(model)) throw new Error(`Unsupported model “${model}”`);
  if (!reasoningEfforts.has(reasoningEffort)) throw new Error(`Unsupported reasoning effort “${reasoningEffort}”`);
  return { model, reasoningEffort };
}

export function gameDefaultsFor(gameId) {
  assertGameId(gameId);
  return gameDefaults.get(gameId) ?? DEFAULT_MODEL_CONFIG;
}

export function normalizeModelConfig(gameId, config = {}) {
  return normalizeAgainst(config ?? {}, gameDefaultsFor(gameId));
}

export function modelMetadata(modelId) {
  const id = MODEL_ALIASES[modelId] ?? modelId;
  return AI_MODELS.find((model) => model.id === id) ?? null;
}

export function providerForModel(modelId) {
  const model = modelMetadata(modelId);
  if (!model) throw new Error(`Unsupported model “${modelId}”`);
  return model.provider;
}

export function gameEnvName(provider, gameId) {
  const descriptor = PROVIDERS[provider];
  if (!descriptor) throw new Error(`Unknown provider “${provider}”`);
  assertGameId(gameId);
  return `${descriptor.envPrefix}_${gameId.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/** Room-specific key first (e.g. OPENAI_GO_API_KEY), then the provider-wide key. */
export function apiKeyFor(provider, gameId) {
  const envName = gameEnvName(provider, gameId);
  if (process.env[envName]) return { envName, value: process.env[envName] };
  const shared = PROVIDERS[provider].sharedEnvName;
  if (process.env[shared]) return { envName: shared, value: process.env[shared] };
  return { envName, value: undefined };
}

export function apiKeyForGame(gameId) {
  return apiKeyFor("openai", gameId);
}

export function configuredProviderKeys(gameIds = registeredGameIds()) {
  return Object.fromEntries(
    Object.keys(PROVIDERS).map((provider) => [
      provider,
      Object.fromEntries(gameIds.map((gameId) => [gameId, Boolean(apiKeyFor(provider, gameId).value)])),
    ]),
  );
}

export function publicModelRegistry() {
  return {
    models: AI_MODELS.map(({ id, provider, label, shortLabel, description, vision }) => ({ id, provider, label, shortLabel, description, vision })),
    providers: Object.values(PROVIDERS).map(({ id, label }) => ({ id, label })),
    reasoningEfforts: [...REASONING_EFFORTS],
    defaultConfig: { ...DEFAULT_MODEL_CONFIG },
    defaults: Object.fromEntries([...gameDefaults].map(([gameId, config]) => [gameId, { ...config }])),
  };
}
