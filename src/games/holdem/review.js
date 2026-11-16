import { requestStructuredDecision } from "../../platform/decision-gateway.js";

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    review: { type: "string", minLength: 1, maxLength: 700 },
  },
  required: ["review"],
  additionalProperties: false,
};

/** What the reviewer may know: the public record of the last hand, every shown hand, and its own cards. */
export function reviewInput(table, reviewer) {
  const hand = table.handNumber;
  return {
    handNumber: hand,
    reviewer: { seat: reviewer.seat, name: reviewer.name, ownHoleCards: reviewer.holeCards, stack: reviewer.stack },
    blinds: { small: table.smallBlind, big: table.bigBlind },
    board: table.communityCards,
    players: table.players.map((player) => ({
      seat: player.seat,
      name: player.name,
      isHuman: player.isHuman,
      stack: player.stack,
      folded: player.folded,
      shownCards: player.hasShown ? player.holeCards : null,
    })),
    log: table.logs.filter((entry) => entry.handNumber === hand).map((entry) => entry.text),
    result: table.lastShowdown,
  };
}

export async function requestHandReview(table, reviewer) {
  const result = await requestStructuredDecision({
    gameId: "holdem",
    modelConfig: reviewer.aiConfig,
    instructions: `You are ${reviewer.name}, ${reviewer.character?.title ?? "a guest"}, at a no-limit Texas Hold'em table in a 1960s Riviera card salon.

Character: ${reviewer.character?.personality ?? ""}
Voice: ${reviewer.character?.voice ?? ""}

The hand is over. Review it for the other players in your own voice: name the one or two decisions that mattered most (yours or anyone's), what a stronger line would have been, and why. Use only the public log, the shown cards and your own hole cards; never guess unshown cards as fact. Be concrete about bet sizes and streets. At most 110 words, plain prose, no lists or Markdown.`,
    input: reviewInput(table, reviewer),
    schemaName: "holdem_hand_review",
    schema: REVIEW_SCHEMA,
  });
  return { review: String(result.output?.review ?? "").trim() };
}
