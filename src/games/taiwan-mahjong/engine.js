// Taiwan Mahjong (台灣麻將) rules engine: 16-tile hands, 4 players, 144 tiles with 8 flowers.
//
// The engine is pure: every function takes a plain JSON state and returns a new one, so a
// state can be saved with JSON.stringify and resumed later. Randomness only enters when a
// hand is dealt; pass `rng` (a () => [0, 1) function) to control it, or rely on the stored
// `options.seed`, which derives a deterministic shuffle for every hand number.
//
// Tile codes: "1m".."9m" characters (萬), "1p".."9p" dots (筒), "1s".."9s" bamboo (條),
// "EW" "SW" "WW" "NW" winds, "RD" "GD" "WD" dragons (中 發 白), "F1".."F8" flowers
// (F1-F4 plum/orchid/chrysanthemum/bamboo, F5-F8 spring/summer/autumn/winter).
//
// Seats are 0..3 and play passes from seat s to seat (s + 1) % 4. A seat's wind is its
// distance from the dealer (dealer = East).
//
// Rule choices: 16 tiles are kept back as a dead wall; an exhaustive draw keeps the dealer
// (連莊); only one player wins a discard (nearest in turn order); a seat that passes up a
// win cannot win on another player's tile until its next turn (過水). Not implemented:
// eight-flower instant wins (八仙過海, 七搶一), flower kongs (花槓), heavenly/earthly hands
// and 半求人. Wait shape scores one tai only as 獨聽 (exactly one winning tile kind).
// Big/small dragons and winds replace the single dragon / wind pung tai they contain.

export const SEAT_COUNT = 4;
export const HAND_SIZE = 16;
export const SETS_TO_WIN = 5;
export const WIND_CODES = Object.freeze(["EW", "SW", "WW", "NW"]);
export const DRAGON_CODES = Object.freeze(["RD", "GD", "WD"]);
export const FLOWER_CODES = Object.freeze(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8"]);
export const SUIT_CODES = Object.freeze(["m", "p", "s"]);

export const TILE_KINDS = Object.freeze([
  ...SUIT_CODES.flatMap((suit) => Array.from({ length: 9 }, (_, index) => `${index + 1}${suit}`)),
  ...WIND_CODES,
  ...DRAGON_CODES,
]);
const KIND_INDEX = new Map(TILE_KINDS.map((code, index) => [code, index]));

export const DEFAULT_OPTIONS = Object.freeze({
  rounds: 1, // number of prevailing-wind rounds (1 = East round only, 4 = full game)
  base: 300, // 底: paid on every win
  perTai: 100, // 台: paid per tai
  deadWallSize: 16, // tiles left undrawn at the back of the wall (留牌)
  maxHands: null, // optional hard cap on the number of hands
});

export const TAI_NAMES = Object.freeze({
  dealer: "Dealer 莊家",
  dealerStreak: "Dealer streak 連莊",
  concealedSelfDraw: "Concealed self-draw 門清自摸",
  selfDraw: "Self-drawn 自摸",
  concealed: "Concealed hand 門清",
  allChows: "All chows 平胡",
  allPungs: "All pungs 碰碰胡",
  halfFlush: "Half flush 混一色",
  fullFlush: "Full flush 清一色",
  allHonors: "All honors 字一色",
  dragonPung: "Dragon pung 三元牌",
  seatWind: "Seat wind pung 門風",
  roundWind: "Round wind pung 圈風",
  seatFlower: "Seat flower 正花",
  robbingKong: "Robbing a kong 搶槓",
  lastTileDraw: "Last tile self-draw 海底撈月",
  lastTileDiscard: "Last discard 河底撈魚",
  kongReplacement: "Win on kong replacement 槓上開花",
  singleWait: "Single wait 獨聽",
  threeConcealedPungs: "Three concealed pungs 三暗刻",
  fourConcealedPungs: "Four concealed pungs 四暗刻",
  fiveConcealedPungs: "Five concealed pungs 五暗刻",
  smallDragons: "Small three dragons 小三元",
  bigDragons: "Big three dragons 大三元",
  smallWinds: "Small four winds 小四喜",
  bigWinds: "Big four winds 大四喜",
  allExposed: "All melded 全求人",
});

// ---------------------------------------------------------------------------
// Tiles

export function isTileCode(code) {
  return KIND_INDEX.has(code) || FLOWER_CODES.includes(code);
}

export function isFlower(code) {
  return FLOWER_CODES.includes(code);
}

export function isHonor(code) {
  return WIND_CODES.includes(code) || DRAGON_CODES.includes(code);
}

export function suitOf(code) {
  return KIND_INDEX.has(code) && !isHonor(code) ? code[1] : null;
}

export function kindIndex(code) {
  const index = KIND_INDEX.get(code);
  if (index === undefined) throw new Error(`Unknown tile "${code}"`);
  return index;
}

export function sortTiles(tiles) {
  const order = (code) => (KIND_INDEX.has(code) ? KIND_INDEX.get(code) : 100 + FLOWER_CODES.indexOf(code));
  return [...tiles].sort((left, right) => order(left) - order(right));
}

export function createFullWall() {
  const wall = [];
  for (const code of TILE_KINDS) for (let copy = 0; copy < 4; copy += 1) wall.push(code);
  wall.push(...FLOWER_CODES);
  return wall;
}

export function shuffleTiles(tiles, rng = Math.random) {
  const shuffled = [...tiles];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

// mulberry32: small, fast, deterministic PRNG.
export function createSeededRng(seed) {
  let value = Number(seed) >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function handSeed(seed, handNumber) {
  return (Math.imul(Number(seed) >>> 0, 2654435761) + handNumber * 40503) >>> 0;
}

function countTiles(tiles) {
  const counts = new Array(TILE_KINDS.length).fill(0);
  for (const code of tiles) counts[kindIndex(code)] += 1;
  return counts;
}

function removeTiles(hand, tiles) {
  const next = [...hand];
  for (const code of tiles) {
    const index = next.indexOf(code);
    if (index === -1) throw new Error(`Tile "${code}" is not in the hand`);
    next.splice(index, 1);
  }
  return next;
}

function countOf(hand, code) {
  return hand.filter((tile) => tile === code).length;
}

// Builds a complete 144-tile wall that deals the given hands. Useful for tests and
// scripted demos. `hands` is indexed by seat (each up to 16 tiles; the rest is filled),
// `front` lists the tiles drawn from the front after the deal (the dealer's 17th tile
// first), and `back` lists replacement tiles drawn from the back, in order.
export function arrangeWall({ dealer = 0, hands = [[], [], [], []], front = [], back = [] } = {}, rng = Math.random) {
  const pool = createFullWall();
  const take = (code) => {
    const index = pool.indexOf(code);
    if (index === -1) throw new Error(`arrangeWall: no copy of "${code}" left`);
    pool.splice(index, 1);
    return code;
  };
  const fixedHands = hands.map((hand) => {
    if (hand.length > HAND_SIZE) throw new Error("arrangeWall: a hand has more than 16 tiles");
    return hand.map(take);
  });
  const fixedFront = front.map(take);
  const fixedBack = back.map(take);
  // Unplaced flowers sit just before the scripted back tiles, so the random filler never
  // triggers a flower replacement during a scripted deal.
  const looseFlowers = pool.filter(isFlower);
  const rest = shuffleTiles(pool.filter((tile) => !isFlower(tile)), rng);
  const fill = (count) => rest.splice(0, count);
  const dealt = [];
  for (let offset = 0; offset < SEAT_COUNT; offset += 1) {
    const seat = (dealer + offset) % SEAT_COUNT;
    const hand = fixedHands[seat] ?? [];
    dealt.push(...hand, ...fill(HAND_SIZE - hand.length));
  }
  const tail = [...fixedBack].reverse();
  return [...dealt, ...fixedFront, ...rest, ...looseFlowers, ...tail];
}

// ---------------------------------------------------------------------------
// Hand decomposition

function enumerateSets(counts, start, sets, out) {
  let index = start;
  while (index < counts.length && counts[index] === 0) index += 1;
  if (index === counts.length) {
    out.push(sets.map((set) => ({ ...set })));
    return;
  }
  if (counts[index] >= 3) {
    counts[index] -= 3;
    sets.push({ type: "pung", tile: TILE_KINDS[index] });
    enumerateSets(counts, index, sets, out);
    sets.pop();
    counts[index] += 3;
  }
  if (index < 27 && index % 9 <= 6 && counts[index + 1] > 0 && counts[index + 2] > 0) {
    counts[index] -= 1;
    counts[index + 1] -= 1;
    counts[index + 2] -= 1;
    sets.push({ type: "chow", tile: TILE_KINDS[index] });
    enumerateSets(counts, index, sets, out);
    sets.pop();
    counts[index] += 1;
    counts[index + 1] += 1;
    counts[index + 2] += 1;
  }
}

// Returns every way to split concealed tiles into one pair plus sets. Each result is
// { pair, sets: [{ type: "pung" | "chow", tile }] } where a chow's tile is its lowest tile.
export function findDecompositions(tiles) {
  if (tiles.length % 3 !== 2) return [];
  const counts = countTiles(tiles);
  const results = [];
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] < 2) continue;
    counts[index] -= 2;
    const setLists = [];
    enumerateSets(counts, 0, [], setLists);
    for (const sets of setLists) results.push({ pair: TILE_KINDS[index], sets });
    counts[index] += 2;
  }
  return results;
}

// A hand wins when its concealed tiles plus melds make exactly five sets and a pair.
export function isWinningHand(concealed, meldCount = 0) {
  if (concealed.length !== (SETS_TO_WIN - meldCount) * 3 + 2) return false;
  return findDecompositions(concealed).length > 0;
}

// Tiles that would complete a 3n+1 concealed hand (聽牌 waits).
export function findWaits(concealed, meldCount = 0) {
  if (concealed.length !== (SETS_TO_WIN - meldCount) * 3 + 1) return [];
  const counts = countTiles(concealed);
  return TILE_KINDS.filter((code, index) => counts[index] < 4 && isWinningHand([...concealed, code], meldCount));
}

// ---------------------------------------------------------------------------
// Tai calculation

function isTwoSidedWait(chowLow, winTile) {
  if (suitOf(chowLow) !== suitOf(winTile)) return false;
  const low = Number(chowLow[0]);
  const win = Number(winTile[0]);
  if (win === low) return low <= 6; // waited on low or low+3
  if (win === low + 2) return low >= 2; // waited on low-1 or low+2
  return false;
}

// Scores one decomposition of a winning hand (dealer tai are added per payment).
function scoreDecomposition(decomposition, context) {
  const { melds, winTile, selfDraw, flowers, seatWind, roundWind } = context;
  const meldSets = melds.map((meld) => ({
    type: meld.type === "chow" ? "chow" : "pung",
    tile: meld.type === "chow" ? sortTiles(meld.tiles)[0] : meld.tiles[0],
  }));
  const allSets = [...meldSets, ...decomposition.sets];
  const allTiles = [
    ...melds.flatMap((meld) => meld.tiles),
    ...context.concealed,
  ];
  const exposed = melds.some((meld) => meld.type !== "concealedKong");
  const fans = [];
  const add = (key, tai, count = 1) => {
    if (count > 0) fans.push({ key, name: TAI_NAMES[key], tai: tai * count, count });
  };

  if (selfDraw && !exposed) add("concealedSelfDraw", 3);
  else if (selfDraw) add("selfDraw", 1);
  else if (!exposed) add("concealed", 1);

  const hasHonor = allTiles.some(isHonor);
  if (
    allSets.every((set) => set.type === "chow")
    && !hasHonor
    && flowers.length === 0
    && !selfDraw
    && decomposition.sets.some((set) => set.type === "chow" && isTwoSidedWait(set.tile, winTile))
  ) {
    add("allChows", 2);
  }
  if (allSets.every((set) => set.type === "pung")) add("allPungs", 4);

  const suits = new Set(allTiles.map(suitOf).filter(Boolean));
  if (suits.size === 0) add("allHonors", 16);
  else if (suits.size === 1 && hasHonor) add("halfFlush", 4);
  else if (suits.size === 1) add("fullFlush", 8);

  const pungTiles = allSets.filter((set) => set.type === "pung").map((set) => set.tile);
  const dragonPungs = pungTiles.filter((tile) => DRAGON_CODES.includes(tile)).length;
  const windPungs = pungTiles.filter((tile) => WIND_CODES.includes(tile)).length;
  if (dragonPungs === 3) add("bigDragons", 8);
  else if (dragonPungs === 2 && DRAGON_CODES.includes(decomposition.pair)) add("smallDragons", 4);
  else add("dragonPung", 1, dragonPungs);
  if (windPungs === 4) add("bigWinds", 16);
  else if (windPungs === 3 && WIND_CODES.includes(decomposition.pair)) add("smallWinds", 8);
  else {
    add("seatWind", 1, pungTiles.filter((tile) => tile === WIND_CODES[seatWind]).length);
    add("roundWind", 1, pungTiles.filter((tile) => tile === WIND_CODES[roundWind]).length);
  }

  // 暗刻: pungs formed in the hand (and concealed kongs). A pung completed by another
  // player's discard is exposed, unless this reading puts the winning tile in a chow.
  const winInChow = decomposition.sets.some((set) => set.type === "chow" && suitOf(set.tile) === suitOf(winTile)
    && Number(winTile[0]) >= Number(set.tile[0]) && Number(winTile[0]) <= Number(set.tile[0]) + 2);
  const concealedPungs = melds.filter((meld) => meld.type === "concealedKong").length
    + decomposition.sets.filter((set) => set.type === "pung" && (selfDraw || set.tile !== winTile || winInChow)).length;
  if (concealedPungs >= 5) add("fiveConcealedPungs", 8);
  else if (concealedPungs === 4) add("fourConcealedPungs", 5);
  else if (concealedPungs === 3) add("threeConcealedPungs", 2);

  const allExposed = melds.length === SETS_TO_WIN && melds.every((meld) => meld.type !== "concealedKong") && !selfDraw;
  if (allExposed) add("allExposed", 2);
  else if (context.singleWait) add("singleWait", 1);
  add("seatFlower", 1, flowers.filter((flower) => flower === FLOWER_CODES[seatWind] || flower === FLOWER_CODES[seatWind + 4]).length);

  if (context.robbingKong) add("robbingKong", 1);
  if (context.lastTile && selfDraw) add("lastTileDraw", 1);
  if (context.lastTile && !selfDraw) add("lastTileDiscard", 1);
  if (context.kongReplacement && selfDraw) add("kongReplacement", 1);

  return { fans, tai: fans.reduce((sum, fan) => sum + fan.tai, 0), decomposition };
}

// context: { concealed (incl. winning tile), melds, winTile, selfDraw, flowers, seatWind,
// roundWind, robbingKong, lastTile, kongReplacement }. Returns the best-scoring reading.
export function scoreHand(context) {
  const decompositions = findDecompositions(context.concealed);
  if (decompositions.length === 0 || context.concealed.length !== (SETS_TO_WIN - context.melds.length) * 3 + 2) {
    throw new Error("The hand is not a winning hand");
  }
  // 獨聽: before the winning tile arrived, exactly one tile kind could complete the hand.
  const before = [...context.concealed];
  if (before.includes(context.winTile)) before.splice(before.indexOf(context.winTile), 1);
  const singleWait = before.length < context.concealed.length && findWaits(before, context.melds.length).length === 1;
  let best = null;
  for (const decomposition of decompositions) {
    const scored = scoreDecomposition(decomposition, { ...context, singleWait });
    if (!best || scored.tai > best.tai) best = scored;
  }
  return best;
}

export function dealerTai(streak) {
  return 1 + 2 * streak;
}

// ---------------------------------------------------------------------------
// Game state

export function seatWindOf(state, seat) {
  return (seat - state.dealer + SEAT_COUNT) % SEAT_COUNT;
}

function clone(state) {
  return structuredClone(state);
}

function logEvent(state, event) {
  state.log.push({ seq: state.seq, hand: state.handNumber, ...event });
}

function drawableCount(state) {
  return Math.max(0, state.wall.length - state.options.deadWallSize);
}

// Draws one tile for `seat`, replacing flowers from the back. Returns the kept tile or
// null when the live wall ran out (exhaustive draw).
function drawTile(state, seat, fromBack) {
  const player = state.players[seat];
  let back = fromBack;
  for (;;) {
    if (drawableCount(state) <= 0) return null;
    const tile = back ? state.wall.pop() : state.wall.shift();
    if (isFlower(tile)) {
      player.flowers.push(tile);
      logEvent(state, { type: "flower", seat, tile });
      back = true;
      continue;
    }
    player.hand = sortTiles([...player.hand, tile]);
    return tile;
  }
}

function startTurn(state, seat, { fromBack = false, kongReplacement = false } = {}) {
  state.players[seat].skipWin = false;
  const tile = drawTile(state, seat, fromBack);
  if (tile === null) {
    finishExhaustiveDraw(state);
    return;
  }
  state.phase = "discard";
  state.pending = null;
  state.turn = {
    seat,
    drew: true,
    drawnTile: tile,
    kongReplacement,
    lastTile: drawableCount(state) === 0,
  };
  logEvent(state, { type: "draw", seat, fromBack });
}

function dealHand(state, rng) {
  const wall = shuffleTiles(createFullWall(), rng);
  return dealFromWall(state, wall);
}

function dealFromWall(state, wall) {
  if (wall.length !== 144) throw new Error("A Taiwan Mahjong wall has exactly 144 tiles");
  const counts = new Map();
  for (const tile of wall) counts.set(tile, (counts.get(tile) ?? 0) + 1);
  for (const code of TILE_KINDS) if (counts.get(code) !== 4) throw new Error(`The wall must hold four "${code}"`);
  for (const code of FLOWER_CODES) if (counts.get(code) !== 1) throw new Error(`The wall must hold one "${code}"`);

  state.wall = [...wall];
  state.players = Array.from({ length: SEAT_COUNT }, (_, seat) => ({ seat, hand: [], melds: [], flowers: [], discards: [], skipWin: false }));
  state.log = []; // the event log covers the current hand only; `history` keeps hand summaries
  for (let offset = 0; offset < SEAT_COUNT; offset += 1) {
    const seat = (state.dealer + offset) % SEAT_COUNT;
    state.players[seat].hand = state.wall.splice(0, HAND_SIZE);
  }
  const dealerPlayer = state.players[state.dealer];
  dealerPlayer.hand.push(state.wall.shift());
  // Flower replacement in seat order from the dealer, each seat until it holds none.
  for (let offset = 0; offset < SEAT_COUNT; offset += 1) {
    const seat = (state.dealer + offset) % SEAT_COUNT;
    const player = state.players[seat];
    while (player.hand.some(isFlower)) {
      const flower = player.hand.find(isFlower);
      player.hand.splice(player.hand.indexOf(flower), 1);
      player.flowers.push(flower);
      logEvent(state, { type: "flower", seat, tile: flower });
      player.hand.push(state.wall.pop());
    }
    player.hand = sortTiles(player.hand);
  }
  state.phase = "discard";
  state.pending = null;
  state.result = null;
  state.lastDiscard = null;
  state.turn = { seat: state.dealer, drew: true, drawnTile: null, kongReplacement: false, lastTile: false };
  logEvent(state, { type: "deal", dealer: state.dealer, roundWind: state.roundWind });
  return state;
}

export function createTaiwanMahjongGame(options = {}) {
  const { rng, wall, dealer = 0, seed, ...rest } = options;
  const merged = { ...DEFAULT_OPTIONS, ...rest };
  if (!Number.isInteger(merged.rounds) || merged.rounds < 1 || merged.rounds > 4) throw new Error("rounds must be 1-4");
  if (!Number.isInteger(dealer) || dealer < 0 || dealer >= SEAT_COUNT) throw new Error("dealer must be a seat 0-3");
  const state = {
    game: "taiwan-mahjong",
    schemaVersion: 1,
    seq: 0,
    options: { ...merged, seed: seed ?? Math.floor(Math.random() * 2 ** 32) },
    firstDealer: dealer,
    dealer,
    dealerStreak: 0,
    roundWind: 0,
    handNumber: 1,
    scores: [0, 0, 0, 0],
    phase: "discard",
    wall: [],
    players: [],
    turn: null,
    pending: null,
    lastDiscard: null,
    result: null,
    history: [],
    log: [],
  };
  if (wall) return dealFromWall(state, wall);
  return dealHand(state, rng ?? createSeededRng(handSeed(state.options.seed, state.handNumber)));
}

// Deals the next hand after a "handOver" phase (連莊 and wind rotation were settled when
// the previous hand ended).
export function startNextHand(previous, { rng, wall } = {}) {
  if (previous.phase !== "handOver") throw new Error("The current hand is not over");
  const state = clone(previous);
  state.seq += 1;
  state.handNumber += 1;
  state.dealer = state.result.next.dealer;
  state.dealerStreak = state.result.next.dealerStreak;
  state.roundWind = state.result.next.roundWind;
  if (wall) return dealFromWall(state, wall);
  return dealHand(state, rng ?? createSeededRng(handSeed(state.options.seed, state.handNumber)));
}

function nextHandInfo(state, dealerKeeps) {
  if (dealerKeeps) {
    return { dealer: state.dealer, dealerStreak: state.dealerStreak + 1, roundWind: state.roundWind };
  }
  const dealer = (state.dealer + 1) % SEAT_COUNT;
  const roundWind = dealer === state.firstDealer ? state.roundWind + 1 : state.roundWind;
  return { dealer, dealerStreak: 0, roundWind };
}

function closeHand(state, result, dealerKeeps) {
  const next = nextHandInfo(state, dealerKeeps);
  const capped = state.options.maxHands !== null && state.handNumber >= state.options.maxHands;
  state.result = {
    ...result,
    handNumber: state.handNumber,
    hands: state.players.map((player) => [...player.hand]),
    next,
  };
  state.pending = null;
  state.phase = next.roundWind >= state.options.rounds || capped ? "gameOver" : "handOver";
  state.history.push({
    handNumber: state.handNumber,
    dealer: state.dealer,
    dealerStreak: state.dealerStreak,
    roundWind: state.roundWind,
    type: result.type,
    winner: result.winner ?? null,
    from: result.from ?? null,
    tai: result.tai ?? 0,
    deltas: result.deltas,
  });
  logEvent(state, { type: "handEnd", result: result.type, winner: result.winner ?? null });
}

function finishExhaustiveDraw(state) {
  closeHand(state, { type: "exhaustiveDraw", deltas: [0, 0, 0, 0] }, true);
}

function settleWin(state, { winner, from, winTile, selfDraw, robbingKong = false }) {
  const player = state.players[winner];
  const concealed = selfDraw ? [...player.hand] : sortTiles([...player.hand, winTile]);
  const lastTile = selfDraw ? state.turn.lastTile : Boolean(state.pending?.lastDiscard);
  const scored = scoreHand({
    concealed,
    melds: player.melds,
    winTile,
    selfDraw,
    flowers: player.flowers,
    seatWind: seatWindOf(state, winner),
    roundWind: state.roundWind,
    robbingKong,
    lastTile,
    kongReplacement: selfDraw && state.turn.kongReplacement,
  });
  const payers = selfDraw ? [1, 2, 3].map((offset) => (winner + offset) % SEAT_COUNT) : [from];
  const deltas = [0, 0, 0, 0];
  const payments = payers.map((payer) => {
    const extra = winner === state.dealer || payer === state.dealer ? dealerTai(state.dealerStreak) : 0;
    const tai = scored.tai + extra;
    const amount = state.options.base + state.options.perTai * tai;
    deltas[payer] -= amount;
    deltas[winner] += amount;
    return { payer, tai, dealerTai: extra, amount };
  });
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) state.scores[seat] += deltas[seat];
  if (!selfDraw) player.hand = concealed;
  const dealerFans = [];
  if (winner === state.dealer || payers.includes(state.dealer)) {
    dealerFans.push({ key: "dealer", name: TAI_NAMES.dealer, tai: 1, count: 1 });
    if (state.dealerStreak > 0) {
      dealerFans.push({ key: "dealerStreak", name: TAI_NAMES.dealerStreak, tai: 2 * state.dealerStreak, count: state.dealerStreak });
    }
  }
  closeHand(state, {
    type: selfDraw ? "selfDraw" : robbingKong ? "robbingKong" : "discardWin",
    winner,
    from: selfDraw ? null : from,
    winTile,
    fans: scored.fans,
    dealerFans,
    tai: scored.tai,
    decomposition: scored.decomposition,
    payments,
    deltas,
  }, winner === state.dealer);
}

// ---------------------------------------------------------------------------
// Legal actions
//
// Own turn ("discard" phase):  { type: "discard", tile }, { type: "concealedKong", tile },
//   { type: "addedKong", tile }, { type: "win" }   (win = self-drawn 自摸)
// Claim window ("claim"):      { type: "win" }, { type: "kong" }, { type: "pung" },
//   { type: "chow", tiles: [a, b] }, { type: "pass" }
// Robbing a kong ("robKong"):  { type: "win" }, { type: "pass" }

function uniqueSorted(tiles) {
  return sortTiles([...new Set(tiles)]);
}

function ownTurnActions(state, seat) {
  const player = state.players[seat];
  const actions = [];
  if (state.turn.drew && isWinningHand(player.hand, player.melds.length)) actions.push({ type: "win" });
  if (state.turn.drew && drawableCount(state) > 0) {
    for (const tile of uniqueSorted(player.hand)) {
      if (countOf(player.hand, tile) === 4) actions.push({ type: "concealedKong", tile });
    }
    for (const meld of player.melds) {
      if (meld.type === "pung" && player.hand.includes(meld.tiles[0])) actions.push({ type: "addedKong", tile: meld.tiles[0] });
    }
  }
  for (const tile of uniqueSorted(player.hand)) actions.push({ type: "discard", tile });
  return actions;
}

function claimOptions(state, seat, tile, from) {
  const player = state.players[seat];
  const actions = [];
  if (!player.skipWin && isWinningHand([...player.hand, tile], player.melds.length)) actions.push({ type: "win" });
  const copies = countOf(player.hand, tile);
  if (copies >= 3 && drawableCount(state) > 0) actions.push({ type: "kong" });
  if (copies >= 2) actions.push({ type: "pung" });
  const suit = suitOf(tile);
  if (suit && seat === (from + 1) % SEAT_COUNT) {
    const rank = Number(tile[0]);
    for (const [left, right] of [[rank - 2, rank - 1], [rank - 1, rank + 1], [rank + 1, rank + 2]]) {
      if (left < 1 || right > 9) continue;
      const pair = [`${left}${suit}`, `${right}${suit}`];
      if (player.hand.includes(pair[0]) && player.hand.includes(pair[1])) actions.push({ type: "chow", tiles: pair });
    }
  }
  return actions;
}

function robKongOptions(state, seat, tile) {
  const player = state.players[seat];
  return !player.skipWin && isWinningHand([...player.hand, tile], player.melds.length) ? [{ type: "win" }] : [];
}

export function getLegalActions(state, seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEAT_COUNT) return [];
  if (state.phase === "discard") return state.turn.seat === seat ? ownTurnActions(state, seat) : [];
  if (state.phase === "claim" || state.phase === "robKong") {
    const pending = state.pending;
    if (!pending.eligible.includes(seat) || pending.responses[seat] !== undefined) return [];
    return [...pending.options[seat], { type: "pass" }];
  }
  return [];
}

// Seats whose decision the engine is waiting for right now.
export function getSeatsToAct(state) {
  if (state.phase === "discard") return [state.turn.seat];
  if (state.phase === "claim" || state.phase === "robKong") {
    return state.pending.eligible.filter((seat) => state.pending.responses[seat] === undefined);
  }
  return [];
}

export function actionKey(action) {
  if (!action || typeof action !== "object") return "";
  if (action.type === "chow") return `chow:${Array.isArray(action.tiles) ? sortTiles(action.tiles).join(",") : ""}`;
  if (action.tile !== undefined) return `${action.type}:${action.tile}`;
  return String(action.type);
}

export function isLegalAction(state, seat, action) {
  const key = actionKey(action);
  return getLegalActions(state, seat).some((legal) => actionKey(legal) === key);
}

// ---------------------------------------------------------------------------
// Applying actions

function openClaimWindow(state, from, tile) {
  const options = {};
  const eligible = [];
  for (let offset = 1; offset < SEAT_COUNT; offset += 1) {
    const seat = (from + offset) % SEAT_COUNT;
    const seatOptions = claimOptions(state, seat, tile, from);
    if (seatOptions.length > 0) {
      options[seat] = seatOptions;
      eligible.push(seat);
    }
  }
  const lastDiscard = drawableCount(state) === 0;
  if (eligible.length === 0) {
    state.pending = null;
    startTurn(state, (from + 1) % SEAT_COUNT);
    return;
  }
  state.phase = "claim";
  state.pending = { kind: "discard", tile, from, eligible, options, responses: {}, lastDiscard };
}

// Nearest seat in turn order after `from` among the candidates.
function nearest(from, seats) {
  for (let offset = 1; offset < SEAT_COUNT; offset += 1) {
    const seat = (from + offset) % SEAT_COUNT;
    if (seats.includes(seat)) return seat;
  }
  return null;
}

function resolveClaims(state) {
  const { tile, from, responses } = state.pending;
  const bySeat = (type) => Object.entries(responses).filter(([, action]) => action.type === type).map(([seat]) => Number(seat));

  const winners = bySeat("win");
  if (winners.length > 0) {
    const winner = nearest(from, winners);
    state.players[from].discards.pop();
    logEvent(state, { type: "win", seat: winner, from, tile });
    settleWin(state, { winner, from, winTile: tile, selfDraw: false });
    return;
  }
  const kongSeat = bySeat("kong")[0];
  const pungSeat = bySeat("pung")[0];
  const chowSeat = bySeat("chow")[0];
  const claimant = kongSeat ?? pungSeat ?? chowSeat;
  if (claimant === undefined) {
    state.pending = null;
    startTurn(state, (from + 1) % SEAT_COUNT);
    return;
  }
  const player = state.players[claimant];
  const action = responses[claimant];
  player.skipWin = false;
  state.players[from].discards.pop();
  state.lastDiscard = null;
  if (action.type === "chow") {
    player.hand = removeTiles(player.hand, action.tiles);
    player.melds.push({ type: "chow", tiles: sortTiles([...action.tiles, tile]), calledTile: tile, from });
  } else {
    const fromHand = action.type === "kong" ? 3 : 2;
    player.hand = removeTiles(player.hand, new Array(fromHand).fill(tile));
    player.melds.push({ type: action.type, tiles: new Array(fromHand + 1).fill(tile), calledTile: tile, from });
  }
  logEvent(state, { type: action.type, seat: claimant, from, tile, tiles: action.tiles ?? null });
  state.pending = null;
  if (action.type === "kong") {
    startTurn(state, claimant, { fromBack: true, kongReplacement: true });
  } else {
    state.phase = "discard";
    state.turn = { seat: claimant, drew: false, drawnTile: null, kongReplacement: false, lastTile: false };
  }
}

function completeAddedKong(state) {
  const { tile, from } = state.pending;
  const meld = state.players[from].melds.find((candidate) => candidate.type === "pung" && candidate.tiles[0] === tile);
  meld.type = "addedKong";
  meld.tiles.push(tile);
  state.pending = null;
  startTurn(state, from, { fromBack: true, kongReplacement: true });
}

function applyOwnTurn(state, seat, action) {
  const player = state.players[seat];
  if (action.type === "win") {
    logEvent(state, { type: "win", seat, selfDraw: true });
    settleWin(state, { winner: seat, from: null, winTile: state.turn.drawnTile ?? player.hand[player.hand.length - 1], selfDraw: true });
    return;
  }
  if (action.type === "discard") {
    player.hand = removeTiles(player.hand, [action.tile]);
    player.discards.push(action.tile);
    state.lastDiscard = { seat, tile: action.tile };
    logEvent(state, { type: "discard", seat, tile: action.tile });
    openClaimWindow(state, seat, action.tile);
    return;
  }
  if (action.type === "concealedKong") {
    player.hand = removeTiles(player.hand, new Array(4).fill(action.tile));
    player.melds.push({ type: "concealedKong", tiles: new Array(4).fill(action.tile), calledTile: null, from: null });
    logEvent(state, { type: "concealedKong", seat });
    startTurn(state, seat, { fromBack: true, kongReplacement: true });
    return;
  }
  if (action.type === "addedKong") {
    player.hand = removeTiles(player.hand, [action.tile]);
    logEvent(state, { type: "addedKong", seat, tile: action.tile });
    const options = {};
    const eligible = [];
    for (let offset = 1; offset < SEAT_COUNT; offset += 1) {
      const other = (seat + offset) % SEAT_COUNT;
      const seatOptions = robKongOptions(state, other, action.tile);
      if (seatOptions.length > 0) {
        options[other] = seatOptions;
        eligible.push(other);
      }
    }
    state.phase = "robKong";
    state.pending = { kind: "addedKong", tile: action.tile, from: seat, eligible, options, responses: {}, lastDiscard: false };
    if (eligible.length === 0) completeAddedKong(state);
  }
}

// Claim strength: any win beats pung/kong beats chow; between wins the seat nearer the
// discarder in turn order is stronger.
function claimRank(pending, seat, action) {
  if (action.type === "win") return 300 - ((seat - pending.from + SEAT_COUNT) % SEAT_COUNT);
  if (action.type === "pung" || action.type === "kong") return 200;
  if (action.type === "chow") return 100;
  return 0;
}

// The window closes as soon as no seat still deciding could outrank the best declared
// claim, so a win by the nearest seat does not wait for the others.
function claimDecided(state) {
  const pending = state.pending;
  const undecided = pending.eligible.filter((seat) => pending.responses[seat] === undefined);
  if (undecided.length === 0) return true;
  const best = Math.max(...Object.entries(pending.responses).map(([seat, action]) => claimRank(pending, Number(seat), action)));
  if (best === 0) return false;
  return undecided.every((seat) => pending.options[seat].every((option) => claimRank(pending, seat, option) < best));
}

function applyResponse(state, seat, action) {
  state.pending.responses[seat] = action;
  // 過水: a seat that passes up a win cannot win on another player's tile until its own next turn.
  if (action.type === "pass" && state.pending.options[seat].some((option) => option.type === "win")) {
    state.players[seat].skipWin = true;
  }
  if (!claimDecided(state)) return;
  for (const other of state.pending.eligible) {
    if (state.pending.responses[other] === undefined) state.pending.responses[other] = { type: "pass", skipped: true };
  }
  if (state.phase === "claim") {
    resolveClaims(state);
    return;
  }
  const winners = Object.entries(state.pending.responses).filter(([, response]) => response.type === "win").map(([other]) => Number(other));
  if (winners.length === 0) {
    completeAddedKong(state);
    return;
  }
  const { tile, from } = state.pending;
  const winner = nearest(from, winners);
  logEvent(state, { type: "win", seat: winner, from, tile, robbingKong: true });
  settleWin(state, { winner, from, winTile: tile, selfDraw: false, robbingKong: true });
}

// Applies one seat's action and returns the new state. Throws on an illegal action.
export function applyAction(previous, seat, action) {
  if (previous.phase === "handOver" || previous.phase === "gameOver") throw new Error("The hand is over");
  if (!isLegalAction(previous, seat, action)) {
    throw new Error(`Illegal action ${JSON.stringify(action)} for seat ${seat} in phase ${previous.phase}`);
  }
  const state = clone(previous);
  state.seq += 1;
  const normalized = action.type === "chow" ? { type: "chow", tiles: sortTiles(action.tiles) } : { ...action };
  if (state.phase === "discard") applyOwnTurn(state, seat, normalized);
  else applyResponse(state, seat, normalized);
  return state;
}

// ---------------------------------------------------------------------------
// Views

function publicMeld(meld, reveal) {
  if (meld.type === "concealedKong" && !reveal) return { type: "concealedKong", tiles: null, calledTile: null, from: null };
  return { ...meld, tiles: [...meld.tiles] };
}

// The table as `viewerSeat` may see it (null = spectator). Hands of other seats are only
// revealed once the hand is over.
export function getPublicState(state, viewerSeat = null) {
  const over = state.phase === "handOver" || state.phase === "gameOver";
  return {
    game: state.game,
    seq: state.seq,
    phase: state.phase,
    handNumber: state.handNumber,
    dealer: state.dealer,
    dealerStreak: state.dealerStreak,
    roundWind: WIND_CODES[state.roundWind],
    options: { rounds: state.options.rounds, base: state.options.base, perTai: state.options.perTai },
    wallRemaining: drawableCount(state),
    scores: [...state.scores],
    players: state.players.map((player) => {
      const reveal = over || player.seat === viewerSeat;
      return {
        seat: player.seat,
        seatWind: WIND_CODES[seatWindOf(state, player.seat)],
        isDealer: player.seat === state.dealer,
        handCount: player.hand.length,
        hand: reveal ? [...player.hand] : null,
        melds: player.melds.map((meld) => publicMeld(meld, reveal)),
        flowers: [...player.flowers],
        discards: [...player.discards],
      };
    }),
    turnSeat: state.phase === "discard" ? state.turn.seat : null,
    drawnTile: state.phase === "discard" && state.turn.seat === viewerSeat ? state.turn.drawnTile : null,
    pending: state.pending ? { kind: state.pending.kind, tile: state.pending.tile, from: state.pending.from } : null,
    lastDiscard: state.lastDiscard ? { ...state.lastDiscard } : null,
    seatsToAct: getSeatsToAct(state),
    legalActions: viewerSeat === null ? [] : getLegalActions(state, viewerSeat),
    result: state.result ? structuredClone(state.result) : null,
  };
}
