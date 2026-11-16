// Liar's Dice (大话骰) rules engine, Perudo rules.
//
// The engine is pure: every exported function takes a plain JSON state and returns
// a new one, never mutating its input. The state survives JSON.stringify/parse,
// so a saved game resumes with restoreLiarsDiceState().
//
// Rules implemented:
// - 2-6 seats, each starts with `startingDice` (5) hidden dice, re-rolled every round.
// - Bids name a quantity and a face; the claim is "at least this many dice on the
//   whole table show this face". Ones are wild (count toward any other face),
//   except when the bid itself is on ones, and except in a palifico round.
// - Raising: on a non-one face, raise the quantity (any face) or keep the quantity
//   and raise the face. Switching to ones needs at least half the quantity, rounded
//   up. Switching from ones needs at least double the quantity plus one. Ones after
//   ones need a higher quantity. A round cannot open on ones (unless `openingOnes`).
// - Bids never exceed the number of dice still on the table.
// - Dudo ("Liar"): all dice are revealed. If the bid holds, the caller loses a die;
//   otherwise the bidder does.
// - Calza (optional, `calza` rule): the caller claims the bid is exactly right. If
//   so, the caller regains a die (never above `startingDice`); otherwise the caller
//   loses one. Not allowed when only two players remain.
// - Palifico (optional, `palifico` rule): the first time a player drops to one die
//   while three or more players remain, the next round is palifico: ones are not
//   wild, the opener may bid any face (ones included), and later bids keep that
//   face and raise the quantity only.
// - The player who lost a die opens the next round (the calza caller after a calza);
//   if that player is out, the next live player clockwise opens. The last player
//   with dice wins.

export const GAME_ID = "liars-dice";
export const STATE_VERSION = 1;
export const MIN_SEATS = 2;
export const MAX_SEATS = 6;
export const FACES = Object.freeze([1, 2, 3, 4, 5, 6]);
export const DEFAULT_RULES = Object.freeze({
  startingDice: 5,
  calza: true,
  palifico: true,
  openingOnes: false,
});
const MAX_EVENTS = 200;

export class LiarsDiceError extends Error {
  constructor(message, code = "illegal_action") {
    super(message);
    this.name = "LiarsDiceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Randomness

// Mulberry32: a small seeded PRNG whose whole state is one uint32, so it can be
// stored inside the game state and resumed exactly.
export function mulberry32Next(seed) {
  const next = (seed + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: next };
}

// Returns a random() source for this state. An injected `rng` wins; otherwise a
// seeded game advances its stored rngState; otherwise Math.random is used.
function randomSource(state, rng) {
  if (typeof rng === "function") return rng;
  if (Number.isInteger(state.rngState)) {
    return () => {
      const step = mulberry32Next(state.rngState);
      state.rngState = step.seed;
      return step.value;
    };
  }
  return Math.random;
}

function rollDie(random) {
  const value = Number(random());
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new LiarsDiceError("The random source must return a number in [0, 1)", "bad_rng");
  }
  return 1 + Math.floor(value * 6);
}

// ---------------------------------------------------------------------------
// Small helpers

function clone(value) {
  return structuredClone(value);
}

function normalizeRules(rules = {}) {
  const merged = { ...DEFAULT_RULES, ...(rules ?? {}) };
  const startingDice = Number(merged.startingDice);
  if (!Number.isInteger(startingDice) || startingDice < 1 || startingDice > 10) {
    throw new LiarsDiceError("startingDice must be an integer from 1 to 10", "bad_config");
  }
  return {
    startingDice,
    calza: Boolean(merged.calza),
    palifico: Boolean(merged.palifico),
    openingOnes: Boolean(merged.openingOnes),
  };
}

export function activeSeats(state) {
  return state.seats.filter((seat) => seat.dice.length > 0).map((seat) => seat.seat);
}

export function totalDice(state) {
  return state.seats.reduce((sum, seat) => sum + seat.dice.length, 0);
}

// Next seat clockwise (increasing index, wrapping) that still has dice.
export function nextActiveSeat(state, fromSeat) {
  const count = state.seats.length;
  for (let step = 1; step <= count; step += 1) {
    const seat = (fromSeat + step) % count;
    if (state.seats[seat].dice.length > 0) return seat;
  }
  return null;
}

function pushEvent(state, event) {
  state.events.push({ index: state.eventCount, round: state.round, ...event });
  state.eventCount += 1;
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
}

function emptyStats() {
  return { bids: 0, dudoCalls: 0, dudoWins: 0, calzaCalls: 0, calzaWins: 0, diceLost: 0, diceGained: 0 };
}

// How many dice on the table count toward a bid on `face`.
export function countMatching(dice, face, { onesWild = true } = {}) {
  return dice.filter((die) => die === face || (onesWild && face !== 1 && die === 1)).length;
}

// ---------------------------------------------------------------------------
// Game creation and rounds

/**
 * Create a new game.
 * @param {object} options
 * @param {number} options.seatCount 2-6 seats.
 * @param {object} [options.rules] Overrides for DEFAULT_RULES.
 * @param {number} [options.startingSeat] Seat that opens round 1 (random if omitted).
 * @param {number} [options.seed] uint32 seed: makes every roll reproducible and resumable.
 * @param {() => number} [options.rng] Injected random source in [0, 1); not stored.
 */
export function createLiarsDiceGame({ seatCount, rules, startingSeat, seed, rng } = {}) {
  if (!Number.isInteger(seatCount) || seatCount < MIN_SEATS || seatCount > MAX_SEATS) {
    throw new LiarsDiceError(`Liar's Dice needs ${MIN_SEATS} to ${MAX_SEATS} seats`, "bad_config");
  }
  if (seed !== undefined && seed !== null && !Number.isInteger(seed)) {
    throw new LiarsDiceError("seed must be an integer", "bad_config");
  }
  const state = {
    game: GAME_ID,
    version: STATE_VERSION,
    rules: normalizeRules(rules),
    phase: "bidding",
    round: 0,
    roundStarter: null,
    currentSeat: null,
    palifico: false,
    palificoSeat: null,
    currentBid: null,
    bids: [],
    lastReveal: null,
    seats: [],
    eliminationOrder: [],
    winnerSeat: null,
    result: null,
    rngState: seed === undefined || seed === null ? null : seed >>> 0,
    events: [],
    eventCount: 0,
  };
  for (let seat = 0; seat < seatCount; seat += 1) {
    state.seats.push({ seat, dice: [], palificoUsed: false, stats: emptyStats() });
  }
  const random = randomSource(state, rng);
  let opener = startingSeat;
  if (opener === undefined || opener === null) opener = Math.floor(random() * seatCount);
  if (!Number.isInteger(opener) || opener < 0 || opener >= seatCount) {
    throw new LiarsDiceError("startingSeat is out of range", "bad_config");
  }
  for (const seat of state.seats) seat.dice = new Array(state.rules.startingDice).fill(0);
  pushEvent(state, { type: "game_start", seatCount, rules: { ...state.rules } });
  startRound(state, opener, false, null, random);
  return state;
}

// Mutates `state`: re-rolls every live seat and opens the next round.
function startRound(state, openerSeat, palifico, palificoSeat, random) {
  state.round += 1;
  state.phase = "bidding";
  state.palifico = palifico;
  state.palificoSeat = palifico ? palificoSeat : null;
  state.currentBid = null;
  state.bids = [];
  state.roundStarter = openerSeat;
  state.currentSeat = openerSeat;
  for (const seat of state.seats) {
    seat.dice = seat.dice.map(() => rollDie(random)).sort((left, right) => left - right);
  }
  pushEvent(state, { type: "round_start", starterSeat: openerSeat, palifico, totalDice: totalDice(state) });
}

// ---------------------------------------------------------------------------
// Bid legality

/**
 * The smallest legal quantity for a bid on `face` right now, or null when no bid
 * on that face is legal. Bids are also capped at the dice on the table.
 */
export function minimumQuantityForFace(state, face) {
  if (!FACES.includes(face)) return null;
  const bid = state.currentBid;
  let minimum;
  if (state.palifico) {
    if (!bid) minimum = 1;
    else if (face !== bid.face) return null;
    else minimum = bid.quantity + 1;
  } else if (!bid) {
    if (face === 1 && !state.rules.openingOnes) return null;
    minimum = 1;
  } else if (bid.face === 1) {
    minimum = face === 1 ? bid.quantity + 1 : bid.quantity * 2 + 1;
  } else if (face === 1) {
    minimum = Math.ceil(bid.quantity / 2);
  } else {
    minimum = face > bid.face ? bid.quantity : bid.quantity + 1;
  }
  return minimum <= totalDice(state) ? minimum : null;
}

/** Why a bid is illegal, or null when it is legal. Does not check whose turn it is. */
export function bidError(state, quantity, face) {
  if (!Number.isInteger(face) || !FACES.includes(face)) return "The face must be an integer from 1 to 6";
  if (!Number.isInteger(quantity) || quantity < 1) return "The quantity must be a positive integer";
  const table = totalDice(state);
  if (quantity > table) return `Only ${table} dice are on the table, so a bid cannot exceed ${table}`;
  const bid = state.currentBid;
  const describe = (q, f) => `${q} × ${f}${q === 1 ? "" : "s"}`;
  if (state.palifico) {
    if (bid && face !== bid.face) return `This is a palifico round: every bid must stay on ${bid.face}s`;
    if (bid && quantity <= bid.quantity) return `Palifico: raise the quantity above ${bid.quantity}`;
    return null;
  }
  if (!bid) {
    if (face === 1 && !state.rules.openingOnes) return "A round cannot open with a bid on ones";
    return null;
  }
  const minimum = minimumQuantityForFace(state, face);
  if (minimum !== null && quantity >= minimum) return null;
  const current = describe(bid.quantity, bid.face);
  if (bid.face === 1 && face === 1) return `Bidding ones after ${current} needs at least ${bid.quantity + 1}`;
  if (bid.face === 1) return `Switching from ones (${current}) needs at least ${bid.quantity * 2 + 1} dice`;
  if (face === 1) return `Switching to ones from ${current} needs at least ${Math.ceil(bid.quantity / 2)} dice`;
  if (face > bid.face) return `${describe(quantity, face)} does not raise ${current}: keep at least ${bid.quantity}`;
  return `${describe(quantity, face)} does not raise ${current}: bid at least ${bid.quantity + 1}, or ${bid.quantity} on a higher face`;
}

export function calzaAllowed(state) {
  return state.rules.calza && state.currentBid !== null && activeSeats(state).length > 2;
}

/**
 * Legal actions for `seat`, or [] when it is not that seat's turn.
 * Bids come out per face from the minimum legal quantity up to the dice on the table.
 */
export function legalActions(state, seat) {
  if (state.phase !== "bidding" || seat !== state.currentSeat) return [];
  const actions = [];
  if (state.currentBid) {
    actions.push({ type: "dudo" });
    if (calzaAllowed(state)) actions.push({ type: "calza" });
  }
  const table = totalDice(state);
  for (const face of FACES) {
    const minimum = minimumQuantityForFace(state, face);
    if (minimum === null) continue;
    for (let quantity = minimum; quantity <= table; quantity += 1) actions.push({ type: "bid", quantity, face });
  }
  return actions;
}

/** Compact form of the legal bids: one range per face. */
export function legalBidRanges(state, seat) {
  if (state.phase !== "bidding" || seat !== state.currentSeat) return [];
  const table = totalDice(state);
  const ranges = [];
  for (const face of FACES) {
    const minimum = minimumQuantityForFace(state, face);
    if (minimum !== null) ranges.push({ face, minQuantity: minimum, maxQuantity: table });
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Applying actions

/**
 * Apply `action` for `seat` and return the new state. Throws LiarsDiceError on an
 * illegal action. Actions: { type: "bid", quantity, face } | { type: "dudo" } | { type: "calza" }.
 * @param {object} [options]
 * @param {() => number} [options.rng] Injected random source for the next round's roll.
 */
export function applyAction(state, seat, action, { rng } = {}) {
  if (state.phase === "complete") throw new LiarsDiceError("The game is over", "game_over");
  if (state.phase !== "bidding") throw new LiarsDiceError(`Unknown phase ${state.phase}`, "bad_state");
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.seats.length) {
    throw new LiarsDiceError(`Seat ${seat} is not at this table`, "bad_seat");
  }
  if (seat !== state.currentSeat) throw new LiarsDiceError(`It is seat ${state.currentSeat}'s turn, not seat ${seat}'s`, "not_your_turn");
  const type = action?.type;
  const next = clone(state);
  if (type === "bid") return applyBid(next, seat, action);
  if (type === "dudo") return applyDudo(next, seat, rng);
  if (type === "calza") return applyCalza(next, seat, rng);
  throw new LiarsDiceError(`Unknown action type ${JSON.stringify(type)}`, "unknown_action");
}

function applyBid(state, seat, { quantity, face }) {
  const error = bidError(state, quantity, face);
  if (error) throw new LiarsDiceError(error, "illegal_bid");
  const bid = { seat, quantity, face };
  state.currentBid = bid;
  state.bids.push(bid);
  state.seats[seat].stats.bids += 1;
  state.currentSeat = nextActiveSeat(state, seat);
  pushEvent(state, { type: "bid", seat, quantity, face });
  return state;
}

function revealSnapshot(state) {
  return state.seats.map((seat) => [...seat.dice]);
}

function applyDudo(state, seat, rng) {
  const bid = state.currentBid;
  if (!bid) throw new LiarsDiceError("There is no bid to challenge yet", "no_bid");
  const allDice = state.seats.flatMap((entry) => entry.dice);
  const onesWild = !state.palifico;
  const count = countMatching(allDice, bid.face, { onesWild });
  const bidHolds = count >= bid.quantity;
  const loserSeat = bidHolds ? seat : bid.seat;
  state.seats[seat].stats.dudoCalls += 1;
  if (!bidHolds) state.seats[seat].stats.dudoWins += 1;
  state.lastReveal = {
    round: state.round,
    type: "dudo",
    callerSeat: seat,
    bid: { ...bid },
    palifico: state.palifico,
    onesWild,
    dice: revealSnapshot(state),
    count,
    outcome: bidHolds ? "bid_holds" : "bid_fails",
    loserSeat,
    gainerSeat: null,
  };
  pushEvent(state, { type: "dudo", seat, bid: { ...bid }, count, outcome: state.lastReveal.outcome, loserSeat });
  return settleRound(state, { loserSeat, gainerSeat: null, nextOpener: loserSeat }, rng);
}

function applyCalza(state, seat, rng) {
  if (!state.rules.calza) throw new LiarsDiceError("Calza is switched off at this table", "calza_disabled");
  const bid = state.currentBid;
  if (!bid) throw new LiarsDiceError("There is no bid to call calza on yet", "no_bid");
  if (activeSeats(state).length <= 2) throw new LiarsDiceError("Calza is not allowed when only two players remain", "calza_heads_up");
  const allDice = state.seats.flatMap((entry) => entry.dice);
  const onesWild = !state.palifico;
  const count = countMatching(allDice, bid.face, { onesWild });
  const exact = count === bid.quantity;
  state.seats[seat].stats.calzaCalls += 1;
  if (exact) state.seats[seat].stats.calzaWins += 1;
  state.lastReveal = {
    round: state.round,
    type: "calza",
    callerSeat: seat,
    bid: { ...bid },
    palifico: state.palifico,
    onesWild,
    dice: revealSnapshot(state),
    count,
    outcome: exact ? "exact" : "not_exact",
    loserSeat: exact ? null : seat,
    gainerSeat: exact ? seat : null,
  };
  pushEvent(state, { type: "calza", seat, bid: { ...bid }, count, outcome: state.lastReveal.outcome });
  return settleRound(state, { loserSeat: exact ? null : seat, gainerSeat: exact ? seat : null, nextOpener: seat }, rng);
}

function settleRound(state, { loserSeat, gainerSeat, nextOpener }, rng) {
  let palificoSeat = null;
  if (gainerSeat !== null) {
    const gainer = state.seats[gainerSeat];
    // The new die's face is irrelevant: every die is re-rolled when the next round starts.
    if (gainer.dice.length < state.rules.startingDice) {
      gainer.dice.push(0);
      gainer.stats.diceGained += 1;
      pushEvent(state, { type: "die_gained", seat: gainerSeat, diceLeft: gainer.dice.length });
    } else {
      pushEvent(state, { type: "die_gain_capped", seat: gainerSeat, diceLeft: gainer.dice.length });
    }
  }
  if (loserSeat !== null) {
    const loser = state.seats[loserSeat];
    loser.dice.pop();
    loser.stats.diceLost += 1;
    pushEvent(state, { type: "die_lost", seat: loserSeat, diceLeft: loser.dice.length });
    if (loser.dice.length === 0) {
      state.eliminationOrder.push(loserSeat);
      pushEvent(state, { type: "eliminated", seat: loserSeat });
    } else if (loser.dice.length === 1 && !loser.palificoUsed && state.rules.palifico && activeSeats(state).length > 2) {
      loser.palificoUsed = true;
      palificoSeat = loserSeat;
    }
  }

  const live = activeSeats(state);
  if (live.length === 1) {
    finishGame(state, live[0]);
    return state;
  }
  const opener = state.seats[nextOpener].dice.length > 0 ? nextOpener : nextActiveSeat(state, nextOpener);
  startRound(state, opener, palificoSeat !== null, palificoSeat, randomSource(state, rng));
  return state;
}

function finishGame(state, winnerSeat) {
  state.phase = "complete";
  state.currentSeat = null;
  state.currentBid = null;
  state.winnerSeat = winnerSeat;
  // Places: the winner is 1st, the last player knocked out 2nd, and so on.
  const order = [winnerSeat, ...[...state.eliminationOrder].reverse()];
  state.result = {
    winnerSeat,
    placements: order.map((seat, index) => ({ seat, place: index + 1, diceLeft: state.seats[seat].dice.length })),
    rounds: state.round,
  };
  pushEvent(state, { type: "game_over", winnerSeat });
}

export function isGameOver(state) {
  return state.phase === "complete";
}

// ---------------------------------------------------------------------------
// Views

/**
 * What `viewerSeat` may see: everyone's dice counts, the bidding, the last reveal,
 * and only its own dice. Pass viewerSeat null for a spectator, or revealAll for an
 * AI-vs-AI arena broadcast. Never exposes the RNG state.
 */
export function viewForSeat(state, viewerSeat, { revealAll = false } = {}) {
  return {
    game: state.game,
    phase: state.phase,
    round: state.round,
    rules: { ...state.rules },
    roundStarter: state.roundStarter,
    currentSeat: state.currentSeat,
    palifico: state.palifico,
    palificoSeat: state.palificoSeat,
    onesWild: !state.palifico,
    currentBid: state.currentBid ? { ...state.currentBid } : null,
    bids: state.bids.map((bid) => ({ ...bid })),
    totalDice: totalDice(state),
    viewerSeat: viewerSeat ?? null,
    seats: state.seats.map((seat) => ({
      seat: seat.seat,
      diceCount: seat.dice.length,
      eliminated: seat.dice.length === 0,
      palificoUsed: seat.palificoUsed,
      dice: revealAll || seat.seat === viewerSeat ? [...seat.dice] : null,
      stats: { ...seat.stats },
    })),
    lastReveal: state.lastReveal ? clone(state.lastReveal) : null,
    eliminationOrder: [...state.eliminationOrder],
    winnerSeat: state.winnerSeat,
    result: state.result ? clone(state.result) : null,
    events: state.events.map((event) => clone(event)),
  };
}

export function publicView(state, options = {}) {
  return viewForSeat(state, null, options);
}

// ---------------------------------------------------------------------------
// Save and resume

function requireSaved(condition, message) {
  if (!condition) throw new LiarsDiceError(`Saved Liar's Dice game is invalid: ${message}`, "bad_save");
}

/** Validate a saved state (object or JSON string) and return a fresh copy. */
export function restoreLiarsDiceState(saved) {
  let state;
  try {
    state = typeof saved === "string" ? JSON.parse(saved) : clone(saved);
  } catch {
    throw new LiarsDiceError("Saved Liar's Dice game is not valid JSON", "bad_save");
  }
  requireSaved(state && typeof state === "object", "not an object");
  requireSaved(state.game === GAME_ID, "wrong game");
  requireSaved(state.version === STATE_VERSION, "unsupported version");
  requireSaved(state.phase === "bidding" || state.phase === "complete", "phase is invalid");
  requireSaved(state.rules && typeof state.rules === "object", "rules are missing");
  let rules;
  try {
    rules = normalizeRules(state.rules);
  } catch {
    requireSaved(false, "rules are invalid");
  }
  requireSaved(Object.keys(DEFAULT_RULES).every((key) => rules[key] === state.rules[key]), "rules are invalid");
  requireSaved(Array.isArray(state.seats) && state.seats.length >= MIN_SEATS && state.seats.length <= MAX_SEATS, "seat count is invalid");
  state.seats.forEach((seat, index) => {
    requireSaved(seat?.seat === index, "seat numbering is invalid");
    requireSaved(Array.isArray(seat.dice) && seat.dice.length <= rules.startingDice, `seat ${index} has too many dice`);
    requireSaved(seat.dice.every((die) => FACES.includes(die)), `seat ${index} has an invalid die`);
    requireSaved(typeof seat.palificoUsed === "boolean", `seat ${index} palifico flag is invalid`);
    requireSaved(seat.stats && Object.keys(emptyStats()).every((key) => Number.isInteger(seat.stats[key]) && seat.stats[key] >= 0), `seat ${index} stats are invalid`);
  });
  requireSaved(Number.isInteger(state.round) && state.round >= 1, "round is invalid");
  requireSaved(state.rngState === null || (Number.isInteger(state.rngState) && state.rngState >= 0 && state.rngState <= 0xffffffff), "RNG state is invalid");
  requireSaved(Array.isArray(state.events) && Number.isInteger(state.eventCount), "events are invalid");
  requireSaved(Array.isArray(state.bids), "bids are invalid");
  requireSaved(Array.isArray(state.eliminationOrder), "elimination order is invalid");
  requireSaved(state.eliminationOrder.every((seat) => state.seats[seat]?.dice.length === 0), "elimination order lists a live seat");
  const live = state.seats.filter((seat) => seat.dice.length > 0).length;
  requireSaved(live + state.eliminationOrder.length === state.seats.length, "elimination order does not match the dice");
  requireSaved(typeof state.palifico === "boolean", "palifico flag is invalid");
  if (state.phase === "bidding") {
    requireSaved(live >= 2, "a game in progress needs two live seats");
    requireSaved(state.seats[state.currentSeat]?.dice.length > 0, "current seat is not live");
    if (state.currentBid !== null) {
      const bid = state.currentBid;
      requireSaved(FACES.includes(bid.face) && Number.isInteger(bid.quantity) && bid.quantity >= 1, "current bid is invalid");
      requireSaved(state.seats[bid.seat]?.dice.length > 0, "current bid belongs to a seat that is out");
      requireSaved(state.bids.length > 0, "current bid is missing from the bid history");
    } else {
      requireSaved(state.bids.length === 0, "bid history without a current bid");
    }
  } else {
    requireSaved(live === 1 && state.winnerSeat !== null && state.seats[state.winnerSeat]?.dice.length > 0, "finished game has no single winner");
  }
  return state;
}
