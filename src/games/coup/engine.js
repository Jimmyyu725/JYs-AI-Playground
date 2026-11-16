// Coup rules engine: a pure, serializable state machine.
//
// The whole game lives in one plain JSON object. Every public function takes a
// state and returns a new one (the input is never mutated), so a route layer can
// save it with JSON.stringify and resume it with restoreCoupGame.
//
// Turn flow (each "window" waits for input, everything else runs automatically):
//
//   action ──► [challenge_action] ──► [block] ──► [challenge_block] ──► resolve ──► end turn
//                    │                                  │
//                    └─► lose_influence / exchange ◄────┘   (whenever a choice is needed)
//
// The remaining steps of the current turn are kept in `state.queue`, so a turn
// can pause at any decision point and continue after a save/resume.

export const CARDS = Object.freeze(["Duke", "Assassin", "Captain", "Ambassador", "Contessa"]);
export const COPIES_PER_CARD = 3;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const STARTING_COINS = 2;
export const COUP_COST = 7;
export const ASSASSINATE_COST = 3;
export const FORCED_COUP_COINS = 10;
export const STATE_VERSION = 1;
const LOG_LIMIT = 400;

export const ACTION_RULES = Object.freeze({
  income: Object.freeze({ claim: null, blockedBy: Object.freeze([]), cost: 0, targeted: false }),
  foreign_aid: Object.freeze({ claim: null, blockedBy: Object.freeze(["Duke"]), cost: 0, targeted: false }),
  coup: Object.freeze({ claim: null, blockedBy: Object.freeze([]), cost: COUP_COST, targeted: true }),
  tax: Object.freeze({ claim: "Duke", blockedBy: Object.freeze([]), cost: 0, targeted: false }),
  assassinate: Object.freeze({ claim: "Assassin", blockedBy: Object.freeze(["Contessa"]), cost: ASSASSINATE_COST, targeted: true }),
  steal: Object.freeze({ claim: "Captain", blockedBy: Object.freeze(["Captain", "Ambassador"]), cost: 0, targeted: true }),
  exchange: Object.freeze({ claim: "Ambassador", blockedBy: Object.freeze([]), cost: 0, targeted: false }),
});
export const ACTION_TYPES = Object.freeze(Object.keys(ACTION_RULES));

export const PHASES = Object.freeze([
  "action",
  "challenge_action",
  "block",
  "challenge_block",
  "lose_influence",
  "exchange",
  "game_over",
]);

export class CoupRuleError extends Error {
  constructor(message, code = "illegal_action") {
    super(message);
    this.name = "CoupRuleError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Randomness: a seeded mulberry32 generator whose state is stored in the game,
// so a resumed game continues the same sequence. Callers may inject their own
// `rng` (a function returning [0, 1)) per call instead.

function nextRandom(state) {
  state.rngState = (state.rngState + 0x6d2b79f5) >>> 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffleInPlace(cards, random) {
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
  }
  return cards;
}

export function createCourtDeck() {
  return CARDS.flatMap((card) => Array(COPIES_PER_CARD).fill(card));
}

// ---------------------------------------------------------------------------
// Small read helpers (exported because views and tests use them).

export function liveCards(player) {
  return player.influence.filter((slot) => !slot.revealed).map((slot) => slot.card);
}

export function revealedCards(player) {
  return player.influence.filter((slot) => slot.revealed).map((slot) => slot.card);
}

export function isAlive(player) {
  return player.influence.some((slot) => !slot.revealed);
}

export function aliveSeats(state) {
  return state.players.filter(isAlive).map((player) => player.seat);
}

function playerName(state, seat) {
  return state.players[seat]?.name ?? `Seat ${seat}`;
}

/** Seats whose input the engine is waiting for right now. */
export function awaitingSeats(state) {
  switch (state.phase) {
    case "action":
      return [state.activeSeat];
    case "challenge_action":
    case "block":
    case "challenge_block":
      return [...state.responders];
    case "lose_influence":
      return [state.lossPending.seat];
    case "exchange":
      return [state.exchange.seat];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Creation, serialization and invariants.

/**
 * Create a new game.
 * @param {object} config
 * @param {Array<string|{name:string}>} [config.players] seat names (2-6), or use playerCount
 * @param {number} [config.playerCount]
 * @param {number} [config.seed] uint32 seed for the stored RNG (default: Math.random)
 * @param {Function} [config.rng] injected RNG for the opening shuffle and starting seat
 * @param {number} [config.startingSeat] fixed first player (default: random)
 * @param {string[][]} [config.deal] fixed opening hands, two cards per seat, drawn from the deck
 */
export function createCoupGame(config = {}) {
  const names = Array.isArray(config.players)
    ? config.players.map((entry, seat) => String((typeof entry === "string" ? entry : entry?.name) ?? "").trim().slice(0, 40) || `Player ${seat + 1}`)
    : Array.from({ length: config.playerCount ?? 0 }, (_, seat) => `Player ${seat + 1}`);
  if (names.length < MIN_PLAYERS || names.length > MAX_PLAYERS) {
    throw new CoupRuleError(`Coup needs ${MIN_PLAYERS}-${MAX_PLAYERS} players, got ${names.length}`, "invalid_config");
  }

  const seed = Number.isInteger(config.seed) ? config.seed >>> 0 : Math.floor(Math.random() * 2 ** 32) >>> 0;
  const state = {
    game: "coup",
    version: STATE_VERSION,
    phase: "action",
    turn: 1,
    step: 0,
    activeSeat: 0,
    players: names.map((name, seat) => ({ seat, name, coins: STARTING_COINS, influence: [] })),
    deck: createCourtDeck(),
    pendingAction: null,
    block: null,
    responders: [],
    passed: [],
    lossPending: null,
    exchange: null,
    queue: [],
    eliminationOrder: [],
    result: null,
    log: [],
    rngState: seed,
  };
  const random = config.rng ?? (() => nextRandom(state));

  if (config.deal) {
    if (!Array.isArray(config.deal) || config.deal.length !== names.length) {
      throw new CoupRuleError("deal must list two cards for every seat", "invalid_config");
    }
    config.deal.forEach((hand, seat) => {
      if (!Array.isArray(hand) || hand.length !== 2) throw new CoupRuleError(`deal for seat ${seat} must have two cards`, "invalid_config");
      for (const card of hand) {
        const index = state.deck.indexOf(card);
        if (index === -1) throw new CoupRuleError(`deal uses more ${card} cards than the deck holds`, "invalid_config");
        state.deck.splice(index, 1);
        state.players[seat].influence.push({ card, revealed: false });
      }
    });
    shuffleInPlace(state.deck, random);
  } else {
    shuffleInPlace(state.deck, random);
    for (let round = 0; round < 2; round += 1) {
      for (const player of state.players) player.influence.push({ card: state.deck.pop(), revealed: false });
    }
  }

  state.activeSeat = Number.isInteger(config.startingSeat)
    ? config.startingSeat
    : Math.floor(random() * names.length);
  if (state.activeSeat < 0 || state.activeSeat >= names.length) throw new CoupRuleError("startingSeat is out of range", "invalid_config");
  // Official two-player rule: the starting player begins with only one coin.
  if (names.length === 2) state.players[state.activeSeat].coins = 1;

  pushLog(state, { kind: "start", text: `Coup begins with ${names.length} players. ${playerName(state, state.activeSeat)} acts first.`, seat: state.activeSeat });
  return state;
}

export function serializeCoupGame(state) {
  return JSON.stringify(state);
}

/** Restore a saved game (JSON string or object). Throws if the save is inconsistent. */
export function restoreCoupGame(saved) {
  let state;
  try {
    state = typeof saved === "string" ? JSON.parse(saved) : structuredClone(saved);
  } catch {
    throw new CoupRuleError("Saved Coup game is not valid JSON", "invalid_save");
  }
  const problems = checkInvariants(state);
  if (problems.length) throw new CoupRuleError(`Saved Coup game is invalid: ${problems.join("; ")}`, "invalid_save");
  return state;
}

/** Returns a list of broken invariants (empty when the state is consistent). */
export function checkInvariants(state) {
  const problems = [];
  if (!state || typeof state !== "object") return ["state is not an object"];
  if (state.game !== "coup" || state.version !== STATE_VERSION) problems.push("unknown game or version");
  if (!PHASES.includes(state.phase)) problems.push(`unknown phase ${state.phase}`);
  if (!Array.isArray(state.players) || state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS) {
    return [...problems, "player count is out of range"];
  }
  if (!Array.isArray(state.deck) || !Array.isArray(state.queue)) problems.push("deck or queue is missing");
  if (!Number.isInteger(state.rngState)) problems.push("rngState is missing");

  const counts = Object.fromEntries(CARDS.map((card) => [card, 0]));
  const count = (card) => {
    if (!(card in counts)) problems.push(`unknown card ${card}`);
    else counts[card] += 1;
  };
  (state.deck ?? []).forEach(count);
  (state.exchange?.drawn ?? []).forEach(count);
  state.players.forEach((player, seat) => {
    if (player.seat !== seat) problems.push(`seat ${seat} is mislabeled`);
    if (!Number.isInteger(player.coins) || player.coins < 0) problems.push(`seat ${seat} has invalid coins`);
    if (!Array.isArray(player.influence) || player.influence.length !== 2) problems.push(`seat ${seat} must hold two influence slots`);
    else player.influence.forEach((slot) => count(slot.card));
  });
  for (const card of CARDS) {
    if (counts[card] !== COPIES_PER_CARD) problems.push(`${card} count is ${counts[card]}, expected ${COPIES_PER_CARD}`);
  }

  const alive = state.players.filter(isAlive);
  if (state.phase === "game_over") {
    if (alive.length !== 1 || state.result?.winner !== alive[0]?.seat) problems.push("game over without a single winner");
  } else {
    if (alive.length < 2) problems.push("fewer than two players alive in a running game");
    if (!state.players[state.activeSeat] || !isAlive(state.players[state.activeSeat])) problems.push("active seat is not a living player");
    if (["challenge_action", "block", "challenge_block"].includes(state.phase) && !state.pendingAction) problems.push("reaction window without a pending action");
    if (state.phase === "lose_influence" && !state.lossPending) problems.push("lose_influence without lossPending");
    if (state.phase === "exchange" && !state.exchange) problems.push("exchange phase without exchange data");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Logging (public information only: never hidden cards drawn or returned).

function pushLog(state, entry) {
  state.log.push({ turn: state.turn, step: state.step, ...entry });
  if (state.log.length > LOG_LIMIT) state.log = state.log.slice(-LOG_LIMIT);
}

// ---------------------------------------------------------------------------
// Legal actions.

function candidateActions(state, seat) {
  const player = state.players[seat];
  switch (state.phase) {
    case "action": {
      const others = aliveSeats(state).filter((other) => other !== seat);
      return [
        { type: "income" },
        { type: "foreign_aid" },
        { type: "tax" },
        { type: "exchange" },
        ...others.map((target) => ({ type: "coup", target })),
        ...others.map((target) => ({ type: "assassinate", target })),
        ...others.map((target) => ({ type: "steal", target })),
      ];
    }
    case "challenge_action":
    case "challenge_block":
      return [{ type: "pass" }, { type: "challenge" }];
    case "block":
      return [{ type: "pass" }, ...ACTION_RULES[state.pendingAction.type].blockedBy.map((card) => ({ type: "block", card }))];
    case "lose_influence":
      return [...new Set(liveCards(player))].map((card) => ({ type: "reveal", card }));
    case "exchange":
      return keepCombinations(exchangeOptions(state), state.exchange.keepCount).map((keep) => ({ type: "exchange_keep", keep }));
    default:
      return [];
  }
}

function keepCombinations(options, size) {
  const sorted = [...options].sort((a, b) => CARDS.indexOf(a) - CARDS.indexOf(b));
  const results = new Map();
  const walk = (start, picked) => {
    if (picked.length === size) {
      results.set(picked.join("+"), [...picked]);
      return;
    }
    for (let index = start; index < sorted.length; index += 1) walk(index + 1, [...picked, sorted[index]]);
  };
  walk(0, []);
  return [...results.values()];
}

function exchangeOptions(state) {
  return [...liveCards(state.players[state.exchange.seat]), ...state.exchange.drawn];
}

/** Every concrete legal action for `seat` right now (empty if the seat is not awaited). */
export function getLegalActions(state, seat) {
  if (!awaitingSeats(state).includes(seat)) return [];
  return candidateActions(state, seat).filter((action) => validateAction(state, seat, action) === null);
}

function countCards(cards) {
  const counts = new Map();
  for (const card of cards) counts.set(card, (counts.get(card) ?? 0) + 1);
  return counts;
}

/** Returns null when the action is legal, otherwise a precise human-readable reason. */
export function validateAction(state, seat, action) {
  if (!action || typeof action !== "object" || typeof action.type !== "string") return "An action must be an object with a string \"type\"";
  if (state.phase === "game_over") return "The game is over";
  if (!Number.isInteger(seat) || !state.players[seat]) return `Seat ${seat} does not exist`;
  const waiting = awaitingSeats(state);
  if (!waiting.includes(seat)) {
    return `${playerName(state, seat)} (seat ${seat}) cannot act now: the game is in phase "${state.phase}" waiting on seat(s) ${waiting.join(", ")}`;
  }
  const player = state.players[seat];
  const pending = state.pendingAction;

  switch (state.phase) {
    case "action": {
      const rules = ACTION_RULES[action.type];
      if (!rules) return `Unknown action "${action.type}" in the action phase; choose one of ${ACTION_TYPES.join(", ")}`;
      if (player.coins >= FORCED_COUP_COINS && action.type !== "coup") {
        return `You have ${player.coins} coins: with ${FORCED_COUP_COINS} or more you must launch a coup`;
      }
      if (player.coins < rules.cost) return `${action.type} costs ${rules.cost} coins and you have ${player.coins}`;
      if (rules.targeted) {
        if (!Number.isInteger(action.target)) return `${action.type} needs an integer "target" seat`;
        if (action.target === seat) return "You cannot target yourself";
        const target = state.players[action.target];
        if (!target) return `Target seat ${action.target} does not exist`;
        if (!isAlive(target)) return `${target.name} (seat ${action.target}) is already out of the game`;
        // Stealing from an empty purse is a no-op; the engine refuses it to keep turns meaningful.
        if (action.type === "steal" && target.coins === 0) return `${target.name} has no coins to steal`;
      } else if (action.target !== undefined && action.target !== null) {
        return `${action.type} does not take a target`;
      }
      return null;
    }
    case "challenge_action":
    case "challenge_block":
      if (action.type === "pass" || action.type === "challenge") return null;
      return `During ${state.phase} you may only "pass" or "challenge", not "${action.type}"`;
    case "block": {
      if (action.type === "pass") return null;
      if (action.type !== "block") return `During the block window you may only "pass" or "block", not "${action.type}"`;
      const blockers = ACTION_RULES[pending.type].blockedBy;
      if (!blockers.includes(action.card)) {
        return `${pending.type} can only be blocked by claiming ${blockers.join(" or ")}, not ${action.card}`;
      }
      return null;
    }
    case "lose_influence":
      if (action.type !== "reveal") return `You must choose an influence to lose with "reveal", not "${action.type}"`;
      if (!liveCards(player).includes(action.card)) return `You hold no face-down ${action.card}; choose one of ${liveCards(player).join(", ")}`;
      return null;
    case "exchange": {
      if (action.type !== "exchange_keep") return `You must finish the exchange with "exchange_keep", not "${action.type}"`;
      const options = exchangeOptions(state);
      const need = state.exchange.keepCount;
      if (!Array.isArray(action.keep) || action.keep.length !== need) {
        return `Keep exactly ${need} card(s) from ${options.join(", ")}`;
      }
      const available = countCards(options);
      for (const [card, wanted] of countCards(action.keep)) {
        if ((available.get(card) ?? 0) < wanted) return `You cannot keep ${wanted} ${card}: the options are ${options.join(", ")}`;
      }
      return null;
    }
    default:
      return `Phase ${state.phase} accepts no actions`;
  }
}

// ---------------------------------------------------------------------------
// Applying actions.

/**
 * Apply `action` for `seat` and return the new state. Throws CoupRuleError with
 * a precise message when the action is illegal. Options: { rng } to inject randomness.
 */
export function applyAction(state, seat, action, options = {}) {
  const reason = validateAction(state, seat, action);
  if (reason) throw new CoupRuleError(reason, state.phase === "game_over" ? "game_over" : "illegal_action");
  const next = structuredClone(state);
  const random = options.rng ?? (() => nextRandom(next));
  next.step += 1;

  switch (next.phase) {
    case "action":
      declareAction(next, seat, action);
      break;
    case "challenge_action":
    case "challenge_block":
      if (action.type === "pass") recordPass(next, seat);
      else resolveChallenge(next, seat, random);
      break;
    case "block":
      if (action.type === "pass") recordPass(next, seat);
      else declareBlock(next, seat, action.card);
      break;
    case "lose_influence":
      next.lossPending = null;
      next.phase = "resolving";
      revealCard(next, seat, action.card);
      break;
    case "exchange":
      finishExchange(next, seat, action.keep, random);
      break;
    default:
      break;
  }
  runQueue(next, random);
  return next;
}

function declareAction(state, seat, action) {
  const rules = ACTION_RULES[action.type];
  const player = state.players[seat];
  const target = rules.targeted ? action.target : null;
  player.coins -= rules.cost;
  state.phase = "resolving";
  state.pendingAction = { type: action.type, actor: seat, target, claim: rules.claim, paid: rules.cost };
  const targetText = target === null ? "" : ` against ${playerName(state, target)}`;
  const claimText = rules.claim ? ` (claiming ${rules.claim})` : "";
  pushLog(state, {
    kind: "action",
    seat,
    action: action.type,
    target,
    claim: rules.claim,
    text: `${player.name} declares ${action.type.replace("_", " ")}${targetText}${claimText}.`,
  });

  switch (action.type) {
    case "income":
    case "foreign_aid":
    case "tax":
    case "exchange":
    case "steal":
    case "assassinate": {
      const steps = [];
      if (rules.claim) steps.push({ kind: "challenge_action_window" });
      if (rules.blockedBy.length) steps.push({ kind: "block_window" });
      steps.push({ kind: "resolve_action" }, { kind: "end_turn" });
      state.queue = steps;
      break;
    }
    case "coup":
      state.queue = [{ kind: "lose_influence", seat: target, reason: "coup" }, { kind: "end_turn" }];
      break;
    default:
      throw new CoupRuleError(`Unhandled action ${action.type}`);
  }
}

function recordPass(state, seat) {
  state.responders = state.responders.filter((other) => other !== seat);
  state.passed.push(seat);
  pushLog(state, { kind: "pass", seat, window: state.phase, text: `${playerName(state, seat)} passes.` });
  if (state.responders.length > 0) return;
  // Everyone passed: the window closes and the queued steps continue.
  if (state.phase === "challenge_block") {
    pushLog(state, { kind: "block_stands", seat: state.block.seat, text: `The block stands: ${playerName(state, state.pendingAction.actor)}'s ${state.pendingAction.type.replace("_", " ")} fails.` });
  }
  closeWindow(state);
}

function closeWindow(state) {
  state.phase = "resolving";
  state.responders = [];
  state.passed = [];
}

function declareBlock(state, seat, card) {
  state.block = { seat, card };
  pushLog(state, { kind: "block", seat, claim: card, text: `${playerName(state, seat)} blocks, claiming ${card}.` });
  closeWindow(state);
  // A block stops the action unless the block itself is successfully challenged.
  state.queue = [{ kind: "challenge_block_window" }, { kind: "end_turn" }];
}

function resolveChallenge(state, challenger, random) {
  const againstBlock = state.phase === "challenge_block";
  const claimantSeat = againstBlock ? state.block.seat : state.pendingAction.actor;
  const claim = againstBlock ? state.block.card : state.pendingAction.claim;
  const claimant = state.players[claimantSeat];
  const slot = claimant.influence.find((candidate) => !candidate.revealed && candidate.card === claim);
  closeWindow(state);

  if (slot) {
    // The claim was true: show the card, shuffle it back, draw a replacement.
    state.deck.push(slot.card);
    shuffleInPlace(state.deck, random);
    slot.card = state.deck.pop();
    pushLog(state, {
      kind: "challenge",
      seat: challenger,
      claimant: claimantSeat,
      claim,
      success: false,
      text: `${playerName(state, challenger)} challenges ${claimant.name}'s ${claim}. ${claimant.name} reveals ${claim}, shuffles it into the court deck and draws a replacement. ${playerName(state, challenger)} loses the challenge.`,
    });
    const loss = { kind: "lose_influence", seat: challenger, reason: "failed_challenge" };
    state.queue = againstBlock ? [loss, { kind: "end_turn" }] : [loss, ...state.queue];
    return;
  }

  pushLog(state, {
    kind: "challenge",
    seat: challenger,
    claimant: claimantSeat,
    claim,
    success: true,
    text: `${playerName(state, challenger)} challenges ${claimant.name}'s ${claim}. ${claimant.name} cannot show it and loses the challenge.`,
  });
  const loss = { kind: "lose_influence", seat: claimantSeat, reason: "caught_bluffing" };
  if (againstBlock) {
    // The block collapses, so the original action goes ahead.
    state.queue = [loss, { kind: "resolve_action" }, { kind: "end_turn" }];
  } else {
    // The action fails; any coins paid for it are returned.
    if (state.pendingAction.paid) {
      state.players[state.pendingAction.actor].coins += state.pendingAction.paid;
      state.pendingAction.refunded = state.pendingAction.paid;
    }
    state.queue = [loss, { kind: "end_turn" }];
  }
}

function revealCard(state, seat, card) {
  const player = state.players[seat];
  const slot = player.influence.find((candidate) => !candidate.revealed && candidate.card === card);
  slot.revealed = true;
  pushLog(state, { kind: "lose_influence", seat, card, text: `${player.name} loses an influence and reveals ${card}.` });
  if (isAlive(player)) return;
  // Exiled players return their coins to the treasury (house convention).
  player.coins = 0;
  state.eliminationOrder.push(seat);
  pushLog(state, { kind: "eliminated", seat, text: `${player.name} has lost all influence and is out.` });
  state.responders = state.responders.filter((other) => other !== seat);
  if (aliveSeats(state).length <= 1) finishGame(state);
}

function finishExchange(state, seat, keep, random) {
  const player = state.players[seat];
  const pool = exchangeOptions(state);
  for (const card of keep) pool.splice(pool.indexOf(card), 1);
  const keepQueue = [...keep];
  for (const slot of player.influence) {
    if (!slot.revealed) slot.card = keepQueue.shift();
  }
  state.deck.push(...pool);
  shuffleInPlace(state.deck, random);
  state.exchange = null;
  state.phase = "resolving";
  pushLog(state, { kind: "exchange_done", seat, text: `${player.name} returns two cards to the court deck.` });
}

function finishGame(state) {
  const [winner] = aliveSeats(state);
  state.phase = "game_over";
  state.queue = [];
  state.responders = [];
  state.passed = [];
  state.lossPending = null;
  state.exchange = null;
  const ranking = [winner, ...[...state.eliminationOrder].reverse()];
  state.result = {
    winner,
    winnerName: playerName(state, winner),
    ranking: ranking.map((seat, index) => ({ seat, place: index + 1, score: state.players.length - 1 - index })),
    turns: state.turn,
  };
  pushLog(state, { kind: "game_over", seat: winner, text: `${playerName(state, winner)} is the last player with influence and wins.` });
}

function openWindow(state, phase, responders) {
  state.phase = phase;
  state.responders = responders;
  state.passed = [];
}

function runQueue(state, random) {
  while (state.phase === "resolving" && state.queue.length > 0) {
    const step = state.queue.shift();
    const pending = state.pendingAction;
    switch (step.kind) {
      case "challenge_action_window": {
        const responders = aliveSeats(state).filter((seat) => seat !== pending.actor);
        if (responders.length) return openWindow(state, "challenge_action", responders);
        break;
      }
      case "block_window": {
        const eligible = pending.type === "foreign_aid"
          ? aliveSeats(state).filter((seat) => seat !== pending.actor)
          : [pending.target].filter((seat) => isAlive(state.players[seat]));
        if (eligible.length) return openWindow(state, "block", eligible);
        break;
      }
      case "challenge_block_window": {
        const responders = aliveSeats(state).filter((seat) => seat !== state.block.seat);
        if (responders.length) return openWindow(state, "challenge_block", responders);
        break;
      }
      case "lose_influence": {
        const player = state.players[step.seat];
        const cards = liveCards(player);
        if (cards.length === 0) break;
        if (new Set(cards).size === 1) {
          // No real choice: one card left, or two identical cards.
          revealCard(state, step.seat, cards[0]);
          break;
        }
        state.phase = "lose_influence";
        state.lossPending = { seat: step.seat, reason: step.reason };
        return undefined;
      }
      case "resolve_action":
        if (resolveAction(state, random) === "await") return undefined;
        break;
      case "end_turn":
        endTurn(state);
        return undefined;
      default:
        throw new CoupRuleError(`Unknown queue step ${step.kind}`);
    }
  }
  return undefined;
}

function resolveAction(state, random) {
  const pending = state.pendingAction;
  const actor = state.players[pending.actor];
  if (!isAlive(actor)) return "done";
  const target = pending.target === null ? null : state.players[pending.target];
  pending.resolved = true;
  switch (pending.type) {
    case "income":
      actor.coins += 1;
      pushLog(state, { kind: "resolve", seat: actor.seat, action: "income", text: `${actor.name} takes 1 coin of income.` });
      return "done";
    case "foreign_aid":
      actor.coins += 2;
      pushLog(state, { kind: "resolve", seat: actor.seat, action: "foreign_aid", text: `${actor.name} takes 2 coins of foreign aid.` });
      return "done";
    case "tax":
      actor.coins += 3;
      pushLog(state, { kind: "resolve", seat: actor.seat, action: "tax", text: `${actor.name} collects 3 coins of tax.` });
      return "done";
    case "steal": {
      const amount = Math.min(2, target.coins);
      target.coins -= amount;
      actor.coins += amount;
      pending.amount = amount;
      pushLog(state, { kind: "resolve", seat: actor.seat, action: "steal", target: target.seat, amount, text: `${actor.name} steals ${amount} coin${amount === 1 ? "" : "s"} from ${target.name}.` });
      return "done";
    }
    case "assassinate":
      if (!isAlive(target)) return "done";
      pushLog(state, { kind: "resolve", seat: actor.seat, action: "assassinate", target: target.seat, text: `${actor.name}'s assassin strikes ${target.name}.` });
      state.queue.unshift({ kind: "lose_influence", seat: target.seat, reason: "assassinated" });
      return "done";
    case "exchange": {
      const drawn = [state.deck.pop(), state.deck.pop()];
      state.exchange = { seat: actor.seat, drawn, keepCount: liveCards(actor).length };
      state.phase = "exchange";
      pushLog(state, { kind: "resolve", seat: actor.seat, action: "exchange", text: `${actor.name} draws two cards from the court deck.` });
      return "await";
    }
    default:
      return "done";
  }
}

function endTurn(state) {
  if (aliveSeats(state).length <= 1) {
    finishGame(state);
    return;
  }
  const count = state.players.length;
  let seat = state.activeSeat;
  do {
    seat = (seat + 1) % count;
  } while (!isAlive(state.players[seat]));
  state.activeSeat = seat;
  state.turn += 1;
  state.phase = "action";
  state.pendingAction = null;
  state.block = null;
  state.responders = [];
  state.passed = [];
  state.lossPending = null;
  state.exchange = null;
  state.queue = [];
}

// ---------------------------------------------------------------------------
// Views.

/**
 * Public view for a seat (or a spectator when viewerSeat is null).
 * Never includes the deck order, other players' face-down cards or the RNG state.
 * `revealAll` is for AI-vs-AI spectating and post-game review.
 */
export function publicView(state, viewerSeat = null, { revealAll = false } = {}) {
  const exchangeVisible = state.exchange && (revealAll || state.exchange.seat === viewerSeat);
  return {
    game: "coup",
    phase: state.phase,
    turn: state.turn,
    step: state.step,
    activeSeat: state.activeSeat,
    viewerSeat,
    deckCount: state.deck.length,
    players: state.players.map((player) => {
      const own = revealAll || player.seat === viewerSeat;
      return {
        seat: player.seat,
        name: player.name,
        coins: player.coins,
        alive: isAlive(player),
        influenceCount: liveCards(player).length,
        revealed: revealedCards(player),
        hidden: own ? liveCards(player) : null,
      };
    }),
    pendingAction: state.pendingAction ? structuredClone(state.pendingAction) : null,
    block: state.block ? { ...state.block } : null,
    awaitingSeats: awaitingSeats(state),
    passed: [...state.passed],
    lossPending: state.lossPending ? { ...state.lossPending } : null,
    exchange: state.exchange
      ? {
          seat: state.exchange.seat,
          keepCount: state.exchange.keepCount,
          options: exchangeVisible ? exchangeOptions(state) : null,
        }
      : null,
    result: state.result ? structuredClone(state.result) : null,
    log: state.log.map((entry) => ({ ...entry })),
  };
}

/** Short English label for a concrete action, used by UIs and the AI view. */
export function describeAction(state, seat, action) {
  const name = (target) => `${playerName(state, target)} (seat ${target})`;
  const pending = state.pendingAction;
  switch (action.type) {
    case "income":
      return "Income: take 1 coin (cannot be challenged or blocked)";
    case "foreign_aid":
      return "Foreign Aid: take 2 coins (any player may block by claiming Duke)";
    case "tax":
      return "Tax: take 3 coins, claiming Duke";
    case "exchange":
      return "Exchange: draw 2 court cards and return 2, claiming Ambassador";
    case "coup":
      return `Coup ${name(action.target)}: pay ${COUP_COST} coins, they lose an influence (cannot be blocked)`;
    case "assassinate":
      return `Assassinate ${name(action.target)}: pay ${ASSASSINATE_COST} coins, claiming Assassin (Contessa blocks)`;
    case "steal":
      return `Steal up to 2 coins from ${name(action.target)}, claiming Captain (Captain or Ambassador blocks)`;
    case "pass":
      if (state.phase === "block") return `Pass: do not block ${playerName(state, pending.actor)}'s ${pending.type.replace("_", " ")}`;
      if (state.phase === "challenge_block") return `Pass: accept ${playerName(state, state.block.seat)}'s ${state.block.card} block`;
      return `Pass: accept ${playerName(state, pending.actor)}'s ${pending.claim} claim`;
    case "challenge":
      if (state.phase === "challenge_block") {
        return `Challenge ${playerName(state, state.block.seat)}'s claim to hold ${state.block.card} (whoever is wrong loses an influence)`;
      }
      return `Challenge ${playerName(state, pending.actor)}'s claim to hold ${pending.claim} (whoever is wrong loses an influence)`;
    case "block":
      return `Block ${playerName(state, pending.actor)}'s ${pending.type.replace("_", " ")}, claiming ${action.card}`;
    case "reveal":
      return `Lose your ${action.card} (turn it face up)`;
    case "exchange_keep": {
      const returned = [...exchangeOptions(state)];
      for (const card of action.keep) returned.splice(returned.indexOf(card), 1);
      return `Keep ${action.keep.join(" + ")}, return ${returned.join(" + ")}`;
    }
    default:
      return action.type;
  }
}
