// Model calls for the Draw & Guess room: one structured decision per seat turn
// (with automatic retries that feed the error back), and one generated image
// per round for an AI (or prompt-writing human) drawer.

import { AIDecisionError } from "../../platform/ai-decision-error.js";
import { requestStructuredDecision } from "../../platform/decision-gateway.js";
import { apiKeyFor } from "../../platform/model-registry.js";
import { DRAW_GUESS_DECISION_MAX_ATTEMPTS, buildAiView, decisionInstructions, decisionSchema, numberedActions, parseDecision, toAIDecisionError } from "./ai-view.js";

export const IMAGE_MODEL = "gpt-image-2.6-flare";
const GAME_ID = "draw-guess";

// Gateway failures that come from the model's answer itself (not the network) are retried with feedback.
const RETRYABLE_GATEWAY_CODES = new Set(["invalid_json", "empty_output"]);

function retryText(previous, attempt) {
  if (!previous) return "";
  return `\n\nAUTOMATIC RETRY ${attempt - 1}/${DRAW_GUESS_DECISION_MAX_ATTEMPTS - 1}: your previous answer ${JSON.stringify(previous.output ?? null)} was rejected: ${previous.message}. Fix that and answer again.`;
}

/**
 * Asks one AI seat for its decision. `getState()` returns the live engine state (it may move on
 * while the model thinks); `getImage(state, seat, now)` returns the (blurred) data URL a guesser
 * may see. Returns { action, response } or null when the seat no longer has a decision to make.
 * Throws AIDecisionError after the retries are spent, or at once on a network/API failure.
 */
export async function requestDrawGuessDecision({ getState, seat, modelConfig, character, getImage, isCurrent = () => true, request = requestStructuredDecision }, callbacks = {}) {
  let previous = null;
  for (let attempt = 1; attempt <= DRAW_GUESS_DECISION_MAX_ATTEMPTS; attempt += 1) {
    const state = getState();
    const now = Date.now();
    if (!state || !numberedActions(state, seat, { now }).length) return null;
    const view = buildAiView(state, seat, { now, character: character ? { name: character.name, title: character.title, personality: character.personality } : null });
    const image = view.guessing && getImage ? await getImage(state, seat, now) : null;
    const voice = character?.voice ? `\nYour table-talk voice: ${character.voice}` : "";
    let response;
    try {
      response = await request({
        gameId: GAME_ID,
        modelConfig,
        instructions: `${decisionInstructions(view)}${voice}${retryText(previous, attempt)}`,
        input: view,
        schemaName: "draw_guess_decision",
        schema: decisionSchema(state, seat, { now }),
        ...(image ? { image } : {}),
      }, callbacks);
    } catch (error) {
      if (!(error instanceof AIDecisionError) || !RETRYABLE_GATEWAY_CODES.has(error.code) || attempt >= DRAW_GUESS_DECISION_MAX_ATTEMPTS) throw error;
      previous = { output: null, message: error.message };
      continue;
    }
    if (!isCurrent()) return null;
    const live = getState();
    const parsed = parseDecision(live, seat, response.output, { now: Date.now() });
    if (parsed.ok) return { action: parsed.action, response, attempts: attempt };
    if (!parsed.retryable) return null;
    previous = { output: response.output, message: parsed.message };
    if (attempt >= DRAW_GUESS_DECISION_MAX_ATTEMPTS) throw toAIDecisionError(parsed, response.output);
  }
  return null;
}

/** The fixed frame around the drawer's prompt. It adds style only, never the word. */
export function imagePromptFor(prompt) {
  return `A painterly gouache illustration on cream watercolour paper, one clear subject, centred, simple uncluttered background. ${prompt} Absolutely no text, letters, numbers, labels, captions or signatures anywhere in the image.`;
}

/** Generates one 1024x1024 PNG for the round. Returns a Buffer. */
export async function generateRoundImage(prompt, { quality = "low", fetchImpl = fetch } = {}) {
  const { envName, value: apiKey } = apiKeyFor("openai", GAME_ID);
  if (!apiKey) throw new AIDecisionError(`${envName} is not set, so the room cannot paint the picture`, "missing_api_key");
  let response;
  try {
    response = await fetchImpl("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt: imagePromptFor(prompt), size: "1024x1024", quality, output_format: "png", n: 1 }),
    });
  } catch (error) {
    throw new AIDecisionError(`Could not reach the image model: ${error.message}`, "connection_error");
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Handled below.
  }
  if (!response.ok) {
    const detail = String(payload?.error?.message ?? `HTTP ${response.status}`).slice(0, 300);
    throw new AIDecisionError(`The image model refused the picture: ${detail}`, "image_error");
  }
  const b64 = payload?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) throw new AIDecisionError("The image model returned no picture", "image_error");
  return Buffer.from(b64, "base64");
}
