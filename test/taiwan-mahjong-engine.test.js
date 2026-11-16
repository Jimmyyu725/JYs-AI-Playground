import test from "node:test";
import assert from "node:assert/strict";
import {
  FLOWER_CODES,
  TILE_KINDS,
  applyAction,
  arrangeWall,
  createFullWall,
  createSeededRng,
  createTaiwanMahjongGame,
  findDecompositions,
  findWaits,
  getLegalActions,
  getPublicState,
  getSeatsToAct,
  isLegalAction,
  isWinningHand,
  scoreHand,
  shuffleTiles,
  startNextHand,
} from "../src/games/taiwan-mahjong/engine.js";

const t = (text) => text.trim().split(/\s+/);

// Filler hands: single copies spaced three apart plus one of each honor, so a filler
// seat can never chow, pung, kong, or win on anything.
const FA = t("1m 4m 7m 1p 4p 7p 1s 4s 7s EW SW WW NW RD GD WD");
const FB = t("2m 5m 8m 2p 5p 8p 2s 5s 8s EW SW WW NW RD GD WD");
const FC = t("3m 6m 9m 3p 6p 9p 3s 6s 9s EW SW WW NW RD GD WD");

function scripted({ hands, front = [], back = [], dealer = 0, ...options }) {
  const wall = arrangeWall({ dealer, hands, front, back }, createSeededRng(99));
  return createTaiwanMahjongGame({ wall, dealer, seed: 1, ...options });
}

function act(state, seat, action) {
  return applyAction(state, seat, action);
}

function types(actions) {
  return actions.map((action) => action.type);
}

function totalTiles(state) {
  return state.wall.length + state.players.reduce(
    (sum, player) => sum + player.hand.length + player.flowers.length + player.discards.length
      + player.melds.reduce((meldSum, meld) => meldSum + meld.tiles.length, 0),
    0,
  );
}

function sumOf(values) {
  return values.reduce((sum, value) => sum + value, 0);
}

// ---------------------------------------------------------------------------
// Tiles and wall

test("the full wall has 144 tiles: four of each of 34 kinds plus 8 flowers", () => {
  const wall = createFullWall();
  assert.equal(wall.length, 144);
  assert.equal(TILE_KINDS.length, 34);
  for (const code of TILE_KINDS) assert.equal(wall.filter((tile) => tile === code).length, 4, code);
  for (const code of FLOWER_CODES) assert.equal(wall.filter((tile) => tile === code).length, 1, code);
});

test("shuffling is deterministic for a seeded RNG and keeps every tile", () => {
  const first = shuffleTiles(createFullWall(), createSeededRng(42));
  const second = shuffleTiles(createFullWall(), createSeededRng(42));
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, createFullWall());
  assert.deepEqual([...first].sort(), [...createFullWall()].sort());
});

test("the same seed deals the same game, and an injected rng is honored", () => {
  const left = createTaiwanMahjongGame({ seed: 123 });
  const right = createTaiwanMahjongGame({ seed: 123 });
  assert.deepEqual(left, right);
  const other = createTaiwanMahjongGame({ seed: 124 });
  assert.notDeepEqual(left.players, other.players);
  const injectedA = createTaiwanMahjongGame({ rng: createSeededRng(5) });
  const injectedB = createTaiwanMahjongGame({ rng: createSeededRng(5) });
  assert.deepEqual(injectedA.players, injectedB.players);
});

test("rejects a malformed wall and bad options", () => {
  assert.throws(() => createTaiwanMahjongGame({ wall: createFullWall().slice(1) }), /144/);
  const wrong = createFullWall();
  wrong[0] = "1m";
  wrong[wrong.indexOf("F1")] = "2m";
  assert.throws(() => createTaiwanMahjongGame({ wall: wrong }), /four|one/);
  assert.throws(() => createTaiwanMahjongGame({ rounds: 5 }), /rounds/);
  assert.throws(() => createTaiwanMahjongGame({ dealer: 4 }), /dealer/);
});

// ---------------------------------------------------------------------------
// Deal and flowers

test("the deal gives the dealer 17 tiles and everyone else 16, dealer to act", () => {
  const state = createTaiwanMahjongGame({ seed: 7, dealer: 2 });
  for (const player of state.players) {
    assert.equal(player.hand.length, player.seat === 2 ? 17 : 16);
    assert.ok(!player.hand.some((tile) => FLOWER_CODES.includes(tile)), "no flowers stay in a hand");
  }
  assert.equal(state.phase, "discard");
  assert.deepEqual(getSeatsToAct(state), [2]);
  assert.equal(totalTiles(state), 144);
  assert.equal(state.wall.length, 144 - 65 - sumOf(state.players.map((player) => player.flowers.length)));
});

test("flowers dealt into a hand are set aside and replaced from the back, chaining", () => {
  const state = scripted({
    hands: [t("F1 1m 1m 2m 2m 3p 3p 5p 5p 9s 9s 3s 3s 6m 6m 8s"), FA, FB, FC],
    front: ["9m"],
    back: ["F2", "5s"],
  });
  assert.deepEqual(state.players[0].flowers, ["F1", "F2"]);
  assert.ok(state.players[0].hand.includes("5s"));
  assert.equal(state.players[0].hand.length, 17);
  assert.equal(state.log.filter((event) => event.type === "flower").length, 2);
});

test("a flower drawn during play is replaced from the back of the wall", () => {
  let state = scripted({
    hands: [t("9m 1m 1m 3m 3m 6m 6m 3p 3p 9s 9s 3s 3s 6s 6s 5s"), FA, FB, FC],
    front: ["8s", "F3"],
    back: ["9s"],
  });
  state = act(state, 0, { type: "discard", tile: "9m" });
  assert.equal(state.turn.seat, 1);
  assert.deepEqual(state.players[1].flowers, ["F3"]);
  assert.equal(state.turn.drawnTile, "9s");
  assert.equal(state.players[1].hand.length, 17);
  assert.equal(totalTiles(state), 144);
});

// ---------------------------------------------------------------------------
// Win checker

test("decomposes a 17-tile hand into five sets and a pair", () => {
  const hand = t("1m 2m 3m 4m 5m 6m 7p 8p 9p 2s 3s 4s EW EW EW 5p 5p");
  assert.equal(isWinningHand(hand), true);
  const [decomposition] = findDecompositions(hand);
  assert.equal(decomposition.pair, "5p");
  assert.equal(decomposition.sets.length, 5);
});

test("rejects near-misses, wrong sizes, and honor 'chows'", () => {
  assert.equal(isWinningHand(t("1m 2m 3m 4m 5m 6m 7p 8p 9p 2s 3s 4s EW EW EW 5p 6p")), false);
  assert.equal(isWinningHand(t("1m 2m 3m 4m 5m 6m 7p 8p 9p 2s 3s 4s EW EW EW 5p")), false);
  assert.equal(isWinningHand(t("EW SW WW 1m 2m 3m 4m 5m 6m 7p 8p 9p 2s 3s 4s 5p 5p")), false);
  assert.equal(isWinningHand(t("8m 9m 1p 1m 2m 3m 4m 5m 6m 7p 8p 9p 2s 3s 4s 5p 5p")), false, "no wrap-around chow");
});

test("accounts for melds: with two melds the concealed part is 11 tiles", () => {
  assert.equal(isWinningHand(t("1m 2m 3m 7p 8p 9p 2s 3s 4s 5p 5p"), 2), true);
  assert.equal(isWinningHand(t("1m 2m 3m 7p 8p 9p 2s 3s 4s 5p 5p"), 0), false);
});

test("finds every decomposition of an ambiguous hand", () => {
  const hand = t("1m 1m 1m 2m 2m 2m 3m 3m 3m 4p 4p 4p 6s 6s 6s 9s 9s");
  const shapes = findDecompositions(hand).map((entry) => entry.sets.map((set) => set.type).sort().join(","));
  assert.ok(shapes.includes("pung,pung,pung,pung,pung"));
  assert.ok(shapes.includes("chow,chow,chow,pung,pung"));
});

test("finds waits of a ready (聽牌) hand", () => {
  assert.deepEqual(findWaits(t("1m 2m 3m 4p 5p 6p 7s 8s 9s EW EW EW RD RD 5m 6m")), ["4m", "7m"]);
  assert.deepEqual(findWaits(t("1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 2s 3s EW EW EW 5p")), ["5p"]);
  assert.deepEqual(findWaits(t("1m 1m 1m 2m 3m 4m 5m 6m 7m 8m 9m 9m 9m 1p 9p 5s")), []);
});

// ---------------------------------------------------------------------------
// Tai calculator

const base = { melds: [], flowers: [], seatWind: 1, roundWind: 0, selfDraw: false };

function fanMap(scored) {
  return Object.fromEntries(scored.fans.map((fan) => [fan.key, fan.tai]));
}

test("all chows (平胡) with a two-sided wait: concealed 1 + all chows 2", () => {
  const scored = scoreHand({ ...base, concealed: t("1m 2m 3m 4m 5m 6m 2p 3p 4p 6p 7p 8p 3s 4s 5s 9s 9s"), winTile: "4m" });
  assert.deepEqual(fanMap(scored), { concealed: 1, allChows: 2 });
  assert.equal(scored.tai, 3);
});

test("all chows needs a two-sided wait, no honors, no flowers, and a discard win", () => {
  const edge = scoreHand({ ...base, concealed: t("1m 2m 3m 5m 6m 7m 2p 3p 4p 6p 7p 8p 3s 4s 5s 9s 9s"), winTile: "3m" });
  assert.equal(fanMap(edge).allChows, undefined, "edge wait 1-2 waiting on 3");
  const middle = scoreHand({ ...base, concealed: t("1m 2m 3m 5m 6m 7m 2p 3p 4p 6p 7p 8p 3s 4s 5s 9s 9s"), winTile: "6m" });
  assert.equal(fanMap(middle).allChows, undefined, "closed wait 5_7");
  const honorPair = scoreHand({ ...base, concealed: t("1m 2m 3m 4m 5m 6m 2p 3p 4p 6p 7p 8p 3s 4s 5s RD RD"), winTile: "4m" });
  assert.equal(fanMap(honorPair).allChows, undefined);
  const flower = scoreHand({ ...base, flowers: ["F1"], concealed: t("1m 2m 3m 4m 5m 6m 2p 3p 4p 6p 7p 8p 3s 4s 5s 9s 9s"), winTile: "4m" });
  assert.equal(fanMap(flower).allChows, undefined);
  const selfDraw = scoreHand({ ...base, selfDraw: true, concealed: t("1m 2m 3m 4m 5m 6m 2p 3p 4p 6p 7p 8p 3s 4s 5s 9s 9s"), winTile: "4m" });
  assert.deepEqual(fanMap(selfDraw), { concealedSelfDraw: 3 });
});

test("all pungs (碰碰胡) is chosen over the chow reading of the same tiles", () => {
  const scored = scoreHand({ ...base, concealed: t("1m 1m 1m 2m 2m 2m 3m 3m 3m 4p 4p 4p 6s 6s 6s 9s 9s"), winTile: "6s" });
  assert.deepEqual(fanMap(scored), { concealed: 1, allPungs: 4 });
});

test("exposed melds: self-drawn 1, no concealed bonus; kongs count as pungs", () => {
  const scored = scoreHand({
    ...base,
    selfDraw: true,
    melds: [{ type: "pung", tiles: t("2p 2p 2p") }, { type: "kong", tiles: t("8s 8s 8s 8s") }],
    concealed: t("5m 5m 5m 7p 7p 7p 3s 3s 3s 9m 9m"),
    winTile: "9m",
  });
  assert.deepEqual(fanMap(scored), { selfDraw: 1, allPungs: 4 });
});

test("a concealed kong keeps the hand concealed (門清)", () => {
  const scored = scoreHand({
    ...base,
    melds: [{ type: "concealedKong", tiles: t("8s 8s 8s 8s") }],
    concealed: t("1m 2m 3m 4m 5m 6m 2p 3p 4p 3s 4s 5s 9s 9s"),
    winTile: "1m",
  });
  assert.equal(fanMap(scored).concealed, 1);
});

test("half flush (混一色) and dragon pungs", () => {
  const scored = scoreHand({
    ...base,
    melds: [{ type: "pung", tiles: t("RD RD RD") }],
    concealed: t("1m 2m 3m 4m 5m 6m 7m 8m 9m 2m 2m 2m EW EW"),
    winTile: "9m",
  });
  assert.deepEqual(fanMap(scored), { halfFlush: 4, dragonPung: 1 });
});

test("full flush (清一色)", () => {
  const scored = scoreHand({ ...base, concealed: t("1m 1m 1m 2m 3m 4m 5m 6m 7m 8m 8m 8m 9m 9m 9m 5m 5m"), winTile: "2m" });
  assert.equal(fanMap(scored).fullFlush, 8);
  assert.equal(fanMap(scored).halfFlush, undefined);
  assert.equal(scored.tai, 9);
});

test("all honors (字一色) beats the flush checks", () => {
  const scored = scoreHand({
    ...base,
    seatWind: 2,
    roundWind: 3,
    concealed: t("EW EW EW SW SW SW RD RD RD GD GD GD WD WD WD NW NW"),
    winTile: "NW",
  });
  assert.equal(fanMap(scored).allHonors, 16);
  assert.equal(fanMap(scored).dragonPung, 3);
  assert.equal(fanMap(scored).allPungs, 4);
});

test("seat wind and round wind pungs stack when they are the same wind", () => {
  const hand = t("EW EW EW 1m 2m 3m 4p 5p 6p 7s 8s 9s 2s 3s 4s 9m 9m");
  assert.deepEqual(fanMap(scoreHand({ ...base, seatWind: 0, roundWind: 0, concealed: hand, winTile: "9m" })), { concealed: 1, seatWind: 1, roundWind: 1 });
  assert.deepEqual(fanMap(scoreHand({ ...base, seatWind: 1, roundWind: 0, concealed: hand, winTile: "9m" })), { concealed: 1, roundWind: 1 });
  assert.deepEqual(fanMap(scoreHand({ ...base, seatWind: 2, roundWind: 1, concealed: hand, winTile: "9m" })), { concealed: 1 });
});

test("seat flowers (正花): flower and season matching the seat wind, 1 tai each", () => {
  const hand = t("1m 2m 3m 4m 5m 6m 2p 3p 4p 6p 7p 8p 3s 4s 5s 9s 9s");
  const south = scoreHand({ ...base, seatWind: 1, flowers: ["F2", "F6", "F1"], concealed: hand, winTile: "1m" });
  assert.equal(fanMap(south).seatFlower, 2);
  const east = scoreHand({ ...base, seatWind: 0, flowers: ["F2", "F6"], concealed: hand, winTile: "1m" });
  assert.equal(fanMap(east).seatFlower, undefined);
});

test("situational tai: robbing a kong, last tile, last discard, kong replacement", () => {
  const hand = t("1m 2m 3m 4m 5m 6m 2p 3p 4p 6p 7p 8p 3s 4s 5s RD RD");
  assert.equal(fanMap(scoreHand({ ...base, robbingKong: true, concealed: hand, winTile: "1m" })).robbingKong, 1);
  assert.equal(fanMap(scoreHand({ ...base, lastTile: true, selfDraw: true, concealed: hand, winTile: "1m" })).lastTileDraw, 1);
  assert.equal(fanMap(scoreHand({ ...base, lastTile: true, concealed: hand, winTile: "1m" })).lastTileDiscard, 1);
  assert.equal(fanMap(scoreHand({ ...base, kongReplacement: true, selfDraw: true, concealed: hand, winTile: "1m" })).kongReplacement, 1);
});

test("scoreHand refuses a non-winning hand", () => {
  assert.throws(() => scoreHand({ ...base, concealed: t("1m 2m 3m 4m 5m 6m 2p 3p 4p 6p 7p 8p 3s 4s 5s RD GD"), winTile: "GD" }), /not a winning hand/);
});

// ---------------------------------------------------------------------------
// Turn flow and claims

const CLAIM_HANDS = [
  t("5m 1p 1p 2p 3p 4p 6p 7p 8p 1s 2s 3s 6s 7s 9m 9m"),
  t("3m 4m 1p 7p 1s 4s 7s EW SW WW NW RD GD WD 9p 9s"),
  t("5m 5m 4m 6m 2p 5p 8p 2s 5s 8s EW SW WW NW RD GD"),
  FC,
];

test("a discard nobody can claim passes the turn to the next seat, who draws", () => {
  let state = scripted({ hands: [t("9m 1m 1m 3m 3m 6m 6m 3p 3p 9s 9s 3s 3s 6s 6s 5s"), FA, FB, FC], front: ["8s", "2p"] });
  state = act(state, 0, { type: "discard", tile: "9m" });
  assert.equal(state.phase, "discard");
  assert.equal(state.turn.seat, 1);
  assert.equal(state.turn.drawnTile, "2p");
  assert.deepEqual(state.players[0].discards, ["9m"]);
  assert.deepEqual(state.lastDiscard, { seat: 0, tile: "9m" });
});

test("only the next seat may chow; others with the same tiles may not", () => {
  let state = scripted({ hands: CLAIM_HANDS, front: ["4s"] });
  state = act(state, 0, { type: "discard", tile: "5m" });
  assert.equal(state.phase, "claim");
  assert.deepEqual(state.pending.eligible, [1, 2]);
  assert.deepEqual(getLegalActions(state, 1), [{ type: "chow", tiles: ["3m", "4m"] }, { type: "pass" }]);
  assert.deepEqual(types(getLegalActions(state, 2)), ["pung", "pass"], "seat 2 holds 4m 6m but is not next");
  assert.deepEqual(getLegalActions(state, 3), []);
  assert.equal(isLegalAction(state, 2, { type: "chow", tiles: ["4m", "6m"] }), false);
});

test("pung beats chow when both are declared on the same discard", () => {
  let state = scripted({ hands: CLAIM_HANDS, front: ["4s"] });
  state = act(state, 0, { type: "discard", tile: "5m" });
  state = act(state, 1, { type: "chow", tiles: ["4m", "3m"] });
  assert.equal(state.phase, "claim", "still waiting on seat 2");
  state = act(state, 2, { type: "pung" });
  assert.equal(state.phase, "discard");
  assert.equal(state.turn.seat, 2);
  assert.equal(state.turn.drew, false);
  assert.deepEqual(state.players[2].melds, [{ type: "pung", tiles: ["5m", "5m", "5m"], calledTile: "5m", from: 0 }]);
  assert.deepEqual(state.players[1].melds, []);
  assert.deepEqual(state.players[0].discards, [], "the claimed tile leaves the river");
  assert.ok(getLegalActions(state, 2).every((action) => action.type === "discard"), "after a call only discards are legal");
  assert.equal(totalTiles(state), 144);
});

test("a chow goes through when the pung is passed, and play continues from the chower", () => {
  let state = scripted({ hands: CLAIM_HANDS, front: ["4s"] });
  state = act(state, 0, { type: "discard", tile: "5m" });
  state = act(state, 2, { type: "pass" });
  state = act(state, 1, { type: "chow", tiles: ["3m", "4m"] });
  assert.deepEqual(state.players[1].melds[0].tiles, ["3m", "4m", "5m"]);
  assert.equal(state.players[1].hand.length, 14);
  assert.equal(state.turn.seat, 1);
  state = act(state, 1, { type: "discard", tile: "9s" });
  assert.equal(state.turn.seat, 2, "turn order resumes after the chower");
});

test("all claimants passing lets the next seat draw", () => {
  let state = scripted({ hands: CLAIM_HANDS, front: ["4s", "8m"] });
  state = act(state, 0, { type: "discard", tile: "5m" });
  state = act(state, 1, { type: "pass" });
  state = act(state, 2, { type: "pass" });
  assert.equal(state.turn.seat, 1);
  assert.equal(state.turn.drawnTile, "8m");
  assert.deepEqual(state.players[0].discards, ["5m"]);
});

test("illegal actions are rejected without changing state", () => {
  const state = scripted({ hands: CLAIM_HANDS, front: ["4s"] });
  const snapshot = JSON.stringify(state);
  assert.throws(() => act(state, 1, { type: "discard", tile: "3m" }), /Illegal action/);
  assert.throws(() => act(state, 0, { type: "discard", tile: "EW" }), /Illegal action/);
  assert.throws(() => act(state, 0, { type: "win" }), /Illegal action/);
  assert.throws(() => act(state, 0, { type: "pung" }), /Illegal action/);
  assert.throws(() => act(state, 0, null), /Illegal action/);
  assert.equal(JSON.stringify(state), snapshot);
});

// Seat 2 and seat 3 can both win on 5p, seat 1 can pung it.
const MULTI_HANDS = [
  t("5p 1m 2m 3m 5s 6s 7s 8s 8m 8m 9m 6m 6p 6p 7p 2p"),
  t("5p 5p 1s 4s 7s SW WW NW RD GD 4m 7m 1m 9s 6s 8s"),
  t("1m 2m 3m 4m 5m 6m 7m 8m 9m 1s 2s 3s EW EW EW 5p"),
  t("1p 2p 3p 4p 6p 7p 8p 9p 2s 3s 4s WD WD WD 9s 9s"),
];

test("win beats pung, and the nearest seat in turn order wins a double ron", () => {
  let state = scripted({ hands: MULTI_HANDS, front: ["9p"] });
  state = act(state, 0, { type: "discard", tile: "5p" });
  assert.deepEqual(state.pending.eligible, [1, 2, 3]);
  assert.deepEqual(types(getLegalActions(state, 1)), ["pung", "pass"]);
  assert.deepEqual(types(getLegalActions(state, 2)), ["win", "pass"]);
  assert.deepEqual(types(getLegalActions(state, 3)), ["win", "pass"]);
  state = act(state, 1, { type: "pung" });
  state = act(state, 3, { type: "win" });
  state = act(state, 2, { type: "win" });
  assert.equal(state.phase, "handOver");
  const { result } = state;
  assert.equal(result.type, "discardWin");
  assert.equal(result.winner, 2);
  assert.equal(result.from, 0);
  assert.equal(result.winTile, "5p");
  assert.deepEqual(fanMap(result), { concealed: 1, roundWind: 1 });
  assert.deepEqual(result.dealerFans.map((fan) => fan.key), ["dealer"]);
  assert.deepEqual(result.payments, [{ payer: 0, tai: 3, dealerTai: 1, amount: 600 }]);
  assert.deepEqual(state.scores, [-600, 0, 600, 0]);
  assert.equal(state.players[2].hand.length, 17);
  assert.deepEqual(result.next, { dealer: 1, dealerStreak: 0, roundWind: 0 });
  assert.equal(totalTiles(state), 144);
});

test("when the nearer winner passes, the farther winner takes the tile", () => {
  let state = scripted({ hands: MULTI_HANDS, front: ["9p"] });
  state = act(state, 0, { type: "discard", tile: "5p" });
  state = act(state, 1, { type: "pung" });
  state = act(state, 2, { type: "pass" });
  state = act(state, 3, { type: "win" });
  assert.equal(state.result.winner, 3);
  assert.deepEqual(fanMap(state.result), { concealed: 1, dragonPung: 1 });
  assert.equal(state.result.payments[0].amount, 300 + 100 * 3);
});

test("when every winner passes, the pung goes through", () => {
  let state = scripted({ hands: MULTI_HANDS, front: ["9p"] });
  state = act(state, 0, { type: "discard", tile: "5p" });
  state = act(state, 2, { type: "pass" });
  state = act(state, 3, { type: "pass" });
  assert.equal(state.phase, "claim");
  state = act(state, 1, { type: "pung" });
  assert.equal(state.turn.seat, 1);
  assert.equal(state.players[1].melds[0].type, "pung");
});

// ---------------------------------------------------------------------------
// Self-draw, dealer, rounds

// Seat 1 is ready on 9p / 1s; the dealer's 9m is unclaimable.
const SELF_DRAW_HANDS = [
  t("9m 1m 1m 1p 1p 4m 4m 7m 7m 4p 4p 7p 7p 4s 7s 7s"),
  t("2m 3m 4m 5p 6p 7p 3s 4s 5s 6s 7s 8s 9p 9p 1s 1s"),
  FB,
  FC,
];

test("self-drawn win: all three pay, the dealer adds dealer tai", () => {
  let state = scripted({ hands: SELF_DRAW_HANDS, front: ["2p", "1s"] });
  state = act(state, 0, { type: "discard", tile: "9m" });
  assert.equal(state.turn.seat, 1);
  assert.equal(getLegalActions(state, 1)[0].type, "win");
  state = act(state, 1, { type: "win" });
  const { result } = state;
  assert.equal(result.type, "selfDraw");
  assert.equal(result.winner, 1);
  assert.equal(result.from, null);
  assert.deepEqual(fanMap(result), { concealedSelfDraw: 3 });
  assert.deepEqual(result.payments.map((payment) => [payment.payer, payment.amount]), [[2, 600], [3, 600], [0, 700]]);
  assert.deepEqual(state.scores, [-700, 1900, -600, -600]);
  assert.equal(sumOf(state.scores), 0);
  assert.deepEqual(result.next, { dealer: 1, dealerStreak: 0, roundWind: 0 });
  assert.equal(state.phase, "handOver");
  assert.throws(() => act(state, 2, { type: "pass" }), /over/);
});

test("the dealer may decline a self-draw win and discard instead", () => {
  let state = scripted({ hands: SELF_DRAW_HANDS, front: ["2p", "1s"] });
  state = act(state, 0, { type: "discard", tile: "9m" });
  state = act(state, 1, { type: "discard", tile: "1s" });
  assert.equal(state.phase, "discard");
  assert.equal(state.turn.seat, 2);
});

test("海底撈月: self-draw on the last live tile", () => {
  // After the deal 79 tiles remain; keeping 78 back leaves exactly one live tile.
  let state = scripted({ hands: SELF_DRAW_HANDS, front: ["2p", "1s"], deadWallSize: 78 });
  state = act(state, 0, { type: "discard", tile: "9m" });
  assert.equal(state.turn.lastTile, true);
  state = act(state, 1, { type: "win" });
  assert.equal(fanMap(state.result).lastTileDraw, 1);
});

test("河底撈魚: winning on the final discard; exhaustive draw keeps the dealer", () => {
  const hands = [t("1s 1m 1m 1p 1p 4m 4m 7m 7m 4p 4p 7p 7p 4s 7s 9m"), SELF_DRAW_HANDS[1], FB, FC];
  let state = scripted({ hands, front: ["2p"], deadWallSize: 79 });
  assert.equal(getPublicState(state).wallRemaining, 0);
  state = act(state, 0, { type: "discard", tile: "1s" });
  assert.equal(state.pending.lastDiscard, true);
  state = act(state, 1, { type: "win" });
  assert.equal(fanMap(state.result).lastTileDiscard, 1);

  let drawn = scripted({ hands, front: ["2p"], deadWallSize: 79 });
  drawn = act(drawn, 0, { type: "discard", tile: "9m" });
  assert.equal(drawn.phase, "handOver");
  assert.equal(drawn.result.type, "exhaustiveDraw");
  assert.deepEqual(drawn.scores, [0, 0, 0, 0]);
  assert.deepEqual(drawn.result.next, { dealer: 0, dealerStreak: 1, roundWind: 0 });
  const next = startNextHand(drawn);
  assert.equal(next.dealer, 0);
  assert.equal(next.dealerStreak, 1);
  assert.equal(next.handNumber, 2);
});

const DEALER_WIN_HANDS = [t("1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5s 5s 5s 9s"), FA, FB, FC];

test("dealer continuation (連莊) adds 2 tai per streak on dealer payments", () => {
  let state = scripted({ hands: DEALER_WIN_HANDS, front: ["9s"] });
  assert.deepEqual(types(getLegalActions(state, 0)).slice(0, 1), ["win"], "a dealt winning hand may win at once");
  state = act(state, 0, { type: "win" });
  assert.deepEqual(state.result.payments.map((payment) => payment.amount), [700, 700, 700]);
  assert.deepEqual(state.result.next, { dealer: 0, dealerStreak: 1, roundWind: 0 });
  const wall = arrangeWall({ dealer: 0, hands: DEALER_WIN_HANDS, front: ["9s"] }, createSeededRng(3));
  state = startNextHand(state, { wall });
  assert.equal(state.dealerStreak, 1);
  state = act(state, 0, { type: "win" });
  assert.deepEqual(state.result.payments.map((payment) => payment.dealerTai), [3, 3, 3]);
  assert.deepEqual(state.result.payments.map((payment) => payment.amount), [900, 900, 900]);
  assert.deepEqual(state.result.dealerFans.map((fan) => [fan.key, fan.tai]), [["dealer", 1], ["dealerStreak", 2]]);
  assert.deepEqual(state.scores, [4800, -1600, -1600, -1600]);
  assert.deepEqual(state.history.map((entry) => entry.dealerStreak), [0, 1]);
});

test("the dealer passes on after a non-dealer win, and the round wind advances back at the first dealer", () => {
  let state = scripted({ hands: SELF_DRAW_HANDS, front: ["2p", "1s"], rounds: 2 });
  state = act(state, 0, { type: "discard", tile: "9m" });
  // Pretend this is already the North dealer's hand of the East round.
  state.dealer = 3;
  state.firstDealer = 0;
  state = act(state, 1, { type: "win" });
  assert.deepEqual(state.result.next, { dealer: 0, dealerStreak: 0, roundWind: 1 });
  assert.equal(state.phase, "handOver");
  state = startNextHand(state);
  assert.equal(state.roundWind, 1);
  assert.equal(getPublicState(state).roundWind, "SW");
  assert.equal(state.players[0].hand.length, 17);
});

test("the game ends after the configured rounds, or at maxHands", () => {
  let state = scripted({ hands: SELF_DRAW_HANDS, front: ["2p", "1s"], rounds: 1 });
  state = act(state, 0, { type: "discard", tile: "9m" });
  state.dealer = 3;
  state = act(state, 1, { type: "win" });
  assert.equal(state.phase, "gameOver");
  assert.throws(() => startNextHand(state), /not over/);

  let capped = scripted({ hands: DEALER_WIN_HANDS, front: ["9s"], maxHands: 1 });
  capped = act(capped, 0, { type: "win" });
  assert.equal(capped.phase, "gameOver");
});

test("seat winds rotate with the dealer", () => {
  const state = createTaiwanMahjongGame({ seed: 3, dealer: 2 });
  assert.deepEqual(getPublicState(state).players.map((player) => player.seatWind), ["WW", "NW", "EW", "SW"]);
});

// ---------------------------------------------------------------------------
// Kongs

// Seat 2 holds three 6s and is ready on 2s; the dealer discards the fourth 6s.
const KONG_HANDS = [
  t("6s 9m 9m 3p 3p 6p 6p 9s 9s 3s 3s 6m 6m 8s 8s 5m"),
  FA,
  t("6s 6s 6s 1m 2m 3m 4p 5p 6p 7p 8p 9p 1s 1s 1s 2s"),
  FB,
];

test("exposed kong draws a replacement from the back; winning on it is 槓上開花", () => {
  let state = scripted({ hands: KONG_HANDS, front: ["5s"], back: ["2s"] });
  state = act(state, 0, { type: "discard", tile: "6s" });
  assert.deepEqual(types(getLegalActions(state, 2)), ["kong", "pung", "pass"]);
  const wallBefore = state.wall.length;
  state = act(state, 2, { type: "kong" });
  assert.equal(state.wall.length, wallBefore - 1);
  assert.equal(state.turn.seat, 2);
  assert.equal(state.turn.drawnTile, "2s");
  assert.equal(state.turn.kongReplacement, true);
  assert.deepEqual(state.players[2].melds[0], { type: "kong", tiles: ["6s", "6s", "6s", "6s"], calledTile: "6s", from: 0 });
  state = act(state, 2, { type: "win" });
  assert.equal(state.result.type, "selfDraw");
  assert.deepEqual(fanMap(state.result), { selfDraw: 1, kongReplacement: 1 });
  assert.deepEqual(state.result.payments.map((payment) => [payment.payer, payment.amount]), [[3, 500], [0, 600], [1, 500]]);
  assert.equal(totalTiles(state), 144);
});

test("no kong may be declared when the live wall cannot give a replacement", () => {
  let state = scripted({ hands: KONG_HANDS, front: ["5s"], back: ["2s"], deadWallSize: 79 });
  state = act(state, 0, { type: "discard", tile: "6s" });
  assert.deepEqual(types(getLegalActions(state, 2)), ["pung", "pass"]);
});

const CONCEALED_KONG_HANDS = [
  t("2m 2m 2m 2m 3p 3p 5p 5p 8s 8s 6m 6m 9p 9p 2s 2s"),
  FA,
  t("9s 5m 8m 2p 5p 8p 2s 5s 8s EW SW WW NW RD GD WD"),
  FC,
];

test("concealed kong: replacement from the back, tiles hidden from the other seats", () => {
  let state = scripted({ hands: CONCEALED_KONG_HANDS, front: ["4p"], back: ["5s"] });
  assert.ok(isLegalAction(state, 0, { type: "concealedKong", tile: "2m" }));
  state = act(state, 0, { type: "concealedKong", tile: "2m" });
  assert.equal(state.turn.seat, 0);
  assert.equal(state.turn.drawnTile, "5s");
  assert.equal(state.turn.kongReplacement, true);
  assert.equal(state.players[0].hand.length, 14);
  assert.deepEqual(getPublicState(state, 1).players[0].melds, [{ type: "concealedKong", tiles: null, calledTile: null, from: null }]);
  assert.deepEqual(getPublicState(state, 0).players[0].melds[0].tiles, ["2m", "2m", "2m", "2m"]);
  assert.equal(state.log.at(-2).tile, undefined, "the log does not leak the concealed kong tile");
});

// Seat 2 pungs 5p, later draws the fourth 5p; seat 3 is waiting on 5p.
const ROB_HANDS = [
  t("5p 1m 1m 3m 3m 6m 6m 9m 9m 3s 3s 6s 6s 9p 5s 5s"),
  FA,
  t("5p 5p 2m 5m 8m 8p 2s 5s 8s EW SW WW NW RD GD 2p"),
  t("1p 2p 3p 4p 6p 7p 8p 9p 2s 3s 4s WD WD WD 9s 9s"),
];
const ROB_FRONT = ["7m", "1s", "7s", "4m", "5p"];

function playToAddedKong() {
  let state = scripted({ hands: ROB_HANDS, front: ROB_FRONT, back: ["9s"] });
  state = act(state, 0, { type: "discard", tile: "5p" });
  assert.deepEqual(state.pending.eligible, [2, 3]);
  state = act(state, 3, { type: "pass" });
  state = act(state, 2, { type: "pung" });
  state = act(state, 2, { type: "discard", tile: "2m" });
  assert.equal(state.turn.seat, 3);
  state = act(state, 3, { type: "discard", tile: "1s" });
  assert.equal(state.turn.seat, 0);
  state = act(state, 0, { type: "discard", tile: "7s" });
  assert.equal(state.turn.seat, 1);
  state = act(state, 1, { type: "discard", tile: "4m" });
  assert.equal(state.turn.seat, 2);
  assert.equal(state.turn.drawnTile, "5p");
  assert.ok(isLegalAction(state, 2, { type: "addedKong", tile: "5p" }));
  return act(state, 2, { type: "addedKong", tile: "5p" });
}

test("robbing a kong (搶槓): the waiting seat wins off the added tile", () => {
  let state = playToAddedKong();
  assert.equal(state.phase, "robKong");
  assert.deepEqual(getSeatsToAct(state), [3]);
  assert.deepEqual(getLegalActions(state, 3), [{ type: "win" }, { type: "pass" }]);
  state = act(state, 3, { type: "win" });
  assert.equal(state.result.type, "robbingKong");
  assert.equal(state.result.from, 2);
  assert.deepEqual(fanMap(state.result), { concealed: 1, dragonPung: 1, robbingKong: 1 });
  assert.deepEqual(state.result.payments, [{ payer: 2, tai: 3, dealerTai: 0, amount: 600 }]);
  assert.equal(state.players[2].melds[0].type, "pung", "a robbed kong stays a pung");
  assert.equal(totalTiles(state), 144);
});

test("an added kong nobody robs completes and draws a replacement", () => {
  let state = playToAddedKong();
  state = act(state, 3, { type: "pass" });
  assert.equal(state.phase, "discard");
  assert.equal(state.turn.seat, 2);
  assert.equal(state.turn.drawnTile, "9s");
  assert.deepEqual(state.players[2].melds[0].tiles, ["5p", "5p", "5p", "5p"]);
  assert.equal(state.players[2].melds[0].type, "addedKong");
  assert.equal(totalTiles(state), 144);
});

// ---------------------------------------------------------------------------
// Views, save/resume, invariants

test("the public view hides other hands and the wall, and reveals all at hand end", () => {
  let state = scripted({ hands: SELF_DRAW_HANDS, front: ["2p", "1s"] });
  const view = getPublicState(state, 1);
  assert.equal(view.players[0].hand, null);
  assert.equal(view.players[1].hand.length, 16);
  assert.equal(view.drawnTile, null);
  assert.equal(view.wall, undefined);
  assert.deepEqual(view.legalActions, []);
  assert.equal(getPublicState(state, 0).legalActions.length, 10, "one discard per distinct tile");
  const spectator = getPublicState(state);
  assert.ok(spectator.players.every((player) => player.hand === null));
  state = act(state, 0, { type: "discard", tile: "9m" });
  state = act(state, 1, { type: "win" });
  assert.ok(getPublicState(state).players.every((player) => Array.isArray(player.hand)));
});

test("a saved game resumes identically from JSON", () => {
  let live = scripted({ hands: ROB_HANDS, front: ROB_FRONT, back: ["9s"] });
  live = act(live, 0, { type: "discard", tile: "5p" });
  const saved = JSON.parse(JSON.stringify(live));
  const steps = [[3, { type: "pass" }], [2, { type: "pung" }], [2, { type: "discard", tile: "2m" }]];
  let resumed = saved;
  for (const [seat, action] of steps) {
    live = act(live, seat, action);
    resumed = act(resumed, seat, action);
  }
  assert.deepEqual(resumed, live);
  assert.equal(saved.seq, 1, "applyAction never mutates its input");
});

test("random play keeps 144 tiles, zero-sum scores, and always reaches game over", () => {
  const rng = createSeededRng(11);
  const outcomes = new Set();
  for (let game = 0; game < 6; game += 1) {
    let state = createTaiwanMahjongGame({ seed: game, rounds: 4, maxHands: 12 });
    let steps = 0;
    while (state.phase !== "gameOver") {
      if (state.phase === "handOver") {
        state = startNextHand(state);
        continue;
      }
      const seat = getSeatsToAct(state)[0];
      const actions = getLegalActions(state, seat);
      assert.ok(actions.length > 0);
      const preferred = actions.find((action) => action.type === "win")
        ?? (rng() < 0.6 ? actions.find((action) => !["pass", "discard"].includes(action.type)) : null);
      state = applyAction(state, seat, preferred ?? actions[Math.floor(rng() * actions.length)]);
      assert.equal(totalTiles(state), 144);
      steps += 1;
      assert.ok(steps < 20000);
    }
    assert.equal(sumOf(state.scores), 0);
    for (const entry of state.history) outcomes.add(entry.type);
  }
  assert.ok(outcomes.has("exhaustiveDraw"));
});
