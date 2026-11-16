import { createDeck, shuffleDeck } from "./cards.js";
import { resolveSidePots } from "./hand-evaluator.js";
import { AI_CHARACTERS } from "./platform/characters.js";
import { seatCharacters } from "./platform/seating.js";
import { normalizeModelConfig } from "./platform/model-registry.js";

export const BOT_CHARACTERS = AI_CHARACTERS;

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normalizeArenaHandTarget(value) {
  if (value === null || value === 0 || String(value).toLowerCase() === "unlimited") return null;
  return clampInteger(value, 1, 100, 10);
}

export class PokerGame {
  constructor(config = {}) {
    const opponentCount = clampInteger(config.opponentCount, 2, 5, 3);
    this.gameMode = config.gameMode === "arena" ? "arena" : "human";
    this.arenaHandTarget = this.gameMode === "arena" ? normalizeArenaHandTarget(config.arenaHandTarget) : null;
    this.arenaPaused = this.gameMode === "arena" && Boolean(config.arenaPaused);
    this.arenaFinished = false;
    this.completedHands = 0;
    this.startingStack = clampInteger(config.startingStack, 200, 100_000, 1_000);
    this.smallBlind = clampInteger(config.smallBlind, 1, 10_000, 10);
    this.bigBlind = clampInteger(config.bigBlind, this.smallBlind * 2, 20_000, 20);
    if (this.smallBlind >= this.bigBlind) this.smallBlind = Math.max(1, Math.floor(this.bigBlind / 2));

    const configuredAIPlayers = Array.isArray(config.aiPlayers) ? config.aiPlayers : [];
    const aiConfigAt = (index) => normalizeModelConfig("holdem", configuredAIPlayers[index] ?? config);
    const cast = seatCharacters(opponentCount, configuredAIPlayers.map((player) => player?.characterId));

    if (this.gameMode === "arena") {
      this.players = cast.map((character, index) =>
        this._makePlayer(index, character.name, false, character, aiConfigAt(index)),
      );
    } else {
      const humanName = String(config.humanName ?? "You").trim().slice(0, 18) || "You";
      this.players = [
        this._makePlayer(0, humanName, true, null),
        ...cast.map((character, index) =>
          this._makePlayer(index + 1, character.name, false, character, aiConfigAt(index)),
        ),
      ];
    }

    this.handNumber = 0;
    this.dealerSeat = -1;
    this.smallBlindSeat = null;
    this.bigBlindSeat = null;
    this.currentActorSeat = null;
    this.currentBet = 0;
    this.minimumRaise = this.bigBlind;
    this.pendingSeats = new Set();
    this.communityCards = [];
    this.deck = [];
    this.phase = "waiting";
    this.logs = [];
    this.aiInsights = [];
    this.aiError = null;
    this.aiThinking = null;
    this.lastShowdown = null;
    this._log(
      "system",
      this.gameMode === "arena"
        ? `The AI arena opens with ${opponentCount} guests at the table.`
        : `Welcome to Salon Riviera. ${opponentCount} guests have taken their seats.`,
    );
    this.startNewHand();
  }

  _makePlayer(seat, name, isHuman, character, aiConfig = null) {
    return {
      seat,
      name,
      isHuman,
      character,
      aiConfig,
      stack: this.startingStack,
      holeCards: [],
      streetBet: 0,
      totalCommitted: 0,
      folded: false,
      allIn: false,
      inHand: false,
      hasShown: false,
      lastAction: "",
      lastReasoningSummary: "",
      lastSummarySource: "",
      lastExplanation: "",
      lastLatencyMs: null,
    };
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
    this.logs = this.logs.slice(-100);
  }

  get potTotal() {
    return this.players.reduce((total, player) => total + player.totalCommitted, 0);
  }

  get currentActor() {
    return this.currentActorSeat === null ? null : this.players[this.currentActorSeat];
  }

  get isArenaMode() {
    return this.gameMode === "arena";
  }

  livePlayers() {
    return this.players.filter((player) => player.stack > 0);
  }

  contestingPlayers() {
    return this.players.filter((player) => player.inHand && !player.folded);
  }

  activePlayers() {
    return this.players.filter((player) => player.inHand && !player.folded && !player.allIn && player.stack > 0);
  }

  _nextSeat(startSeat, predicate) {
    for (let offset = 1; offset <= this.players.length; offset += 1) {
      const seat = (startSeat + offset + this.players.length) % this.players.length;
      if (predicate(this.players[seat])) return seat;
    }
    return null;
  }

  _nextLiveSeat(startSeat) {
    return this._nextSeat(startSeat, (player) => player.stack > 0);
  }

  _nextPendingSeat(startSeat) {
    return this._nextSeat(
      startSeat,
      (player) => this.pendingSeats.has(player.seat) && player.inHand && !player.folded && !player.allIn && player.stack > 0,
    );
  }

  startNewHand() {
    if (!["waiting", "hand_over"].includes(this.phase)) throw new Error("The current hand is still in progress");
    if (this.isArenaMode && this.arenaFinished) throw new Error("This AI Arena session is complete");
    if (this.livePlayers().length < 2) {
      this.phase = "game_over";
      this.currentActorSeat = null;
      if (this.isArenaMode) {
        this.arenaPaused = true;
        this.arenaFinished = true;
      }
      return;
    }

    this.handNumber += 1;
    this.dealerSeat = this._nextLiveSeat(this.dealerSeat);
    this.communityCards = [];
    this.currentBet = 0;
    this.minimumRaise = this.bigBlind;
    this.pendingSeats = new Set();
    this.aiError = null;
    this.aiThinking = null;
    this.lastShowdown = null;
    this.phase = "preflop";
    this.deck = shuffleDeck(createDeck());

    for (const player of this.players) {
      player.holeCards = [];
      player.streetBet = 0;
      player.totalCommitted = 0;
      player.folded = false;
      player.allIn = false;
      player.inHand = player.stack > 0;
      player.hasShown = false;
      player.lastAction = "";
      player.lastReasoningSummary = "";
      player.lastSummarySource = "";
      player.lastExplanation = "";
      player.lastLatencyMs = null;
    }

    const live = this.livePlayers();
    if (live.length === 2) {
      this.smallBlindSeat = this.dealerSeat;
      this.bigBlindSeat = this._nextLiveSeat(this.dealerSeat);
    } else {
      this.smallBlindSeat = this._nextLiveSeat(this.dealerSeat);
      this.bigBlindSeat = this._nextLiveSeat(this.smallBlindSeat);
    }

    let dealSeat = this.dealerSeat;
    for (let round = 0; round < 2; round += 1) {
      for (let dealt = 0; dealt < live.length; dealt += 1) {
        dealSeat = this._nextLiveSeat(dealSeat);
        this.players[dealSeat].holeCards.push(this.deck.pop());
      }
    }

    this._postBlind(this.smallBlindSeat, this.smallBlind, "small blind");
    this._postBlind(this.bigBlindSeat, this.bigBlind, "big blind");
    this.currentBet = Math.max(...this.players.map((player) => player.streetBet));
    this.minimumRaise = this.bigBlind;

    const firstToAct = live.length === 2 ? this.dealerSeat : this._nextSeat(this.bigBlindSeat, (player) => player.inHand && !player.allIn);
    this._beginBettingRound(firstToAct);
    this._log("hand", `Hand ${this.handNumber} begins. ${this.players[this.dealerSeat].name} has the button.`);
    this._settleIfNoActionPossible();
  }

  _postBlind(seat, amount, label) {
    const player = this.players[seat];
    const committed = Math.min(amount, player.stack);
    this._commit(player, committed, player.streetBet + committed);
    player.lastAction = `${label} ${committed}`;
    this._log("action", `${player.name} posts ${label} ${committed}.`, { seat });
  }

  _beginBettingRound(firstToAct) {
    // The bet each seat last acted against this street; see _raiseReopenedFor.
    this.actedAtBet = new Map();
    this.pendingSeats = new Set(this.activePlayers().map((player) => player.seat));
    if (firstToAct !== null && this.pendingSeats.has(firstToAct)) {
      this.currentActorSeat = firstToAct;
    } else {
      this.currentActorSeat = firstToAct === null ? null : this._nextPendingSeat(firstToAct - 1);
    }
  }

  _cleanPendingSeats() {
    for (const seat of [...this.pendingSeats]) {
      const player = this.players[seat];
      if (!player.inHand || player.folded || player.allIn || player.stack <= 0) this.pendingSeats.delete(seat);
    }
  }

  /**
   * A player who already acted this street may raise again only if the bet has grown by at least a
   * full raise since then. An all-in for less than a full raise does not reopen the betting for them:
   * they may only call or fold (standard no-limit rule; several short all-ins can add up to a full raise).
   */
  _raiseReopenedFor(player) {
    const actedAt = this.actedAtBet?.get(player.seat);
    return actedAt === undefined || this.currentBet - actedAt >= this.minimumRaise;
  }

  legalActionsFor(player = this.currentActor) {
    if (!player || player.seat !== this.currentActorSeat || !player.inHand || player.folded || player.allIn) return null;
    const toCall = Math.max(0, this.currentBet - player.streetBet);
    const callAmount = Math.min(toCall, player.stack);
    const maxTotal = player.streetBet + player.stack;
    const mayRaise = this._raiseReopenedFor(player);
    const actions = [];
    if (toCall > 0) actions.push("fold", "call");
    else actions.push("check");

    let aggressiveAction = null;
    let minimumTotal = null;
    if (!mayRaise) {
      // Betting is closed to this player; going all-in is allowed only as a call.
    } else if (this.currentBet === 0 && player.stack > 0 && maxTotal >= this.bigBlind) {
      aggressiveAction = "bet";
      minimumTotal = this.bigBlind;
      actions.push("bet");
    } else if (this.currentBet > 0 && maxTotal >= this.currentBet + this.minimumRaise) {
      aggressiveAction = "raise";
      minimumTotal = this.currentBet + this.minimumRaise;
      actions.push("raise");
    }
    if (player.stack > 0 && (mayRaise || player.stack <= toCall)) actions.push("all_in");

    return {
      actions: [...new Set(actions)],
      toCall,
      callAmount,
      aggressiveAction,
      minimumTotal,
      maximumTotal: maxTotal,
      allInTotal: maxTotal,
    };
  }

  applyAction(seat, action, targetTotal = null) {
    if (this.aiError) throw new Error("Resolve or retry the AI error before continuing");
    if (seat !== this.currentActorSeat) throw new Error("That player is not currently acting");
    const player = this.players[seat];
    const legal = this.legalActionsFor(player);
    if (!legal || !legal.actions.includes(action)) throw new Error(`${action} is not legal here`);

    const previousCurrentBet = this.currentBet;
    const previousStreetBet = player.streetBet;
    let committed = 0;
    let fullRaise = false;
    let actionText = "";

    if (action === "fold") {
      player.folded = true;
      player.lastAction = "Fold";
      actionText = `${player.name} folds.`;
    } else if (action === "check") {
      player.lastAction = "Check";
      actionText = `${player.name} checks.`;
    } else if (action === "call") {
      committed = legal.callAmount;
      this._commit(player, committed, previousStreetBet + committed);
      player.lastAction = player.allIn ? `Call all-in ${committed}` : `Call ${committed}`;
      actionText = `${player.name} ${player.allIn ? "calls all-in for" : "calls"} ${committed}.`;
    } else if (action === "bet" || action === "raise") {
      const total = Number.parseInt(targetTotal, 10);
      if (!Number.isInteger(total) || total < legal.minimumTotal || total > legal.maximumTotal) {
        throw new Error(`Target total must be between ${legal.minimumTotal} and ${legal.maximumTotal}`);
      }
      committed = total - previousStreetBet;
      this._commit(player, committed, total);
      const raiseSize = total - previousCurrentBet;
      fullRaise = true;
      this.currentBet = total;
      this.minimumRaise = previousCurrentBet === 0 ? Math.max(this.bigBlind, total) : raiseSize;
      player.lastAction = `${action === "bet" ? "Bet" : "Raise"} ${total}`;
      actionText = `${player.name} ${action === "bet" ? "bets" : "raises to"} ${total}.`;
    } else if (action === "all_in") {
      const total = legal.allInTotal;
      committed = total - previousStreetBet;
      this._commit(player, committed, total);
      if (total > previousCurrentBet) {
        const raiseSize = total - previousCurrentBet;
        fullRaise = previousCurrentBet === 0 ? total >= this.bigBlind : raiseSize >= this.minimumRaise;
        this.currentBet = total;
        if (fullRaise) this.minimumRaise = previousCurrentBet === 0 ? Math.max(this.bigBlind, total) : raiseSize;
      }
      player.lastAction = `All-in ${total}`;
      actionText = `${player.name} moves all-in to ${total}.`;
    }

    this.pendingSeats.delete(seat);
    this.actedAtBet.set(seat, this.currentBet);
    if (fullRaise) {
      this.pendingSeats = new Set(this.activePlayers().filter((other) => other.seat !== seat).map((other) => other.seat));
    } else if (this.currentBet > previousCurrentBet) {
      for (const other of this.activePlayers()) {
        if (other.seat !== seat && other.streetBet < this.currentBet) this.pendingSeats.add(other.seat);
      }
    }

    this._log("action", actionText, { seat, action, committed, targetTotal: player.streetBet });
    this._cleanPendingSeats();
    this._advanceAfterAction(seat);
    return { action, committed, targetTotal: player.streetBet, text: actionText };
  }

  _commit(player, amount, total) {
    if (amount < 0 || amount > player.stack) throw new Error("Invalid chip commitment");
    player.stack -= amount;
    player.streetBet = total;
    player.totalCommitted += amount;
    player.allIn = player.stack === 0;
  }

  _advanceAfterAction(previousSeat) {
    const contesting = this.contestingPlayers();
    if (contesting.length === 1) {
      this._awardUncontested(contesting[0]);
      return;
    }

    this._cleanPendingSeats();
    if (this.pendingSeats.size === 0) {
      this._advanceStreet();
      return;
    }
    this.currentActorSeat = this._nextPendingSeat(previousSeat);
    if (this.currentActorSeat === null) this._advanceStreet();
  }

  _settleIfNoActionPossible() {
    if (this.contestingPlayers().length <= 1) return;
    this._cleanPendingSeats();
    if (this.activePlayers().length <= 1 && this.pendingSeats.size === 0) this._runOutAndShowdown();
  }

  _advanceStreet() {
    if (this.phase === "river") {
      this._resolveShowdown();
      return;
    }

    for (const player of this.players) player.streetBet = 0;
    this.currentBet = 0;
    this.minimumRaise = this.bigBlind;

    if (this.phase === "preflop") {
      this.phase = "flop";
      this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else if (this.phase === "flop") {
      this.phase = "turn";
      this.communityCards.push(this.deck.pop());
    } else if (this.phase === "turn") {
      this.phase = "river";
      this.communityCards.push(this.deck.pop());
    }
    this._log("street", `${this.phase[0].toUpperCase()}${this.phase.slice(1)}: ${this.communityCards.join(" ")}.`);

    if (this.activePlayers().length <= 1) {
      this._runOutAndShowdown();
      return;
    }
    const first = this._nextSeat(this.dealerSeat, (player) => player.inHand && !player.folded && !player.allIn && player.stack > 0);
    this._beginBettingRound(first);
  }

  _runOutAndShowdown() {
    while (this.communityCards.length < 5) {
      if (this.communityCards.length === 0) {
        this.phase = "flop";
        this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      } else if (this.communityCards.length === 3) {
        this.phase = "turn";
        this.communityCards.push(this.deck.pop());
      } else {
        this.phase = "river";
        this.communityCards.push(this.deck.pop());
      }
      this._log("street", `${this.phase[0].toUpperCase()}${this.phase.slice(1)}: ${this.communityCards.join(" ")}.`);
    }
    this._resolveShowdown();
  }

  _resolveShowdown() {
    this.phase = "showdown";
    this.currentActorSeat = null;
    this.pendingSeats.clear();
    for (const player of this.contestingPlayers()) player.hasShown = true;

    const result = resolveSidePots(this.players, this.communityCards, this.dealerSeat);
    for (const [seatText, amount] of Object.entries(result.payouts)) {
      const seat = Number(seatText);
      if (amount > 0) this.players[seat].stack += amount;
    }
    for (const pot of result.pots) {
      const names = pot.winners.map((seat) => this.players[seat].name).join(" & ");
      this._log("result", `${names} win${pot.winners.length === 1 ? "s" : ""} ${pot.amount} with ${pot.description}.`, {
        winners: pot.winners,
        amount: pot.amount,
      });
    }
    this.lastShowdown = {
      pots: result.pots,
      evaluations: Object.fromEntries(
        [...result.evaluations.entries()].map(([seat, evaluation]) => [seat, evaluation.description]),
      ),
    };
    this._finishHand();
  }

  _awardUncontested(winner) {
    const amount = this.potTotal;
    winner.stack += amount;
    this._log("result", `${winner.name} wins ${amount} uncontested.`, { winners: [winner.seat], amount });
    this.lastShowdown = { pots: [{ amount, winners: [winner.seat], description: "Uncontested" }], evaluations: {} };
    this._finishHand();
  }

  _finishHand() {
    this.currentActorSeat = null;
    this.pendingSeats.clear();
    this.aiThinking = null;
    for (const player of this.players) {
      player.streetBet = 0;
      player.totalCommitted = 0;
      player.allIn = false;
      if (player.stack <= 0) player.inHand = false;
    }
    this.completedHands += 1;
    if (this.livePlayers().length < 2) {
      this.phase = "game_over";
      const winner = this.players.reduce((best, player) => (player.stack > best.stack ? player : best), this.players[0]);
      this._log("result", `${winner.name} owns Salon Riviera.`);
    } else {
      this.phase = "hand_over";
    }
    if (this.isArenaMode && (this.phase === "game_over" || (this.arenaHandTarget !== null && this.completedHands >= this.arenaHandTarget))) {
      this.arenaPaused = true;
      this.arenaFinished = true;
      if (this.phase !== "game_over") {
        this._log("system", `AI Arena target reached after ${this.completedHands} hand${this.completedHands === 1 ? "" : "s"}.`);
      }
    }
  }

  pauseArena() {
    if (!this.isArenaMode) throw new Error("This table is not running in AI Arena mode");
    this.arenaPaused = true;
  }

  resumeArena() {
    if (!this.isArenaMode) throw new Error("This table is not running in AI Arena mode");
    if (this.arenaFinished) throw new Error("This AI Arena session is complete");
    this.arenaPaused = false;
  }

  recordAIInsight(seat, { summary, summarySource, explanation, latencyMs, action = "" }) {
    const player = this.players[seat];
    player.lastReasoningSummary = String(summary ?? "").trim();
    player.lastSummarySource = String(summarySource ?? "");
    player.lastExplanation = String(explanation ?? "").trim();
    player.lastLatencyMs = Math.round(latencyMs);
    this.aiInsights.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      handNumber: this.handNumber,
      phase: this.phase,
      seat,
      playerName: player.name,
      characterColor: player.character?.color ?? "#d7b66a",
      characterId: player.character?.id ?? null,
      action: String(action ?? ""),
      summary: player.lastReasoningSummary,
      summarySource: player.lastSummarySource,
      explanation: player.lastExplanation,
      latencyMs: player.lastLatencyMs,
      at: new Date().toISOString(),
    });
    this.aiInsights = this.aiInsights.slice(-200);
  }

  setAIError(seat, message) {
    this.aiThinking = null;
    this.aiError = { seat, message, playerName: this.players[seat]?.name ?? "AI player" };
    this._log("error", `${this.aiError.playerName}'s model request paused: ${message}`, { seat });
  }

  clearAIError() {
    this.aiError = null;
  }

  aiSnapshot() {
    const actor = this.currentActor;
    if (!actor || actor.isHuman) throw new Error("No AI player is currently acting");
    const legal = this.legalActionsFor(actor);
    return {
      handNumber: this.handNumber,
      phase: this.phase,
      actor: {
        seat: actor.seat,
        name: actor.name,
        title: actor.character.title,
        personality: actor.character.personality,
        voice: actor.character.voice ?? "",
        model: actor.aiConfig.model,
        reasoningEffort: actor.aiConfig.reasoningEffort,
        stack: actor.stack,
        holeCards: actor.holeCards,
        streetBet: actor.streetBet,
        totalCommitted: actor.totalCommitted,
      },
      table: {
        dealerSeat: this.dealerSeat,
        smallBlind: this.smallBlind,
        bigBlind: this.bigBlind,
        pot: this.potTotal,
        currentBet: this.currentBet,
        communityCards: this.communityCards,
        players: this.players.map((player) => ({
          seat: player.seat,
          name: player.name,
          title: player.character?.title ?? "House guest",
          personality: player.character?.personality ?? "Human guest",
          stack: player.stack,
          streetBet: player.streetBet,
          totalCommitted: player.totalCommitted,
          folded: player.folded,
          allIn: player.allIn,
          inHand: player.inHand,
          lastAction: player.lastAction,
        })),
      },
      legal,
      recentActions: this.logs.filter((entry) => entry.handNumber === this.handNumber).slice(-12).map((entry) => entry.text),
    };
  }

  publicState() {
    const actor = this.currentActor;
    const humanLegal = actor?.isHuman ? this.legalActionsFor(actor) : null;
    const aiConfigs = this.players.filter((player) => !player.isHuman).map((player) => player.aiConfig);
    const modelNames = new Set(aiConfigs.map((config) => config.model));
    const efforts = new Set(aiConfigs.map((config) => config.reasoningEffort));
    return {
      tableTalk: this.tableTalk ?? [],
      model: modelNames.size === 1 ? aiConfigs[0].model : "mixed",
      reasoningEffort: efforts.size === 1 ? aiConfigs[0].reasoningEffort : "mixed",
      noLocalFallback: true,
      gameMode: this.gameMode,
      arena: this.isArenaMode
        ? {
            paused: this.arenaPaused,
            finished: this.arenaFinished,
            handTarget: this.arenaHandTarget,
            handsPlayed: this.completedHands,
          }
        : null,
      handNumber: this.handNumber,
      phase: this.phase,
      pot: this.potTotal,
      currentBet: this.currentBet,
      communityCards: [...this.communityCards],
      dealerSeat: this.dealerSeat,
      smallBlindSeat: this.smallBlindSeat,
      bigBlindSeat: this.bigBlindSeat,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      currentActorSeat: this.currentActorSeat,
      legalActions: humanLegal,
      aiError: this.aiError,
      aiThinking: this.aiThinking,
      aiInsights: [...this.aiInsights].reverse(),
      canStartNextHand: this.phase === "hand_over",
      players: this.players.map((player) => {
        const revealCards = this.isArenaMode || player.isHuman || player.hasShown;
        return {
          seat: player.seat,
          name: player.name,
          isHuman: player.isHuman,
          character: player.character,
          aiConfig: player.aiConfig,
          stack: player.stack,
          streetBet: player.streetBet,
          totalCommitted: player.totalCommitted,
          folded: player.folded,
          allIn: player.allIn,
          inHand: player.inHand,
          hasShown: player.hasShown,
          lastAction: player.lastAction,
          holeCards: revealCards ? [...player.holeCards] : player.holeCards.map(() => "BACK"),
          cardCount: player.holeCards.length,
          lastReasoningSummary: player.lastReasoningSummary,
          lastSummarySource: player.lastSummarySource,
          lastExplanation: player.lastExplanation,
          lastLatencyMs: player.lastLatencyMs,
        };
      }),
      logs: [...this.logs].reverse(),
      lastShowdown: this.lastShowdown,
    };
  }
}
