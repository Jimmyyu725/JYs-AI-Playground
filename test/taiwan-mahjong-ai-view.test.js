import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAction,
  arrangeWall,
  createSeededRng,
  createTaiwanMahjongGame,
  getLegalActions,
} from "../src/games/taiwan-mahjong/engine.js";
import {
  DECISION_SCHEMA,
  TABLE_TALK_MAX,
  TAIWAN_MAHJONG_RETRYABLE_CODES,
  buildDecisionInstructions,
  buildSeatSnapshot,
  listNumberedActions,
  parseSeatDecision,
  tileLabel,
} from "../src/games/taiwan-mahjong/ai-view.js";

const t = (text) => text.trim().split(/\s+/);
const FA = t("1m 4m 7m 1p 4p 7p 1s 4s 7s EW SW WW NW RD GD WD");
const FB = t("2m 5m 8m 2p 5p 8p 2s 5s 8s EW SW WW NW RD GD WD");
const FC = t("3m 6m 9m 3p 6p 9p 3s 6s 9s EW SW WW NW RD GD WD");

function scripted(hands, front = [], back = []) {
  const wall = arrangeWall({ dealer: 0, hands, front, back }, createSeededRng(99));
  return createTaiwanMahjongGame({ wall, dealer: 0, seed: 1 });
}

const CLAIM_HANDS = [
  t("5m 1p 1p 2p 3p 4p 6p 7p 8p 1s 2s 3s 6s 7s 9m 9m"),
  t("3m 4m 1p 7p 1s 4s 7s EW SW WW NW RD GD WD 9p 9s"),
  t("5m 5m 4m 6m 2p 5p 8p 2s 5s 8s EW SW WW NW RD GD"),
  FC,
];

const PLAYERS = [
  { name: "Vesper Vale" },
  { name: "Rook Mercer" },
  { name: "Selene Park" },
  { name: "Moss Calder" },
];

test("tile labels give English and Chinese names", () => {
  assert.equal(tileLabel("5m"), "5 Characters 五萬");
  assert.equal(tileLabel("9p"), "9 Dots 九筒");
  assert.equal(tileLabel("1s"), "1 Bamboo 一條");
  assert.equal(tileLabel("RD"), "Red dragon 中");
  assert.equal(tileLabel("F5"), "Flower Spring 春");
});

test("the snapshot shows the seat its own hand and only public facts about others", () => {
  const state = scripted([t("2m 2m 2m 2m 3p 3p 5p 5p 8s 8s 6m 6m 9p 9p 2s 2s"), FA, t("9s 5m 8m 2p 5p 8p 2s 5s 8s EW SW WW NW RD GD WD"), FC], ["4p"], ["5s"]);
  const afterKong = applyAction(state, 0, { type: "concealedKong", tile: "2m" });
  const own = buildSeatSnapshot(afterKong, 0, { players: PLAYERS });
  assert.equal(own.you.name, "Vesper Vale");
  assert.equal(own.you.seatWind, "EW");
  assert.equal(own.you.isDealer, true);
  assert.equal(own.you.hand.length, 14);
  assert.equal(own.you.drawnTile, "5s");
  assert.deepEqual(own.you.melds, ["concealedKong 2m 2m 2m 2m"]);

  const other = buildSeatSnapshot(afterKong, 1, { players: PLAYERS });
  assert.equal(other.you.drawnTile, null);
  assert.deepEqual(other.legalActions, []);
  const dealer = other.opponents.find((opponent) => opponent.seat === 0);
  assert.equal(dealer.name, "Vesper Vale");
  assert.equal(dealer.handCount, 14);
  assert.deepEqual(dealer.melds, ["concealed kong (tiles hidden)"]);
  assert.equal("hand" in dealer, false);
  const serialized = JSON.stringify(other);
  assert.equal(serialized.includes("wall\""), false, "the wall order never reaches the model");
  assert.equal(serialized.includes("2m 2m 2m 2m"), false);
  for (const event of other.recentEvents) {
    if (event.type === "draw" || event.type === "concealedKong") assert.equal(event.tile, undefined);
  }
});

test("legal actions are numbered from 1 and discards show the waits they leave", () => {
  const state = scripted([t("1m 2m 3m 4p 5p 6p 7s 8s 9s 2s 2s 2s 5m 6m 9p 9p"), FA, FB, FC], ["RD"]);
  const actions = listNumberedActions(state, 0);
  assert.deepEqual(actions.map((entry) => entry.id), actions.map((_, index) => index + 1));
  assert.deepEqual(actions.map((entry) => entry.action), getLegalActions(state, 0));
  const discardRed = actions.find((entry) => entry.action.type === "discard" && entry.action.tile === "RD");
  assert.deepEqual(discardRed.readyWaits, ["4m", "7m"]);
  assert.match(discardRed.label, /Discard RD \(Red dragon 中\) -> ready \(聽\), waiting on 4m 7m/);
  const discardOne = actions.find((entry) => entry.action.type === "discard" && entry.action.tile === "1m");
  assert.equal(discardOne.readyWaits, undefined);
  const snapshot = buildSeatSnapshot(state, 0);
  assert.deepEqual(snapshot.legalActions, actions.map(({ id, label }) => ({ id, label })));
});

test("a ready 16-tile hand reports its waits in the snapshot", () => {
  let state = scripted([t("9m 1m 1m 1p 1p 4m 4m 7m 7m 4p 4p 7p 7p 4s 7s 7s"), t("2m 3m 4m 5p 6p 7p 3s 4s 5s 6s 7s 8s 9p 9p 1s 1s"), FB, FC], ["2p"]);
  state = applyAction(state, 0, { type: "discard", tile: "9m" });
  const waiting = buildSeatSnapshot(state, 2);
  assert.deepEqual(waiting.you.readyWaits, []);
  const prior = buildSeatSnapshot(scripted([t("9m 1m 1m 1p 1p 4m 4m 7m 7m 4p 4p 7p 7p 4s 7s 7s"), t("2m 3m 4m 5p 6p 7p 3s 4s 5s 6s 7s 8s 9p 9p 1s 1s"), FB, FC], ["2p"]), 1);
  assert.deepEqual(prior.you.readyWaits, ["9p", "1s"]);
});

test("claim-window actions are labeled for the model", () => {
  let state = scripted(CLAIM_HANDS, ["4s"]);
  state = applyAction(state, 0, { type: "discard", tile: "5m" });
  assert.deepEqual(listNumberedActions(state, 1).map((entry) => entry.label), [
    "Chow the discard 5m with 3m 4m (吃)",
    "Pass on 5m",
  ]);
  assert.deepEqual(listNumberedActions(state, 2).map((entry) => entry.label), ["Pung the discard 5m (碰)", "Pass on 5m"]);
  const snapshot = buildSeatSnapshot(state, 2);
  assert.deepEqual(snapshot.table.pending, { kind: "discard", tile: "5m", from: 0 });
  assert.equal(snapshot.phase, "claim");
});

test("the decision schema is strict: actionId plus nullable tableTalk of at most 140 chars", () => {
  assert.equal(DECISION_SCHEMA.additionalProperties, false);
  assert.deepEqual(DECISION_SCHEMA.required, ["actionId", "tableTalk"]);
  assert.equal(DECISION_SCHEMA.properties.actionId.type, "integer");
  assert.deepEqual(DECISION_SCHEMA.properties.tableTalk.anyOf, [{ type: "string", maxLength: 140 }, { type: "null" }]);
  assert.equal(TABLE_TALK_MAX, 140);
});

test("parses a valid decision into the matching legal action", () => {
  let state = scripted(CLAIM_HANDS, ["4s"]);
  state = applyAction(state, 0, { type: "discard", tile: "5m" });
  const parsed = parseSeatDecision(state, 1, { actionId: 1, tableTalk: "  I'll take that,   thank you. " });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.action, { type: "chow", tiles: ["3m", "4m"] });
  assert.equal(parsed.tableTalk, "I'll take that, thank you.");
  const next = applyAction(state, 1, parsed.action);
  assert.equal(next.pending.responses[1].type, "chow");
});

test("accepts a JSON string answer and a numeric-string actionId", () => {
  const state = scripted(CLAIM_HANDS, ["4s"]);
  const parsed = parseSeatDecision(state, 0, JSON.stringify({ actionId: "2", tableTalk: null }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.action, listNumberedActions(state, 0)[1].action);
  assert.equal(parsed.tableTalk, null);
});

test("over-long tableTalk is trimmed to 140 characters, not rejected", () => {
  const state = scripted(CLAIM_HANDS, ["4s"]);
  const parsed = parseSeatDecision(state, 0, { actionId: 1, tableTalk: "x".repeat(200) });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tableTalk.length, 140);
  assert.equal(parseSeatDecision(state, 0, { actionId: 1, tableTalk: "   " }).tableTalk, null);
});

test("returns precise retryable errors for malformed or illegal answers", () => {
  const state = scripted(CLAIM_HANDS, ["4s"]);
  const count = listNumberedActions(state, 0).length;
  const cases = [
    ["{not json", "invalid_decision", /not valid JSON/],
    [[1], "invalid_decision", /JSON object/],
    [null, "invalid_decision", /JSON object/],
    [{ actionId: 1.5, tableTalk: null }, "invalid_decision", new RegExp(`integer from 1 to ${count}`)],
    [{ tableTalk: null }, "invalid_decision", /integer/],
    [{ actionId: 0, tableTalk: null }, "illegal_action", new RegExp(`valid ids are 1-${count}`)],
    [{ actionId: count + 1, tableTalk: null }, "illegal_action", /not in legalActions/],
    [{ actionId: 1, tableTalk: 42 }, "invalid_decision", /tableTalk must be a string or null/],
  ];
  for (const [raw, code, message] of cases) {
    const parsed = parseSeatDecision(state, 0, raw);
    assert.equal(parsed.ok, false, JSON.stringify(raw));
    assert.equal(parsed.code, code, JSON.stringify(raw));
    assert.match(parsed.error, message);
    assert.ok(TAIWAN_MAHJONG_RETRYABLE_CODES.includes(parsed.code));
  }
});

test("rejects answers from a seat with no decision, or for a stale snapshot", () => {
  const state = scripted(CLAIM_HANDS, ["4s"]);
  const notTurn = parseSeatDecision(state, 2, { actionId: 1, tableTalk: null });
  assert.equal(notTurn.ok, false);
  assert.equal(notTurn.code, "not_your_turn");
  const snapshot = buildSeatSnapshot(state, 0);
  const moved = applyAction(state, 0, { type: "discard", tile: "9m" });
  const stale = parseSeatDecision(moved, 0, { actionId: 1, tableTalk: null }, { expectedSeq: snapshot.seq });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale_decision");
  assert.equal(TAIWAN_MAHJONG_RETRYABLE_CODES.includes(stale.code), false);
  assert.equal(parseSeatDecision(state, 0, { actionId: 1, tableTalk: null }, { expectedSeq: snapshot.seq }).ok, true);
});

test("instructions carry the persona, rules, and the retry reason", () => {
  const state = scripted(CLAIM_HANDS, ["4s"]);
  const snapshot = buildSeatSnapshot(state, 0, { players: PLAYERS });
  const plain = buildDecisionInstructions(snapshot);
  assert.match(plain, /seat 0 \(EW\)/);
  assert.match(plain, /Claim priority: win > pung\/kong > chow/);
  assert.doesNotMatch(plain, /AUTOMATIC RETRY/);
  const retry = buildDecisionInstructions(snapshot, {
    character: { name: "Vesper Vale", title: "The Velvet Knife", personality: "Patient." },
    retry: { retryNumber: 1, maxRetries: 2, rejectedDecision: { actionId: 99 }, error: "actionId 99 is not in legalActions" },
  });
  assert.match(retry, /^You are Vesper Vale, The Velvet Knife/);
  assert.match(retry, /AUTOMATIC RETRY 1\/2: .*actionId 99 is not in legalActions/);
});
