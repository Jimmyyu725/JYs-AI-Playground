// Post-game review: a finished game's move list goes to one of the AI characters, who
// answers in their own voice with a short review, the turning point and one piece of advice.

import { requestStructuredDecision } from "../../platform/decision-gateway.js";
import { describeResult } from "./engine.js";

export const XIANGQI_REVIEW_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    review: { type: "string", minLength: 1, maxLength: 700 },
    turningPoint: { type: "string", minLength: 1, maxLength: 300 },
    advice: { type: "string", minLength: 1, maxLength: 300 },
  },
  required: ["review", "turningPoint", "advice"],
  additionalProperties: false,
});

export function buildReviewRequest(table, side) {
  const player = table.playerFor(side);
  const opponent = table.playerFor(side === "red" ? "black" : "red");
  const character = player.character;
  const moves = table.state.history.map((entry) =>
    entry.resigned
      ? `${entry.side} resigned`
      : `${entry.ply}. ${entry.side} ${entry.move}${entry.captured ? ` captures ${entry.captured}` : ""}${entry.check ? " check" : ""}`,
  );
  const instructions = `You are ${character.name}, ${character.title}. ${character.personality ?? ""}
Your voice: ${character.voice ?? ""}

You just played ${side} in a game of Xiangqi (Chinese chess) against ${opponent.name}${opponent.isHuman ? " (a human player)" : ""}. Review the game for your opponent, in your own voice, honestly and concretely.
Moves are in ICCS notation: files a-i from Red's left, ranks 0-9 from Red's back rank. Uppercase pieces are Red, lowercase Black (K general, A advisor, B elephant, N horse, R chariot, C cannon, P soldier).
"review" is 2-4 sentences on how the game went. "turningPoint" names the move (by ply number and ICCS) where it was decided and why. "advice" is one practical lesson for ${opponent.name}. Do not invent moves that are not in the list. Plain text, no markdown.`;
  const input = {
    result: describeResult(table.state.result),
    youPlayed: side,
    plies: table.state.ply,
    moves,
  };
  return { player, instructions, input };
}

export async function requestXiangqiReview(table, side, { gateway = requestStructuredDecision, callbacks = {} } = {}) {
  const { player, instructions, input } = buildReviewRequest(table, side);
  const response = await gateway({
    gameId: "xiangqi",
    modelConfig: player.aiConfig,
    instructions,
    input,
    schemaName: "xiangqi_review",
    schema: XIANGQI_REVIEW_SCHEMA,
  }, callbacks);
  const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return {
    side,
    playerName: player.name,
    characterId: player.character?.id ?? null,
    review: clip(response.output?.review, 700),
    turningPoint: clip(response.output?.turningPoint, 300),
    advice: clip(response.output?.advice, 300),
    at: Date.now(),
  };
}
