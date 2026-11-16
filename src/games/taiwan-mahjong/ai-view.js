// Model-facing view of a Taiwan Mahjong table for one seat: what that seat may know, a
// numbered list of its legal actions, the structured-output schema, and a parser that
// maps the model's answer back to a legal engine action (or a precise retryable error).

import {
  FLOWER_CODES,
  SEAT_COUNT,
  actionKey,
  findWaits,
  getLegalActions,
  getPublicState,
  getSeatsToAct,
  sortTiles,
} from "./engine.js";
import { TABLE_TALK_MAX_LENGTH, cleanTableTalk, tableTalkInstruction, withTableTalk } from "../../platform/table-talk.js";

export const TABLE_TALK_MAX = TABLE_TALK_MAX_LENGTH;
export const TAIWAN_MAHJONG_RETRYABLE_CODES = Object.freeze(["invalid_decision", "illegal_action"]);

const SUIT_NAMES = { m: ["萬", "Characters"], p: ["筒", "Dots"], s: ["條", "Bamboo"] };
const CHINESE_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const HONOR_NAMES = {
  EW: "East wind 東",
  SW: "South wind 南",
  WW: "West wind 西",
  NW: "North wind 北",
  RD: "Red dragon 中",
  GD: "Green dragon 發",
  WD: "White dragon 白",
};
const FLOWER_NAMES = ["Plum 梅", "Orchid 蘭", "Chrysanthemum 菊", "Bamboo 竹", "Spring 春", "Summer 夏", "Autumn 秋", "Winter 冬"];

export function tileLabel(code) {
  if (HONOR_NAMES[code]) return HONOR_NAMES[code];
  const flowerIndex = FLOWER_CODES.indexOf(code);
  if (flowerIndex !== -1) return `Flower ${FLOWER_NAMES[flowerIndex]}`;
  const [chinese, english] = SUIT_NAMES[code[1]];
  return `${code[0]} ${english} ${CHINESE_DIGITS[Number(code[0])]}${chinese}`;
}

// Strict structured-output schema; tableTalk is the house's shared optional line (an empty
// string means silence).
export const DECISION_SCHEMA = Object.freeze(withTableTalk({
  type: "object",
  properties: {
    actionId: { type: "integer", description: "The id of exactly one action from legalActions." },
  },
  required: ["actionId"],
  additionalProperties: false,
}));

function describeAction(state, seat, action) {
  const pending = state.pending;
  switch (action.type) {
    case "discard":
      return `Discard ${action.tile} (${tileLabel(action.tile)})`;
    case "concealedKong":
      return `Declare a concealed kong of ${action.tile} (${tileLabel(action.tile)}) and draw a replacement`;
    case "addedKong":
      return `Add ${action.tile} to your exposed pung to make a kong and draw a replacement`;
    case "win":
      if (state.phase === "discard") return "Declare a self-drawn win (自摸)";
      if (state.phase === "robKong") return `Win by robbing the kong on ${pending.tile} (搶槓)`;
      return `Win on the discard ${pending.tile} (胡)`;
    case "kong":
      return `Kong the discard ${pending.tile} (槓) and draw a replacement`;
    case "pung":
      return `Pung the discard ${pending.tile} (碰)`;
    case "chow":
      return `Chow the discard ${pending.tile} with ${action.tiles.join(" ")} (吃)`;
    case "pass":
      return state.phase === "robKong" ? "Pass: let the kong stand" : `Pass on ${pending.tile}`;
    default:
      return action.type;
  }
}

// Legal actions numbered from 1. Discards are annotated with the waits they leave.
export function listNumberedActions(state, seat) {
  const player = state.players[seat];
  return getLegalActions(state, seat).map((action, index) => {
    const entry = { id: index + 1, action, label: describeAction(state, seat, action) };
    if (action.type === "discard") {
      const rest = [...player.hand];
      rest.splice(rest.indexOf(action.tile), 1);
      const waits = findWaits(rest, player.melds.length);
      if (waits.length > 0) {
        entry.readyWaits = waits;
        entry.label += ` -> ready (聽), waiting on ${waits.join(" ")}`;
      }
    }
    return entry;
  });
}

function describeMeld(meld) {
  if (!meld.tiles) return "concealed kong (tiles hidden)";
  const from = meld.from === null || meld.from === undefined ? "" : ` from seat ${meld.from}`;
  return `${meld.type} ${meld.tiles.join(" ")}${from}`;
}

// Everything `seat` is allowed to know, plus its numbered legal actions.
export function buildSeatSnapshot(state, seat, { players = [] } = {}) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEAT_COUNT) throw new Error("seat must be 0-3");
  const view = getPublicState(state, seat);
  const nameOf = (other) => players[other]?.name ?? `Seat ${other}`;
  const me = view.players[seat];
  const mePlayer = state.players[seat];
  const waits = mePlayer.hand.length % 3 === 1 ? findWaits(mePlayer.hand, mePlayer.melds.length) : [];
  return {
    game: "Taiwan Mahjong 台灣麻將 (16 tiles)",
    seq: state.seq,
    phase: state.phase,
    handNumber: state.handNumber,
    you: {
      seat,
      name: nameOf(seat),
      seatWind: me.seatWind,
      isDealer: me.isDealer,
      hand: sortTiles(me.hand),
      handLabels: sortTiles(me.hand).map(tileLabel),
      drawnTile: view.drawnTile,
      melds: me.melds.map(describeMeld),
      flowers: me.flowers,
      readyWaits: waits,
      score: view.scores[seat],
    },
    table: {
      roundWind: view.roundWind,
      dealerSeat: view.dealer,
      dealerStreak: view.dealerStreak,
      wallRemaining: view.wallRemaining,
      lastDiscard: view.lastDiscard,
      pending: view.pending,
    },
    opponents: view.players
      .filter((player) => player.seat !== seat)
      .map((player) => ({
        seat: player.seat,
        name: nameOf(player.seat),
        seatWind: player.seatWind,
        isDealer: player.isDealer,
        handCount: player.handCount,
        melds: player.melds.map(describeMeld),
        flowers: player.flowers,
        discards: player.discards,
        score: view.scores[player.seat],
      })),
    yourDiscards: me.discards,
    recentEvents: state.log.slice(-16).map((event) => ({ ...event })),
    legalActions: listNumberedActions(state, seat).map(({ id, label }) => ({ id, label })),
  };
}

export const RULES_SUMMARY = `Taiwan Mahjong, 16-tile hands. A win is 5 sets (chow = 3 in a row of one suit, pung = 3 identical, kong = 4 identical) plus 1 pair, 17 tiles in total (kongs add one each).
Tile codes: 1m-9m characters 萬, 1p-9p dots 筒, 1s-9s bamboo 條, EW SW WW NW winds, RD GD WD dragons 中發白. Flowers are set aside automatically and replaced from the back of the wall.
Chow only from the player directly before you. Claim priority: win > pung/kong > chow; if two players win on one tile, the nearest in turn order wins.
Tai: dealer 1 (+2 per dealer streak), self-drawn 1, concealed 1 (concealed self-draw 3), all chows 2, all pungs 4, half flush 4, full flush 8, dragon pung 1 each, seat/round wind pung 1, seat flower 1 each, robbing a kong 1, last tile 1, kong replacement win 1.
Payment = base + tai x per-tai. A discard win is paid by the discarder, a self-draw by all three others.`;

export function buildDecisionInstructions(snapshot, { character = null, retry = null } = {}) {
  const persona = character
    ? `You are ${character.name}, ${character.title}. Character: ${character.personality}\n`
    : "";
  const retryText = retry
    ? `\nAUTOMATIC RETRY ${retry.retryNumber}/${retry.maxRetries}: your previous answer ${JSON.stringify(retry.rejectedDecision)} was rejected: ${retry.error}. Pick a valid actionId from legalActions.`
    : "";
  return `${persona}You are playing seat ${snapshot.you.seat} (${snapshot.you.seatWind}) at a Taiwan Mahjong table.
${RULES_SUMMARY}
Choose exactly one action by its actionId from legalActions in the input. Return only the structured decision.${tableTalkInstruction(character?.voice)}${retryText}`;
}

function failure(code, error, rejectedDecision) {
  return { ok: false, code, error, rejectedDecision: rejectedDecision ?? null };
}

// Maps a model answer (object or JSON string) to a legal action for `seat`.
// Returns { ok: true, actionId, action, tableTalk } or { ok: false, code, error }.
// `expectedSeq` (the snapshot's seq) rejects answers to a table that has moved on.
export function parseSeatDecision(state, seat, raw, { expectedSeq = null } = {}) {
  let decision = raw;
  if (typeof raw === "string") {
    try {
      decision = JSON.parse(raw);
    } catch {
      return failure("invalid_decision", "The answer is not valid JSON", raw);
    }
  }
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return failure("invalid_decision", "The answer must be a JSON object with actionId and tableTalk", raw);
  }
  if (expectedSeq !== null && expectedSeq !== state.seq) {
    return failure("stale_decision", `The table moved on (snapshot seq ${expectedSeq}, table seq ${state.seq})`, decision);
  }
  if (!getSeatsToAct(state).includes(seat)) {
    return failure("not_your_turn", `Seat ${seat} has no decision to make in phase ${state.phase}`, decision);
  }
  let { actionId } = decision;
  if (typeof actionId === "string" && /^\s*\d+\s*$/.test(actionId)) actionId = Number(actionId);
  const actions = listNumberedActions(state, seat);
  if (!Number.isInteger(actionId)) {
    return failure("invalid_decision", `actionId must be an integer from 1 to ${actions.length}`, decision);
  }
  const entry = actions.find((candidate) => candidate.id === actionId);
  if (!entry) {
    return failure("illegal_action", `actionId ${actionId} is not in legalActions (valid ids are 1-${actions.length})`, decision);
  }
  const rawTalk = decision.tableTalk ?? null;
  if (rawTalk !== null && typeof rawTalk !== "string") {
    return failure("invalid_decision", "tableTalk must be a string", decision);
  }
  const tableTalk = cleanTableTalk(rawTalk);
  return { ok: true, actionId, action: structuredClone(entry.action), key: actionKey(entry.action), label: entry.label, tableTalk };
}
