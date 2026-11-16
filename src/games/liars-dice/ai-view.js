// Model-facing view of a Liar's Dice table for one seat.
//
// buildAIView()      what the seat may know, plus a numbered option list
// DECISION_SCHEMA    strict JSON schema for the model's answer
// buildInstructions  the rules and output contract as prompt text
// parseDecision()    maps an answer to an engine action, or returns a precise error
//                    the caller can feed back to the model for an automatic retry

import { calzaAllowed, countMatching, FACES, legalBidRanges, totalDice } from "./engine.js";

export const TABLE_TALK_MAX = 140;
export const EXPLANATION_MAX = 420;

export const DECISION_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    option: { type: "integer", description: "Number of the chosen option from the numbered list." },
    quantity: {
      anyOf: [{ type: "integer" }, { type: "null" }],
      description: "For a bid option: how many dice you claim. null for Liar or Calza.",
    },
    face: {
      anyOf: [{ type: "integer" }, { type: "null" }],
      description: "For a bid option: the face of that option (1-6). null for Liar or Calza.",
    },
    tableTalk: {
      anyOf: [{ type: "string", maxLength: TABLE_TALK_MAX }, { type: "null" }],
      description: "Optional line said aloud to the table, in character, at most 140 characters. null to stay quiet.",
    },
    explanation: { type: "string", minLength: 1, maxLength: EXPLANATION_MAX },
  },
  required: ["option", "quantity", "face", "tableTalk", "explanation"],
  additionalProperties: false,
});

function faceName(face, quantity = 2) {
  return quantity === 1 ? `${face}` : `${face}s`;
}

function bidLabel({ quantity, face }) {
  return `${quantity} × ${faceName(face, quantity)}`;
}

function seatName(seatNames, seat) {
  return seatNames?.[seat] ?? `Seat ${seat}`;
}

/**
 * Numbered options for `seat`: Liar, Calza, then one bid range per face.
 * Returns [] when it is not this seat's turn.
 */
export function numberedOptions(state, seat) {
  if (state.phase !== "bidding" || state.currentSeat !== seat) return [];
  const options = [];
  if (state.currentBid) {
    options.push({ option: options.length + 1, type: "dudo", label: `Call Liar (dudo) on ${bidLabel(state.currentBid)}` });
    if (calzaAllowed(state)) {
      options.push({ option: options.length + 1, type: "calza", label: `Call Calza: ${bidLabel(state.currentBid)} is exactly right` });
    }
  }
  for (const range of legalBidRanges(state, seat)) {
    const span = range.minQuantity === range.maxQuantity
      ? `exactly ${range.minQuantity}`
      : `quantity ${range.minQuantity} to ${range.maxQuantity}`;
    options.push({
      option: options.length + 1,
      type: "bid",
      face: range.face,
      minQuantity: range.minQuantity,
      maxQuantity: range.maxQuantity,
      label: `Bid on ${faceName(range.face)}: ${span}`,
    });
  }
  return options;
}

/**
 * Snapshot for the model playing `seat`: its own dice, public dice counts, this
 * round's bids, the previous reveal, odds hints, and the numbered options.
 * Other seats' dice and the RNG state are never included.
 * @param {object} [context]
 * @param {string[]} [context.seatNames] Display names by seat.
 * @param {object} [context.character] { name, title, personality } of the acting character.
 */
export function buildAIView(state, seat, { seatNames = [], character = null } = {}) {
  const me = state.seats[seat];
  if (!me) throw new Error(`Seat ${seat} is not at this table`);
  const onesWild = !state.palifico;
  const table = totalDice(state);
  const unknownDice = table - me.dice.length;
  const odds = FACES.map((face) => {
    const mine = countMatching(me.dice, face, { onesWild });
    // Each unknown die matches with chance 1/6, or 2/6 when ones are wild and the face is not 1.
    const perDie = onesWild && face !== 1 ? 2 / 6 : 1 / 6;
    return { face, yourMatching: mine, expectedTotal: Math.round((mine + unknownDice * perDie) * 10) / 10 };
  });
  const reveal = state.lastReveal;
  return {
    game: "Liar's Dice",
    you: {
      seat,
      name: seatName(seatNames, seat),
      title: character?.title ?? null,
      personality: character?.personality ?? null,
      dice: [...me.dice],
      diceCount: me.dice.length,
    },
    round: state.round,
    yourTurn: state.phase === "bidding" && state.currentSeat === seat,
    palifico: state.palifico,
    palificoSeat: state.palificoSeat,
    onesWild,
    totalDiceOnTable: table,
    unknownDice,
    players: state.seats.map((entry) => ({
      seat: entry.seat,
      name: seatName(seatNames, entry.seat),
      diceCount: entry.dice.length,
      out: entry.dice.length === 0,
      isYou: entry.seat === seat,
    })),
    currentBid: state.currentBid
      ? { ...state.currentBid, bidder: seatName(seatNames, state.currentBid.seat), label: bidLabel(state.currentBid) }
      : null,
    bidsThisRound: state.bids.map((bid) => ({ seat: bid.seat, bidder: seatName(seatNames, bid.seat), label: bidLabel(bid) })),
    previousReveal: reveal
      ? {
          round: reveal.round,
          type: reveal.type,
          caller: seatName(seatNames, reveal.callerSeat),
          bid: bidLabel(reveal.bid),
          bidder: seatName(seatNames, reveal.bid.seat),
          actualCount: reveal.count,
          outcome: reveal.outcome,
          loser: reveal.loserSeat === null ? null : seatName(seatNames, reveal.loserSeat),
          gainer: reveal.gainerSeat === null ? null : seatName(seatNames, reveal.gainerSeat),
          dice: reveal.dice.map((dice, index) => ({ name: seatName(seatNames, index), dice })),
        }
      : null,
    odds,
    options: numberedOptions(state, seat),
  };
}

export function buildInstructions(view, retry = null) {
  const character = view.you.title
    ? `You are ${view.you.name}, ${view.you.title}. Character: ${view.you.personality}`
    : `You are ${view.you.name}.`;
  const roundRule = view.palifico
    ? "THIS IS A PALIFICO ROUND: ones are NOT wild. The opener may bid any face, ones included; every later bid keeps that face and raises the quantity."
    : "Ones are wild: they count toward any bid on faces 2-6, but not toward a bid on ones.";
  const options = view.options.map((entry) => `${entry.option}. ${entry.label}`).join("\n");
  const retryText = retry
    ? `\n\nAUTOMATIC RETRY ${retry.retryNumber}/${retry.maxRetries}: your previous answer ${JSON.stringify(retry.rejected)} was rejected: ${retry.error}. Fix exactly that problem.`
    : "";
  return `${character}
You are playing Liar's Dice (Perudo rules). Every player hides their own dice. A bid claims that AT LEAST that many dice on the whole table show the face.
${roundRule}
Raising: bid a higher quantity on any face, or the same quantity on a higher face. Switching to ones needs at least half the quantity, rounded up; switching from ones needs at least double plus one. Bids never exceed the dice on the table.
Liar (dudo): everyone reveals. If the bid holds, the caller loses a die; otherwise the bidder loses one. Calza: claim the bid is EXACTLY right; if so you regain a die, otherwise you lose one. The player who loses a die opens the next round. The last player with dice wins.

Your dice: ${view.you.dice.join(" ")}. Dice on the table: ${view.totalDiceOnTable} (${view.unknownDice} hidden from you).
Expected count per face on the whole table (your dice plus the average of the hidden ones): ${view.odds.map((entry) => `${entry.face}s ≈ ${entry.expectedTotal}`).join(", ")}.
Current bid: ${view.currentBid ? `${view.currentBid.label} by ${view.currentBid.bidder}` : "none, you open the round"}.

Your options:
${options}

Answer with "option" set to one number from the list. For a bid option also set "face" to that option's face and "quantity" to a number in its range. For Liar or Calza set quantity and face to null. "tableTalk" is an optional in-character line said aloud (at most ${TABLE_TALK_MAX} characters; bluffing is part of the game; an empty string or null stays quiet). "explanation" is a private one or two sentence rationale.${retryText}`;
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  // Strip control characters, collapse whitespace, cut by code point so emoji are not split.
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, limit).join("");
}

/**
 * Map a model answer (object or JSON string) to an engine action for `seat`.
 * Returns { ok: true, action, tableTalk, explanation } or { ok: false, error: { code, message } }.
 * Error codes: not_your_turn, malformed, unknown_option, bad_fields, quantity_out_of_range, face_mismatch.
 */
export function parseDecision(state, seat, answer) {
  if (state.phase !== "bidding" || state.currentSeat !== seat) {
    return failure("not_your_turn", `It is not seat ${seat}'s turn to act`);
  }
  let decision = answer;
  if (typeof decision === "string") {
    try {
      decision = JSON.parse(decision);
    } catch {
      return failure("malformed", "The answer is not valid JSON");
    }
  }
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return failure("malformed", "The answer must be a JSON object");
  }
  const options = numberedOptions(state, seat);
  const chosen = Number.isInteger(decision.option) ? options.find((entry) => entry.option === decision.option) : null;
  if (!chosen) {
    return failure("unknown_option", `"option" must be one of ${options.map((entry) => entry.option).join(", ")}; got ${JSON.stringify(decision.option)}`);
  }
  const quantity = decision.quantity ?? null;
  const face = decision.face ?? null;
  let action;
  if (chosen.type === "bid") {
    if (!Number.isInteger(face)) {
      return failure("bad_fields", `Option ${chosen.option} is a bid on ${chosen.face}s: set "face" to ${chosen.face}`);
    }
    if (face !== chosen.face) {
      return failure("face_mismatch", `Option ${chosen.option} bids on ${chosen.face}s, but "face" is ${face}. Pick the option for ${face}s, or set face to ${chosen.face}`);
    }
    if (!Number.isInteger(quantity)) {
      return failure("bad_fields", `Option ${chosen.option} needs an integer "quantity" from ${chosen.minQuantity} to ${chosen.maxQuantity}`);
    }
    if (quantity < chosen.minQuantity || quantity > chosen.maxQuantity) {
      return failure("quantity_out_of_range", `A bid on ${chosen.face}s needs a quantity from ${chosen.minQuantity} to ${chosen.maxQuantity}; got ${quantity}`);
    }
    action = { type: "bid", quantity, face };
  } else {
    if (quantity !== null || face !== null) {
      return failure("bad_fields", `Option ${chosen.option} (${chosen.type === "dudo" ? "Liar" : "Calza"}) takes no bid: set "quantity" and "face" to null`);
    }
    action = { type: chosen.type };
  }
  const tableTalk = cleanText(decision.tableTalk, TABLE_TALK_MAX);
  return {
    ok: true,
    action,
    tableTalk: tableTalk || null,
    explanation: cleanText(decision.explanation, EXPLANATION_MAX),
  };
}
