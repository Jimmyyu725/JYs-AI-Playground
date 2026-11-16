import { requestDeepSeekStructuredDecision } from "./deepseek-gateway.js";
import { normalizeModelConfig, providerForModel } from "./model-registry.js";
import { requestOpenAIStructuredDecision } from "./openai-gateway.js";

export { AIDecisionError } from "./ai-decision-error.js";

const PROVIDER_GATEWAYS = {
  openai: requestOpenAIStructuredDecision,
  deepseek: requestDeepSeekStructuredDecision,
};

/**
 * Routes a structured game decision to the gateway that owns the selected model.
 * Every provider returns the same shape so the game engines stay provider-agnostic.
 */
export async function requestStructuredDecision({ gameId, modelConfig, ...request }, callbacks = {}) {
  const config = normalizeModelConfig(gameId, modelConfig);
  const provider = providerForModel(config.model);
  const gateway = PROVIDER_GATEWAYS[provider];
  if (!gateway) throw new Error(`No gateway is registered for provider “${provider}”`);
  return gateway({ ...request, gameId, config }, callbacks);
}
