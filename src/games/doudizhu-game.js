import { AI_CHARACTERS } from "../platform/characters.js";
import { normalizeModelConfig } from "../platform/model-registry.js";

const RANKS = Object.freeze(["3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2"]);
const SUITS = Object.freeze(["C", "D", "H", "S"]);
const JOKER_SMALL = "SJ";
const JOKER_BIG = "BJ";
const STRAIGHT_RANKS = Object.freeze(RANKS.slice(0, 12)); // 3..A
const MAX_HAND = 20;

export function rankValue(rank) {
  const index = RANKS.indexOf(rank);
  if (index !== -1) return index + 3;
  if (rank === "SJ") return 16;
  if (rank === "BJ") return 17;
  return null;
}

export function rankOf(code) {
  if (code === JOKER_SMALL || code === JOKER_BIG) return code;
  if (typeof code === "string" && code.length === 2) return code[0];
  return null;
}

export function isValidCardCode(code) {
  if (code === JOKER_SMALL || code === JOKER_BIG) return true;
  return typeof code === "string" && code.length === 2 && RANKS.includes(code[0]) && SUITS.includes(code[1]);
}

export function createDouDizhuDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) deck.push(`${rank}${suit}`);
  }
  deck.push(JOKER_SMALL, JOKER_BIG);
  return deck;
}

export function shuffleDouDizhuDeck(deck) {
  const shuffled = [...deck];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function sortCards(cards) {
  return [...cards].sort((left, right) => {
    const rankDifference = rankValue(rankOf(right)) - rankValue(rankOf(left));
    if (rankDifference !== 0) return rankDifference;
    return SUITS.indexOf(right[1]) - SUITS.indexOf(left[1]);
  });
}

function groupByRank(cards) {
  const groups = new Map();
  for (const code of cards) {
    const rank = rankOf(code);
    if (!rank) throw new Error(`Unknown card “${code}”`);
    if (!groups.has(rank)) groups.set(rank, []);
    groups.get(rank).push(code);
  }
  return groups;
}

function isConsecutive(rankValues) {
  for (let index = 1; index < rankValues.length; index += 1) {
    if (rankValues[index] !== rankValues[index - 1] + 1) return false;
  }
  return true;
}

export function analyzeCombo(cards) {
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > MAX_HAND) {
    throw new Error("A play must contain between 1 and 20 cards");
  }
  const unique = new Set(cards);
  if (unique.size !== cards.length) throw new Error("A play cannot repeat the same card");
  const groups = groupByRank(cards);
  const groupEntries = [...groups.entries()]
    .map(([rank, groupCards]) => ({ rank, rankValue: rankValue(rank), count: groupCards.length }))
    .sort((left, right) => left.rankValue - right.rankValue);
  const counts = groupEntries.map((entry) => entry.count);
  const total = groupEntries.length;

  if (total === 1) {
    const entry = groupEntries[0];
    if (entry.count === 1) return { type: "single", mainRank: entry.rankValue, length: 1 };
    if (entry.count === 2) return { type: "pair", mainRank: entry.rankValue, length: 1 };
    if (entry.count === 3) return { type: "triple", mainRank: entry.rankValue, length: 1 };
    if (entry.count === 4) return { type: "bomb", mainRank: entry.rankValue, length: 1 };
    throw new Error("That combination is not a legal Dou Dizhu play");
  }

  const triples = groupEntries.filter((entry) => entry.count === 3);
  const pairs = groupEntries.filter((entry) => entry.count === 2);
  const singles = groupEntries.filter((entry) => entry.count === 1);

  // Two or more consecutive triples form an airplane (pure, no wings).
  if (triples.length >= 2 && triples.length === total && isStraightSequence(triples)) {
    return { type: "airplane", mainRank: triples[triples.length - 1].rankValue, length: triples.length };
  }

  if (total === 2) {
    const [first, second] = groupEntries;
    if (first.rank === JOKER_SMALL && second.rank === JOKER_BIG) return { type: "rocket", mainRank: 18, length: 1 };
    if (first.count === 3 && second.count === 1) return { type: "triple_single", mainRank: first.rankValue, length: 1 };
    if (first.count === 3 && second.count === 2) return { type: "triple_pair", mainRank: first.rankValue, length: 1 };
    // Four with two singles: the two attached singles may share a rank (6 cards).
    if (first.count === 4 && second.count === 2) return { type: "four_two_single", mainRank: first.rankValue, length: 1 };
    throw new Error("That combination is not a legal Dou Dizhu play");
  }

  if (total === 3) {
    const four = groupEntries.find((entry) => entry.count === 4);
    const hasBothJokers = singles.some((entry) => entry.rank === JOKER_SMALL) && singles.some((entry) => entry.rank === JOKER_BIG);
    // Four with two pairs (8 cards) is a distinct combo from four with two singles.
    if (four && pairs.length === 2) return { type: "four_two_pair", mainRank: four.rankValue, length: 1 };
    // Four with two singles (6 cards): the two singles may share a rank, but must not be both jokers.
    if (four && singles.length === 2 && !hasBothJokers) return { type: "four_two_single", mainRank: four.rankValue, length: 1 };
  }

  if (total >= 5 && counts.every((count) => count === 1) && isStraightSequence(groupEntries)) {
    return { type: "straight", mainRank: groupEntries[groupEntries.length - 1].rankValue, length: groupEntries.length };
  }
  if (total >= 3 && counts.every((count) => count === 2) && isStraightSequence(groupEntries)) {
    return { type: "pair_straight", mainRank: groupEntries[groupEntries.length - 1].rankValue, length: groupEntries.length };
  }
  // Airplane with single wings: one extra card per triple. The wings may form pairs,
  // and may include a two or a single joker, but not both jokers together.
  {
    const wingEntries = groupEntries.filter((entry) => !triples.includes(entry));
    const wingTotal = wingEntries.reduce((sum, entry) => sum + entry.count, 0);
    const wingHasBothJokers = wingEntries.some((entry) => entry.rank === JOKER_SMALL) && wingEntries.some((entry) => entry.rank === JOKER_BIG);
    if (
      triples.length >= 2
      && isStraightSequence(triples)
      && wingTotal === triples.length
      && wingEntries.every((entry) => entry.count <= 2)
      && !wingHasBothJokers
    ) {
      return { type: "airplane_single", mainRank: triples[triples.length - 1].rankValue, length: triples.length };
    }
  }
  if (
    triples.length >= 2
    && isStraightSequence(triples)
    && pairs.length === triples.length
    && singles.length === 0
    && pairs.length + triples.length === total
  ) {
    return { type: "airplane_pair", mainRank: triples[triples.length - 1].rankValue, length: triples.length };
  }

  throw new Error("That combination is not a legal Dou Dizhu play");
}

function isStraightSequence(entries) {
  if (entries.length < 1) return false;
  if (entries.some((entry) => entry.rank === JOKER_SMALL || entry.rank === JOKER_BIG)) return false;
  if (entries.some((entry) => !STRAIGHT_RANKS.includes(entry.rank))) return false;
  return isConsecutive(entries.map((entry) => entry.rankValue));
}

export function beatsCombo(candidate, target) {
  if (candidate.type === "rocket") return true;
  if (target.type === "rocket") return false;
  if (candidate.type === "bomb" && target.type !== "bomb") return true;
  if (candidate.type === "bomb" && target.type === "bomb") return candidate.mainRank > target.mainRank;
  if (target.type === "bomb") return false;
  if (candidate.type !== target.type) return false;
  if (candidate.length !== target.length) return false;
  return candidate.mainRank > target.mainRank;
}

export function describeCombo(combo) {
  const names = {
    single: "Single",
    pair: "Pair",
    triple: "Triple",
    triple_single: "Triple with one",
    triple_pair: "Triple with pair",
    straight: "Straight",
    pair_straight: "Pair straight",
    airplane: "Airplane",
    airplane_single: "Airplane with singles",
    airplane_pair: "Airplane with pairs",
    four_two_single: "Four with two",
    four_two_pair: "Four with two pairs",
    bomb: "Bomb",
    rocket: "Rocket",
  };
  return names[combo.type] ?? combo.type;
}

export function handByRankSummary(hand) {
  const groups = groupByRank(hand);
  return [...groups.entries()]
    .sort((left, right) => rankValue(left[0]) - rankValue(right[0]))
    .map(([rank, cards]) => `${rank}:${cards.length}`)
    .join(" ");
}

export function exampleLeads(hand) {
  const examples = [];
  const groups = groupByRank(hand);
  const sorted = [...groups.entries()].sort((left, right) => rankValue(left[0]) - rankValue(right[0]));
  const byCount = (count) => sorted.find(([, cards]) => cards.length === count);

  const single = byCount(1);
  if (single) examples.push({ type: "single", cards: single[1], description: `single ${single[0]}` });
  const pair = byCount(2);
  if (pair) examples.push({ type: "pair", cards: pair[1], description: `pair ${pair[0]}${pair[0]}` });
  const triple = byCount(3);
  if (triple) examples.push({ type: "triple", cards: triple[1], description: `triple ${triple[0]}${triple[0]}${triple[0]}` });
  const bomb = byCount(4);
  if (bomb) examples.push({ type: "bomb", cards: bomb[1], description: `bomb ${bomb[0]}${bomb[0]}${bomb[0]}${bomb[0]}` });
  if (groups.has(JOKER_SMALL) && groups.has(JOKER_BIG)) {
    examples.push({ type: "rocket", cards: [JOKER_SMALL, JOKER_BIG], description: "rocket SJ BJ" });
  }

  const straightRanks = STRAIGHT_RANKS.map((rank) => ({ rank, value: rankValue(rank) }));
  for (let start = 0; start <= straightRanks.length - 5; start += 1) {
    const window = straightRanks.slice(start, start + 5);
    if (window.every(({ rank }) => groups.has(rank))) {
      const cards = window.map(({ rank }) => groups.get(rank)[0]);
      examples.push({ type: "straight", cards, description: `straight ${window[0].rank}-${window[window.length - 1].rank}` });
      break;
    }
  }
  for (let start = 0; start <= straightRanks.length - 3; start += 1) {
    const window = straightRanks.slice(start, start + 3);
    if (window.every(({ rank }) => (groups.get(rank)?.length ?? 0) >= 2)) {
      const cards = window.flatMap(({ rank }) => groups.get(rank).slice(0, 2));
      examples.push({
        type: "pair_straight",
        cards,
        description: `pair straight ${window[0].rank}${window[0].rank}-${window[window.length - 1].rank}${window[window.length - 1].rank}`,
      });
      break;
    }
  }
  return examples.slice(0, 8);
}

function firstBidderFor(handNumber) {
  return (handNumber - 1) % 3;
}

export class DouDizhuGame {
  constructor(config = {}) {
    this.gameMode = config.gameMode === "arena" ? "arena" : "human";
    this.arenaPaused = this.gameMode === "arena" && Boolean(config.arenaPaused);
    this.handNumber = 0;
    this.phase = "bidding";
    this.highestBid = 0;
    this.highestBidderSeat = null;
    this.consecutivePasses = 0;
    this.landlordSeat = null;
    this.bottomCards = [];
    this.currentActorSeat = null;
    this.leaderSeat = null;
    this.passesSincePlay = 0;
    this.lastPlay = null;
    this.lastPlaySeat = null;
    this.bombsPlayed = 0;
    this.playsCount = [0, 0, 0];
    this.result = null;
    this.deck = [];
    this.logs = [];
    this.aiInsights = [];
    this.aiThinking = null;
    this.aiError = null;

    const requestedAI = Array.isArray(config.aiPlayers) ? config.aiPlayers : [];
    let aiIndex = 0;
    this.players = [0, 1, 2].map((seat) => {
      const isHuman = this.gameMode === "human" && seat === 0;
      if (isHuman) {
        return {
          seat,
          name: String(config.humanName ?? "Player").trim().slice(0, 18) || "Player",
          isHuman: true,
          character: null,
          aiConfig: null,
          hand: [],
          bid: null,
          lastAction: "",
        };
      }
      const character = AI_CHARACTERS[this.gameMode === "arena" ? [0, 1, 4][seat] : seat === 1 ? 1 : 4];
      const player = {
        seat,
        name: character.name,
        isHuman: false,
        character,
        aiConfig: normalizeModelConfig("doudizhu", requestedAI[aiIndex] ?? config),
        hand: [],
        bid: null,
        lastAction: "",
      };
      aiIndex += 1;
      return player;
    });

    this._log("system", `Dou Dizhu opens: one landlord against two farmers. ${this.gameMode === "arena" ? "Three AI seats." : "One human seat and two AI opponents."}`);
    this.startNewHand();
  }

  _log(kind, text, extra = {}) {
    this.logs.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      kind,
      text,
      handNumber: this.handNumber,
      at: new Date().toISOString(),
      ...extra,
    });
    this.logs = this.logs.slice(-220);
  }

  get isArenaMode() {
    return this.gameMode === "arena";
  }

  get currentActor() {
    return this.currentActorSeat === null ? null : this.players[this.currentActorSeat];
  }

  get biddingComplete() {
    return this.highestBidderSeat !== null;
  }

  startNewHand() {
    this.handNumber += 1;
    this.phase = "bidding";
    this.highestBid = 0;
    this.highestBidderSeat = null;
    this.consecutivePasses = 0;
    this.landlordSeat = null;
    this.bottomCards = [];
    this.leaderSeat = null;
    this.passesSincePlay = 0;
    this.lastPlay = null;
    this.lastPlaySeat = null;
    this.bombsPlayed = 0;
    this.playsCount = [0, 0, 0];
    this.result = null;
    this.aiError = null;
    this.aiThinking = null;
    this.deck = shuffleDouDizhuDeck(createDouDizhuDeck());

    for (const player of this.players) {
      player.hand = [];
      player.bid = null;
      player.lastAction = "";
    }
    for (let dealt = 0; dealt < 51; dealt += 1) {
      this.players[dealt % 3].hand.push(this.deck.pop());
    }
    this.bottomCards = this.deck.splice(0, 3);
    for (const player of this.players) player.hand = sortCards(player.hand);
    this.currentActorSeat = firstBidderFor(this.handNumber);
    this._log("hand", `Hand ${this.handNumber}: cards are dealt and bidding opens with ${this.players[this.currentActorSeat].name}.`);
  }

  applyBid(seat, score = null) {
    if (this.phase !== "bidding") throw new Error("Bidding is not open");
    if (seat !== this.currentActorSeat) throw new Error("That player is not bidding now");
    const player = this.players[seat];
    if (score === null || score === 0) {
      player.bid = 0;
      player.lastAction = "Passed";
      this.consecutivePasses += 1;
      this._log("bid", `${player.name} passes.`, { seat });
      this._advanceBidder(seat);
      if (this.consecutivePasses >= 3 && this.highestBidderSeat === null) {
        this._log("system", "No one bid. The house redeals.");
        this.startNewHand();
        return;
      }
      if (this.consecutivePasses >= 2 && this.highestBidderSeat !== null) {
        this._finishBidding();
        return;
      }
      return;
    }

    const parsed = Number.parseInt(score, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) throw new Error("Bid must be 1, 2, or 3");
    if (parsed <= this.highestBid) throw new Error(`You must bid higher than ${this.highestBid}`);
    player.bid = parsed;
    player.lastAction = `Bid ${parsed}`;
    this.highestBid = parsed;
    this.highestBidderSeat = seat;
    this.consecutivePasses = 0;
    this._log("bid", `${player.name} bids ${parsed}.`, { seat, score: parsed });
    if (parsed === 3) {
      this._finishBidding();
      return;
    }
    this._advanceBidder(seat);
  }

  _advanceBidder(previousSeat) {
    this.currentActorSeat = (previousSeat + 1) % 3;
  }

  _finishBidding() {
    this.landlordSeat = this.highestBidderSeat;
    const landlord = this.players[this.landlordSeat];
    landlord.hand = sortCards([...landlord.hand, ...this.bottomCards]);
    this.phase = "playing";
    this.currentActorSeat = this.landlordSeat;
    this.leaderSeat = this.landlordSeat;
    this.lastPlay = null;
    this.passesSincePlay = 0;
    for (const player of this.players) player.lastAction = "";
    this._log("hand", `${landlord.name} takes the bottom cards (${this.bottomCards.join(" ")}) and becomes the landlord for ${this.highestBid}.`, {
      landlordSeat: this.landlordSeat,
      bottomCards: [...this.bottomCards],
    });
  }

  applyAction(seat, action, cards = null) {
    if (this.phase !== "playing") throw new Error("The game is not in play");
    if (seat !== this.currentActorSeat) throw new Error("That player is not acting now");
    const player = this.players[seat];
    const leading = seat === this.leaderSeat || !this.lastPlay;

    if (action === "pass") {
      if (leading) throw new Error("The leading player cannot pass");
      player.lastAction = "Passed";
      this.passesSincePlay += 1;
      this._log("play", `${player.name} passes.`, { seat });
      if (this.passesSincePlay >= 2) {
        this._log("play", `The trick ends. ${this.players[this.lastPlaySeat].name} leads again.`, { seat: this.lastPlaySeat });
        this.currentActorSeat = this.lastPlaySeat;
        this.leaderSeat = this.lastPlaySeat;
        this.lastPlay = null;
        this.passesSincePlay = 0;
      } else {
        this.currentActorSeat = (seat + 1) % 3;
      }
      return;
    }

    if (action !== "play") throw new Error(`Unknown Dou Dizhu action “${action}”`);
    if (!Array.isArray(cards) || cards.length === 0) throw new Error("Choose at least one card");
    for (const code of cards) {
      if (!player.hand.includes(code)) throw new Error(`Card ${code} is not in your hand`);
    }
    const combo = analyzeCombo(cards);
    if (!leading) {
      if (!beatsCombo(combo, this.lastPlay.combo)) {
        throw new Error(`${describeCombo(combo)} cannot beat ${this.lastPlay.description}`);
      }
    }

    player.hand = sortCards(player.hand.filter((code) => !cards.includes(code)));
    const description = `${describeCombo(combo)} ${cards.join(" ")}`;
    if (combo.type === "bomb" || combo.type === "rocket") this.bombsPlayed += 1;
    this.playsCount[seat] += 1;
    player.lastAction = cards.join(" ");
    this.lastPlay = { seat, cards: [...cards], combo, description };
    this.lastPlaySeat = seat;
    this.leaderSeat = seat;
    this.passesSincePlay = 0;
    this._log("play", `${player.name} plays ${description}.`, { seat, cards: [...cards], comboType: combo.type });

    if (player.hand.length === 0) {
      this._finishGame(seat);
      return;
    }
    this.currentActorSeat = (seat + 1) % 3;
  }

  _finishGame(winnerSeat) {
    this.phase = "complete";
    this.currentActorSeat = null;
    this.aiThinking = null;
    const landlordWins = winnerSeat === this.landlordSeat;
    const farmersPlayed = [0, 1, 2]
      .filter((seat) => seat !== this.landlordSeat)
      .some((seat) => this.playsCount[seat] > 0);
    let spring = "none";
    if (landlordWins && !farmersPlayed) spring = "spring";
    else if (!landlordWins && this.playsCount[this.landlordSeat] <= 1) spring = "anti_spring";
    const multiplier = (2 ** this.bombsPlayed) * (spring === "none" ? 1 : 2);
    const score = this.highestBid * multiplier;
    this.result = {
      winner: landlordWins ? "landlord" : "farmers",
      landlordSeat: this.landlordSeat,
      winningSeats: landlordWins ? [winnerSeat] : [0, 1, 2].filter((seat) => seat !== this.landlordSeat),
      bid: this.highestBid,
      bombsPlayed: this.bombsPlayed,
      spring,
      multiplier,
      score,
    };
    const winnerName = landlordWins ? this.players[this.landlordSeat].name : "The farmers";
    const springText = spring === "spring" ? " The farmers never played a card: spring doubles the pot." : spring === "anti_spring" ? " The landlord managed only one play: anti-spring doubles the pot." : "";
    this._log("result", `${winnerName} win${landlordWins ? "s" : ""} the hand. Base ${this.highestBid} × ${multiplier} = ${score}.${springText}`, {
      result: this.result,
    });
  }

  legalPlayFromHand(seat, hand, cards) {
    for (const code of cards) {
      if (!hand.includes(code)) throw new Error(`Card ${code} is not in the hand`);
    }
    const combo = analyzeCombo(cards);
    const leading = seat === this.leaderSeat || !this.lastPlay;
    if (!leading && !beatsCombo(combo, this.lastPlay.combo)) {
      throw new Error(`${describeCombo(combo)} cannot beat ${this.lastPlay.description}`);
    }
    return combo;
  }

  pauseArena() {
    if (!this.isArenaMode) throw new Error("This is not an AI vs AI game");
    this.arenaPaused = true;
  }

  resumeArena() {
    if (!this.isArenaMode) throw new Error("This is not an AI vs AI game");
    if (this.phase === "complete") throw new Error("This Dou Dizhu hand is complete");
    this.arenaPaused = false;
  }

  recordAIInsight(seat, { summary, summarySource, explanation, latencyMs, action }) {
    const player = this.players[seat];
    this.aiInsights.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      handNumber: this.handNumber,
      phase: this.phase,
      seat,
      playerName: player.name,
      characterColor: player.character?.color ?? "#d7b66a",
      model: player.aiConfig?.model ?? "human",
      reasoningEffort: player.aiConfig?.reasoningEffort ?? "",
      summary: String(summary ?? "").trim(),
      summarySource: String(summarySource ?? ""),
      explanation: String(explanation ?? "").trim(),
      latencyMs: Math.round(latencyMs),
      action: String(action ?? ""),
      at: new Date().toISOString(),
    });
    this.aiInsights = this.aiInsights.slice(-200);
  }

  recordAIRetry(seat, message, retryNumber, maxRetries) {
    const player = this.players[seat];
    this._log(
      "system",
      `${player.name}'s rejected model play was not made. Retrying automatically (${retryNumber}/${maxRetries}): ${message}`,
      { seat, retryNumber, maxRetries },
    );
  }

  setAIError(seat, message) {
    this.aiThinking = null;
    const player = this.players[seat];
    this.aiError = { seat, message, playerName: player?.name ?? "AI player" };
    this._log("error", `${this.aiError.playerName}'s model request paused: ${message}`, { seat });
  }

  clearAIError() {
    this.aiError = null;
  }

  aiSnapshot() {
    const actor = this.currentActor;
    if (!actor || actor.isHuman) throw new Error("No AI Dou Dizhu player is currently acting");
    return {
      game: "Dou Dizhu",
      phase: this.phase,
      handNumber: this.handNumber,
      actor: {
        seat: actor.seat,
        name: actor.name,
        title: actor.character.title,
        personality: actor.character.personality,
        hand: [...actor.hand],
        handByRank: handByRankSummary(actor.hand),
        exampleLeads: this.phase === "playing" ? exampleLeads(actor.hand) : [],
        isLandlord: actor.seat === this.landlordSeat,
      },
      table: {
        landlordSeat: this.landlordSeat,
        currentBid: this.highestBid,
        highestBidderSeat: this.highestBidderSeat,
        bottomCards: [...this.bottomCards],
        players: this.players.map((player) => ({
          seat: player.seat,
          name: player.name,
          title: player.character?.title ?? "House guest",
          personality: player.character?.personality ?? "Human guest",
          cardCount: player.hand.length,
          isLandlord: player.seat === this.landlordSeat,
          bid: player.bid,
          lastAction: player.lastAction,
        })),
      },
      play: {
        leading: this.leaderSeat === actor.seat || !this.lastPlay,
        lastPlay: this.lastPlay
          ? {
              seat: this.lastPlay.seat,
              cards: [...this.lastPlay.cards],
              comboType: this.lastPlay.combo.type,
              description: this.lastPlay.description,
            }
          : null,
        mustBeat: this.lastPlay
          ? {
              comboType: this.lastPlay.combo.type,
              mainRank: this.lastPlay.combo.mainRank,
              length: this.lastPlay.combo.length,
              description: this.lastPlay.description,
            }
          : null,
      },
      rules: {
        rankOrder: "3 < 4 < 5 < 6 < 7 < 8 < 9 < 10 < J < Q < K < A < 2 < SJ (small joker) < BJ (big joker)",
        cardCodes: "A card is its rank followed by its suit (C, D, H, S), for example 3C, TD, AH, 2S. Jokers are SJ and BJ.",
        combos: "single, pair, triple, triple+single, triple+pair, straight (5+ consecutive ranks, 3 through A), pair straight (3+ consecutive pairs), airplane (2+ consecutive triples, optionally with the same number of wing cards; wings may be singles or pairs but must not be both jokers), four+two singles (the two singles may share a rank; never both jokers), four+two pairs (8 cards), bomb (four of a kind), rocket (both jokers).",
        following: "A non-leading player must play the same combo type with the same length but a higher main rank, or any bomb, or the rocket. Bombs beat any non-bomb. A higher bomb beats a lower bomb. The rocket beats everything. The leading player chooses any combo freely.",
      },
      recentPlays: this.logs.filter((entry) => entry.kind === "play" || entry.kind === "bid").slice(-16).map((entry) => entry.text),
    };
  }

  publicState() {
    const revealAll = this.isArenaMode;
    const aiConfigs = this.players.filter((player) => !player.isHuman).map((player) => player.aiConfig);
    const models = new Set(aiConfigs.map((config) => config.model));
    const efforts = new Set(aiConfigs.map((config) => config.reasoningEffort));
    const actor = this.currentActor;
    return {
      gameId: "doudizhu",
      gameMode: this.gameMode,
      phase: this.phase,
      handNumber: this.handNumber,
      currentActorSeat: this.currentActorSeat,
      landlordSeat: this.landlordSeat,
      highestBid: this.highestBid,
      highestBidderSeat: this.highestBidderSeat,
      bottomCards: [...this.bottomCards],
      bottomRevealed: this.phase !== "bidding" || this.landlordSeat !== null,
      lastPlay: this.lastPlay,
      leaderSeat: this.leaderSeat,
      bombsPlayed: this.bombsPlayed,
      multiplier: 2 ** this.bombsPlayed,
      result: this.result,
      arena: this.isArenaMode ? { paused: this.arenaPaused } : null,
      model: models.size === 1 ? aiConfigs[0].model : "mixed",
      reasoningEffort: efforts.size === 1 ? aiConfigs[0].reasoningEffort : "mixed",
      noLocalFallback: true,
      aiThinking: this.aiThinking,
      aiError: this.aiError,
      aiInsights: [...this.aiInsights].reverse(),
      players: this.players.map((player) => ({
        seat: player.seat,
        name: player.name,
        isHuman: player.isHuman,
        character: player.character,
        aiConfig: player.aiConfig,
        cardCount: player.hand.length,
        hand: player.isHuman || revealAll ? [...player.hand] : [],
        bid: player.bid,
        lastAction: player.lastAction,
        isLandlord: player.seat === this.landlordSeat,
      })),
      humanCanAct: this.phase !== "complete" && Boolean(actor?.isHuman) && !this.aiError,
      humanCanPass: Boolean(actor?.isHuman) && this.phase === "playing" && this.leaderSeat !== actor.seat && Boolean(this.lastPlay) && !this.aiError,
      logs: [...this.logs].reverse(),
    };
  }
}
