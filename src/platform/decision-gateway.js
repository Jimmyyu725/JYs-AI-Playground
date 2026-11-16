import { requestDeepSeekStructuredDecision } from "./deepseek-gateway.js";
import { modelMetadata, normalizeModelConfig, providerForModel } from "./model-registry.js";
import { requestOpenAIStructuredDecision } from "./openai-gateway.js";
import { cleanTableTalk, tableTalkInstruction, withTableTalk } from "./table-talk.js";

export { AIDecisionError } from "./ai-decision-error.js";

const PROVIDER_GATEWAYS = {
  openai: requestOpenAIStructuredDecision,
  deepseek: requestDeepSeekStructuredDecision,
};

/**
 * Routes a structured game decision to the gateway that owns the selected model.
 * Every provider returns the same shape so the game engines stay provider-agnostic.
 */
export async function requestStructuredDecision({ gameId, modelConfig, tableTalk = null, ...request }, callbacks = {}) {
  const config = normalizeModelConfig(gameId, modelConfig);
  const provider = providerForModel(config.model);
  const gateway = PROVIDER_GATEWAYS[provider];
  if (!gateway) throw new Error(`No gateway is registered for provider “${provider}”`);
  // An optional `image` (data URL) only reaches vision models; text-only models get the text input alone.
  if (request.image && !modelMetadata(config.model)?.vision) delete request.image;
  // `tableTalk: { voice }` opts the decision into one optional public in-character line.
  if (tableTalk) {
    request.schema = withTableTalk(request.schema);
    request.instructions = `${request.instructions}${tableTalkInstruction(tableTalk.voice)}`;
  }
  const result = await gateway({ ...request, gameId, config }, callbacks);
  if (!tableTalk) return result;
  const { tableTalk: line, ...output } = result.output ?? {};
  return { ...result, output, tableTalk: cleanTableTalk(line) };
}
