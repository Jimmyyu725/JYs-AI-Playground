import { AIDecisionError, requestStructuredDecision } from "../platform/decision-gateway.js";
import { analyzeCombo, beatsCombo, describeCombo, isValidCardCode } from "./doudizhu-game.js";

export const DOUDIZHU_PLAY_MAX_ATTEMPTS = 3;
const RETRYABLE_PLAY_CODES = new Set(["illegal_play", "invalid_play"]);
const RETRYABLE_BID_CODES = new Set(["invalid_bid"]);

const BID_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["bid", "pass"] },
    score: { anyOf: [{ type: "integer" }, { type: "null" }] },
    explanation: { type: "string", minLength: 1, maxLength: 420 },
  },
  required: ["action", "score", "explanation"],
  additionalProperties: false,
};

const PLAY_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["play", "pass"] },
    cards: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
    explanation: { type: "string", minLength: 1, maxLength: 420 },
  },
  required: ["action", "cards", "explanation"],
  additionalProperties: false,
};

function characterIntro(snapshot) {
  return `You are ${snapshot.actor.name}, ${snapshot.actor.title}, playing Dou Dizhu in the Landlord Room.
Character: ${snapshot.actor.personality}`;
}

function sharedRules(snapshot) {
  const { rules, table } = snapshot;
  return `Rank order: ${rules.rankOrder}.
Card codes: ${rules.cardCodes}
Legal combos: ${rules.combos}
Following: ${rules.following}
Your hand (codes, sorted high to low): ${snapshot.actor.hand.join(" ")}.
Your hand grouped by rank (rank:count): ${snapshot.actor.handByRank}.
${snapshot.actor.isLandlord ? "You are the landlord." : "You are a farmer; the two farmers are teammates."}
Opponents: ${table.players.filter((player) => player.seat !== snapshot.actor.seat).map((player) => `${player.name} (${player.cardCount} cards)`).join("; ")}.`;
}

function bidInstructions(snapshot) {
  const { table } = snapshot;
  const retryContext = snapshot.retryContext;
  const retryText = retryContext
    ? `\n\nAUTOMATIC RETRY ${retryContext.retryNumber}/${retryContext.maxRetries}: The previous bid ${JSON.stringify(retryContext.rejectedDecision)} was rejected: ${retryContext.previousError}. Do not repeat it.`
    : "";
  return `${characterIntro(snapshot)}

Bidding is open. The current highest bid is ${table.currentBid}. You may pass, or bid ${Math.min(3, table.currentBid + 1)} or more up to 3 (3 wins immediately and the landlord gets the three bottom cards). Bid like a Dou Dizhu player: consider hand strength, big cards, bombs, and jokers.

${sharedRules(snapshot)}

For pass set action "pass" and score null. For bid set action "bid" and score to your chosen integer that is strictly higher than ${table.currentBid} (at most 3). The explanation is a public high-level rationale of at most 45 words. Return only the requested structured decision.${retryText}`;
}

function playInstructions(snapshot, retryContext = null) {
  const retryText = retryContext
    ? `\n\nAUTOMATIC RETRY ${retryContext.retryNumber}/${retryContext.maxRetries}: The previous play ${JSON.stringify(retryContext.rejectedDecision)} was rejected as illegal or malformed. Do not repeat it. Re-check the combo rules and the beat requirement before answering.`
    : "";
  const { play } = snapshot;
  const beatText = play.mustBeat
    ? `You must beat: ${play.mustBeat.description} (combo type ${play.mustBeat.comboType}, length ${play.mustBeat.length}, main rank ${play.mustBeat.mainRank}). Either play the same combo type with the same length and a higher main rank, or a bomb, or the rocket.`
    : "You lead this trick: choose any legal combo freely.";
  const passText = play.leading ? "You may not pass." : "You may pass.";
  const exampleText = (snapshot.actor.exampleLeads ?? []).length
    ? `The house verified these example legal plays from your hand: ${snapshot.actor.exampleLeads.map((example) => `${example.description} (${example.cards.join(" ")})`).join("; ")}.`
    : "The house found no example leads in your hand.";
  return `${characterIntro(snapshot)}

${sharedRules(snapshot)}

${beatText} ${passText}

${exampleText}

Every card in a play must belong to ONE single legal combo. ILLEGAL examples: two unrelated singles like 3C 4C; a pair plus one extra card; four cards of two different ranks; a straight containing 2, SJ, or BJ. When unsure, choose the simplest legal option such as one of the examples above. For pass set action "pass" and cards null. For play set action "play" and cards to the exact card codes from your hand. The explanation is a public high-level rationale of at most 45 words. Return only the requested structured decision.${retryText}`;
}

function rejectedDecision(error) {
  return error?.rejectedDecision ?? null;
}

export async function requestDoudizhuBid(snapshot, modelConfig, callbacks = {}) {
  const response = await requestStructuredDecision({
    gameId: "doudizhu",
    modelConfig,
    tableTalk: { voice: snapshot.actor?.voice ?? "" },
    instructions: bidInstructions(snapshot),
    input: snapshot,
    schemaName: "doudizhu_bid",
    schema: BID_SCHEMA,
  }, callbacks);
  const decision = response.output;
  validateBidDecision(decision, snapshot);
  return {
    action: decision.action,
    score: decision.action === "bid" ? decision.score : null,
    explanation: String(decision.explanation ?? "Bid decided.").slice(0, 420),
    reasoningSummary: response.reasoningSummary,
    responseId: response.responseId,
    tableTalk: response.tableTalk ?? null,
  };
}

export function validateBidDecision(decision, snapshot) {
  const reject = (message) => {
    const error = new AIDecisionError(message, "invalid_bid");
    error.rejectedDecision = { action: decision.action, score: decision.score };
    throw error;
  };
  if (decision.action === "bid") {
    if (!Number.isInteger(decision.score) || decision.score < 1 || decision.score > 3) reject("The model returned an invalid bid score");
    if (decision.score <= snapshot.table.currentBid) reject(`The model bid ${decision.score}, which does not beat ${snapshot.table.currentBid}`);
  } else if (decision.score !== null) {
    reject("Passing must not include a bid score");
  }
}

/** Retries malformed or illegal bids twice with the error fed back, then throws so the table pauses. */
export async function requestDoudizhuBidWithRetry(options) {
  return requestDoudizhuPlayWithRetry({
    requestDecision: requestDoudizhuBid,
    retryableCodes: RETRYABLE_BID_CODES,
    ...options,
  });
}

export function validatePlayDecision(decision, snapshot) {
  if (decision.action === "play") {
    if (!Array.isArray(decision.cards) || decision.cards.length === 0) {
      const error = new AIDecisionError("The model chose to play without listing cards", "invalid_play");
      error.rejectedDecision = decision;
      throw error;
    }
    for (const code of decision.cards) {
      if (typeof code !== "string" || !isValidCardCode(code)) {
        const error = new AIDecisionError(`The model returned an unknown card code`, "invalid_play");
        error.rejectedDecision = decision;
        throw error;
      }
      if (!snapshot.actor.hand.includes(code)) {
        const error = new AIDecisionError(`The model played ${code}, which is not in its hand`, "illegal_play");
        error.rejectedDecision = decision;
        throw error;
      }
    }
    let combo;
    try {
      combo = analyzeCombo(decision.cards);
    } catch (error) {
      const illegal = new AIDecisionError(error.message, "illegal_play");
      illegal.rejectedDecision = decision;
      throw illegal;
    }
    if (!snapshot.play.leading && snapshot.play.mustBeat) {
      const target = {
        type: snapshot.play.mustBeat.comboType,
        mainRank: snapshot.play.mustBeat.mainRank,
        length: snapshot.play.mustBeat.length,
      };
      if (!beatsCombo(combo, target)) {
        const illegal = new AIDecisionError(
          `${describeCombo(combo)} cannot beat ${snapshot.play.mustBeat.description}`,
          "illegal_play",
        );
        illegal.rejectedDecision = decision;
        throw illegal;
      }
    }
  } else if (decision.cards !== null) {
    const error = new AIDecisionError("Passing must not include cards", "invalid_play");
    error.rejectedDecision = decision;
    throw error;
  } else if (snapshot.play.leading) {
    const error = new AIDecisionError("The model passed while leading the trick", "illegal_play");
    error.rejectedDecision = decision;
    throw error;
  }
  return {
    action: decision.action,
    cards: decision.action === "play" ? decision.cards : null,
  };
}

export async function requestDoudizhuPlay(snapshot, modelConfig, callbacks = {}) {
  const response = await requestStructuredDecision({
    gameId: "doudizhu",
    modelConfig,
    tableTalk: { voice: snapshot.actor?.voice ?? "" },
    instructions: playInstructions(snapshot),
    input: snapshot,
    schemaName: "doudizhu_play",
    schema: PLAY_SCHEMA,
  }, callbacks);
  const decision = validatePlayDecision(response.output, snapshot);
  return {
    ...decision,
    explanation: String(response.output.explanation ?? "Decision complete.").slice(0, 420),
    reasoningSummary: response.reasoningSummary,
    responseId: response.responseId,
    tableTalk: response.tableTalk ?? null,
  };
}

export async function requestDoudizhuPlayWithRetry({
  snapshotFactory,
  modelConfig,
  callbacks = {},
  onRetry,
  shouldContinue = () => true,
  maxAttempts = DOUDIZHU_PLAY_MAX_ATTEMPTS,
  requestDecision = requestDoudizhuPlay,
  retryableCodes = RETRYABLE_PLAY_CODES,
}) {
  const attemptLimit = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : DOUDIZHU_PLAY_MAX_ATTEMPTS;
  let previousError = null;

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    const baseSnapshot = snapshotFactory();
    const snapshot = previousError
      ? {
          ...baseSnapshot,
          retryContext: {
            retryNumber: attempt - 1,
            maxRetries: attemptLimit - 1,
            previousError: previousError.message,
            rejectedDecision: rejectedDecision(previousError),
          },
        }
      : baseSnapshot;

    try {
      const decision = await requestDecision(snapshot, modelConfig, callbacks);
      return { decision, attempts: attempt };
    } catch (error) {
      const retryable = error instanceof AIDecisionError && retryableCodes.has(error.code);
      if (!retryable || attempt >= attemptLimit || !shouldContinue()) throw error;
      previousError = error;
      await onRetry?.({
        error,
        retryNumber: attempt,
        maxRetries: attemptLimit - 1,
      });
    }
  }

  throw previousError;
}

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    review: { type: "string", minLength: 1, maxLength: 900 },
  },
  required: ["review"],
  additionalProperties: false,
};

/** Builds the public, post-game material a character reviews: who sat where and every logged move. */
export function reviewInput(table, seat) {
  const reviewer = table.players[seat];
  return {
    reviewer: { seat, name: reviewer.name, role: seat === table.landlordSeat ? "landlord" : "farmer" },
    players: table.players.map((player) => ({
      seat: player.seat,
      name: player.name,
      role: player.seat === table.landlordSeat ? "landlord" : "farmer",
      cardsLeft: player.hand.length,
    })),
    result: table.result,
    moves: table.logs
      .filter((entry) => entry.handNumber === table.handNumber && ["bid", "play", "hand", "result"].includes(entry.kind))
      .map((entry) => entry.text),
  };
}

/** A short in-character review of the finished hand, written by one of the AI seats. */
export async function requestDoudizhuReview(table, seat, callbacks = {}) {
  const reviewer = table.players[seat];
  if (!reviewer || reviewer.isHuman) throw new AIDecisionError("Only an AI seat can review the hand", "invalid_review");
  const character = reviewer.character ?? {};
  const instructions = `You are ${reviewer.name}, ${character.title ?? "a regular"} at a Dou Dizhu table in an old Shanghai lane on New Year's Eve.
Character: ${character.personality ?? ""}
Voice: ${character.voice ?? ""}

The hand is over. Review it for the other players in your own voice: name the two or three moments that decided it (a bid, a bomb, a lead, a pass), what you or others should have done differently, and one lesson. Use only the public record in the input. At most 120 words, plain text, no Markdown.`;
  const response = await requestStructuredDecision({
    gameId: "doudizhu",
    modelConfig: reviewer.aiConfig,
    instructions,
    input: reviewInput(table, seat),
    schemaName: "doudizhu_review",
    schema: REVIEW_SCHEMA,
  }, callbacks);
  return String(response.output.review ?? "").trim().slice(0, 900);
}
