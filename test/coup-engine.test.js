import test from "node:test";
import assert from "node:assert/strict";
import {
  CARDS,
  CoupRuleError,
  applyAction,
  awaitingSeats,
  checkInvariants,
  createCoupGame,
  getLegalActions,
  liveCards,
  publicView,
  restoreCoupGame,
  revealedCards,
  serializeCoupGame,
  validateAction,
} from "../src/games/coup/engine.js";

const NAMES = ["Ada", "Bo", "Cy", "Di", "Ed", "Fay"];

function newGame(deal, { startingSeat = 0, seed = 7, coins = null } = {}) {
  let state = createCoupGame({ players: NAMES.slice(0, deal.length), deal, startingSeat, seed });
  if (coins) {
    state = structuredClone(state);
    coins.forEach((amount, seat) => {
      if (amount !== null && amount !== undefined) state.players[seat].coins = amount;
    });
  }
  return state;
}

function act(state, seat, action) {
  const next = applyAction(state, seat, action);
  assert.deepEqual(checkInvariants(next), [], `invariants after ${JSON.stringify(action)}`);
  return next;
}

function passAll(state) {
  let next = state;
  for (const seat of awaitingSeats(state)) next = act(next, seat, { type: "pass" });
  return next;
}

const THREE = [["Duke", "Captain"], ["Assassin", "Contessa"], ["Ambassador", "Duke"]];

test("creates 2-6 player games with two cards and two coins each", () => {
  for (let count = 2; count <= 6; count += 1) {
    const state = createCoupGame({ playerCount: count, seed: count });
    assert.equal(state.players.length, count);
    assert.ok(state.players.every((player) => player.influence.length === 2 && liveCards(player).length === 2));
    assert.equal(state.deck.length, 15 - count * 2);
    assert.equal(state.phase, "action");
    assert.deepEqual(checkInvariants(state), []);
    const expectedCoins = state.players.map((player) => (count === 2 && player.seat === state.activeSeat ? 1 : 2));
    assert.deepEqual(state.players.map((player) => player.coins), expectedCoins);
  }
  assert.throws(() => createCoupGame({ playerCount: 1 }), CoupRuleError);
  assert.throws(() => createCoupGame({ playerCount: 7 }), /2-6 players/);
  assert.throws(() => createCoupGame({ players: ["A", "B"], deal: [["Duke", "Duke"], ["Duke", "Duke"]] }), /more Duke/);
});

test("the starting player in a two-player game begins with one coin", () => {
  const state = createCoupGame({ players: ["A", "B"], startingSeat: 1, seed: 1 });
  assert.equal(state.players[1].coins, 1);
  assert.equal(state.players[0].coins, 2);
});

test("a seed reproduces the same game and an injected rng is honoured", () => {
  const first = createCoupGame({ playerCount: 4, seed: 42 });
  const second = createCoupGame({ playerCount: 4, seed: 42 });
  assert.deepEqual(first, second);
  const injected = createCoupGame({ playerCount: 4, seed: 1, rng: () => 0 });
  const injectedAgain = createCoupGame({ playerCount: 4, seed: 99, rng: () => 0 });
  assert.deepEqual(injected.players, injectedAgain.players);
  assert.equal(injected.activeSeat, 0);
});

test("applyAction never mutates the input state", () => {
  const state = newGame(THREE);
  const snapshot = structuredClone(state);
  act(state, 0, { type: "tax" });
  assert.deepEqual(state, snapshot);
});

test("income gives one coin at once and passes the turn", () => {
  let state = newGame(THREE);
  state = act(state, 0, { type: "income" });
  assert.equal(state.players[0].coins, 3);
  assert.equal(state.phase, "action");
  assert.equal(state.activeSeat, 1);
  assert.equal(state.turn, 2);
});

test("only the awaited seat may act, with a precise error", () => {
  const state = newGame(THREE);
  assert.throws(() => applyAction(state, 1, { type: "income" }), /cannot act now.*waiting on seat\(s\) 0/);
  assert.deepEqual(getLegalActions(state, 1), []);
  assert.match(validateAction(state, 0, { type: "fly" }), /Unknown action "fly"/);
  assert.match(validateAction(state, 0, null), /must be an object/);
  assert.match(validateAction(state, 0, { type: "income", target: 1 }), /does not take a target/);
});

test("foreign aid cannot be challenged; any other player may block it with Duke", () => {
  let state = newGame(THREE);
  state = act(state, 0, { type: "foreign_aid" });
  assert.equal(state.phase, "block");
  assert.deepEqual(awaitingSeats(state), [1, 2]);
  assert.deepEqual(getLegalActions(state, 1), [{ type: "pass" }, { type: "block", card: "Duke" }]);
  assert.match(validateAction(state, 1, { type: "block", card: "Contessa" }), /only be blocked by claiming Duke/);
  assert.match(validateAction(state, 1, { type: "challenge" }), /may only "pass" or "block"/);
  state = passAll(state);
  assert.equal(state.players[0].coins, 4);
  assert.equal(state.activeSeat, 1);
});

test("an unchallenged Duke block stops foreign aid", () => {
  let state = newGame(THREE);
  state = act(state, 0, { type: "foreign_aid" });
  state = act(state, 1, { type: "block", card: "Duke" });
  assert.equal(state.phase, "challenge_block");
  assert.deepEqual(awaitingSeats(state), [0, 2], "everyone except the blocker may challenge");
  state = passAll(state);
  assert.equal(state.players[0].coins, 2);
  assert.equal(state.phase, "action");
  assert.equal(state.activeSeat, 1);
  assert.ok(state.log.some((entry) => entry.kind === "block_stands"));
});

test("a bluffed block that is challenged collapses and the action resolves", () => {
  let state = newGame(THREE);
  state = act(state, 0, { type: "foreign_aid" });
  state = act(state, 1, { type: "block", card: "Duke" }); // seat 1 holds Assassin + Contessa
  state = act(state, 2, { type: "challenge" });
  assert.equal(state.phase, "lose_influence");
  assert.equal(state.lossPending.seat, 1);
  assert.equal(state.lossPending.reason, "caught_bluffing");
  state = act(state, 1, { type: "reveal", card: "Assassin" });
  assert.deepEqual(revealedCards(state.players[1]), ["Assassin"]);
  assert.equal(state.players[0].coins, 4);
  assert.equal(state.activeSeat, 1);
});

test("a true block survives a challenge: the blocker swaps the card and the challenger loses", () => {
  let state = newGame(THREE);
  state = act(state, 0, { type: "foreign_aid" });
  state = act(state, 2, { type: "block", card: "Duke" }); // seat 2 holds Duke
  assert.deepEqual(awaitingSeats(state), [0, 1]);
  state = act(state, 0, { type: "challenge" });
  assert.equal(state.phase, "lose_influence");
  assert.equal(state.lossPending.seat, 0);
  state = act(state, 0, { type: "reveal", card: "Captain" });
  assert.equal(state.players[0].coins, 2, "the blocked action still fails");
  assert.equal(liveCards(state.players[2]).length, 2, "the blocker keeps two influence");
  const challengeLog = state.log.find((entry) => entry.kind === "challenge");
  assert.equal(challengeLog.success, false);
});

test("tax resolves after every opponent passes the challenge window", () => {
  let state = newGame(THREE);
  state = act(state, 0, { type: "tax" });
  assert.equal(state.phase, "challenge_action");
  assert.deepEqual(awaitingSeats(state), [1, 2]);
  state = act(state, 2, { type: "pass" });
  assert.deepEqual(awaitingSeats(state), [1]);
  assert.deepEqual(state.passed, [2]);
  assert.match(validateAction(state, 2, { type: "pass" }), /cannot act now/);
  state = act(state, 1, { type: "pass" });
  assert.equal(state.players[0].coins, 5);
  assert.equal(state.activeSeat, 1);
});

test("a truthful tax claim beats a challenge and the claimed card is replaced", () => {
  let state = newGame(THREE, { seed: 3 });
  state = act(state, 0, { type: "tax" });
  state = act(state, 1, { type: "challenge" });
  assert.equal(state.phase, "lose_influence");
  assert.deepEqual(getLegalActions(state, 1), [{ type: "reveal", card: "Assassin" }, { type: "reveal", card: "Contessa" }]);
  assert.match(validateAction(state, 1, { type: "reveal", card: "Duke" }), /no face-down Duke/);
  state = act(state, 1, { type: "reveal", card: "Contessa" });
  assert.equal(state.players[0].coins, 5, "the proven tax still resolves");
  assert.equal(liveCards(state.players[0]).length, 2);
  assert.equal(liveCards(state.players[0]).includes("Captain"), true);
});

test("a bluffed tax that is challenged gives no coins", () => {
  let state = newGame(THREE, { startingSeat: 1 });
  state = act(state, 1, { type: "tax" }); // seat 1 holds Assassin + Contessa
  state = act(state, 0, { type: "challenge" });
  assert.equal(state.lossPending.seat, 1);
  state = act(state, 1, { type: "reveal", card: "Contessa" });
  assert.equal(state.players[1].coins, 2);
  assert.equal(state.activeSeat, 2);
  assert.ok(state.log.some((entry) => entry.kind === "challenge" && entry.success === true));
});

test("identical face-down cards are lost automatically without a choice", () => {
  let state = newGame([["Duke", "Duke"], ["Captain", "Captain"]], { startingSeat: 0 });
  state = act(state, 0, { type: "steal", target: 1 });
  state = act(state, 1, { type: "challenge" });
  // Seat 0 holds no Captain: two identical Dukes means no choice to make.
  assert.equal(state.phase, "action");
  assert.deepEqual(revealedCards(state.players[0]), ["Duke"]);
});

test("assassination: pay three, the target may block with Contessa only", () => {
  let state = newGame(THREE, { coins: [3, 2, 2] });
  state = act(state, 0, { type: "assassinate", target: 2 });
  assert.equal(state.players[0].coins, 0, "coins are paid on declaration");
  state = passAll(state);
  assert.equal(state.phase, "block");
  assert.deepEqual(awaitingSeats(state), [2], "only the target may block an assassination");
  assert.deepEqual(getLegalActions(state, 2), [{ type: "pass" }, { type: "block", card: "Contessa" }]);
  state = act(state, 2, { type: "pass" });
  assert.equal(state.phase, "lose_influence");
  assert.equal(state.lossPending.seat, 2);
  assert.equal(state.lossPending.reason, "assassinated");
  state = act(state, 2, { type: "reveal", card: "Duke" });
  assert.deepEqual(liveCards(state.players[2]), ["Ambassador"]);
  assert.equal(state.activeSeat, 1);
});

test("assassination needs three coins and a living target other than yourself", () => {
  const state = newGame(THREE, { coins: [2, 2, 2] });
  assert.match(validateAction(state, 0, { type: "assassinate", target: 1 }), /costs 3 coins and you have 2/);
  const rich = newGame(THREE, { coins: [5, 2, 2] });
  assert.match(validateAction(rich, 0, { type: "assassinate", target: 0 }), /cannot target yourself/);
  assert.match(validateAction(rich, 0, { type: "assassinate", target: 9 }), /does not exist/);
  assert.match(validateAction(rich, 0, { type: "assassinate" }), /integer "target"/);
});

test("a Contessa block stops the assassination but the coins stay spent", () => {
  let state = newGame(THREE, { coins: [3, 2, 2] });
  state = act(state, 0, { type: "assassinate", target: 1 });
  state = passAll(state);
  state = act(state, 1, { type: "block", card: "Contessa" });
  state = passAll(state);
  assert.equal(state.players[0].coins, 0);
  assert.equal(liveCards(state.players[1]).length, 2);
  assert.equal(state.activeSeat, 1);
});

test("a caught Assassin bluff refunds the three coins", () => {
  let state = newGame(THREE, { coins: [3, 2, 2] });
  state = act(state, 0, { type: "assassinate", target: 1 }); // seat 0 holds Duke + Captain
  state = act(state, 1, { type: "challenge" });
  assert.equal(state.players[0].coins, 3);
  assert.equal(state.pendingAction.refunded, 3);
  state = act(state, 0, { type: "reveal", card: "Captain" });
  assert.equal(liveCards(state.players[1]).length, 2);
  assert.equal(state.activeSeat, 1);
});

test("a false Contessa block caught by a challenge costs the target both influence", () => {
  let state = newGame([["Assassin", "Duke"], ["Captain", "Ambassador"], ["Duke", "Contessa"]], { coins: [3, 2, 2] });
  state = act(state, 0, { type: "assassinate", target: 1 });
  state = passAll(state);
  state = act(state, 1, { type: "block", card: "Contessa" });
  state = act(state, 0, { type: "challenge" });
  state = act(state, 1, { type: "reveal", card: "Captain" }); // loss for the failed block
  // The block collapses and the assassination resolves: the last card goes automatically.
  assert.equal(liveCards(state.players[1]).length, 0);
  assert.deepEqual(state.eliminationOrder, [1]);
  assert.equal(state.players[1].coins, 0);
  assert.equal(state.activeSeat, 2, "eliminated seats are skipped");
});

test("a target who wrongly challenges a real Assassin can still block afterwards", () => {
  let state = newGame([["Assassin", "Duke"], ["Contessa", "Captain"], ["Duke", "Ambassador"]], { coins: [3, 2, 2] });
  state = act(state, 0, { type: "assassinate", target: 1 });
  state = act(state, 1, { type: "challenge" });
  state = act(state, 1, { type: "reveal", card: "Captain" });
  assert.equal(state.phase, "block");
  assert.deepEqual(awaitingSeats(state), [1]);
  state = act(state, 1, { type: "block", card: "Contessa" });
  state = passAll(state);
  assert.deepEqual(liveCards(state.players[1]), ["Contessa"]);
  assert.equal(state.activeSeat, 1);
});

test("a one-card target who loses a challenge to the Assassin is out and the game can end", () => {
  let state = newGame([["Assassin", "Duke"], ["Contessa", "Captain"]], { coins: [3, 2], startingSeat: 0 });
  state = structuredClone(state);
  state.players[1].influence[1].revealed = true; // seat 1 has only Contessa left
  state.eliminationOrder = [];
  state = act(state, 0, { type: "assassinate", target: 1 });
  state = act(state, 1, { type: "challenge" });
  assert.equal(state.phase, "game_over");
  assert.equal(state.result.winner, 0);
  assert.deepEqual(state.result.ranking, [{ seat: 0, place: 1, score: 1 }, { seat: 1, place: 2, score: 0 }]);
  assert.throws(() => applyAction(state, 0, { type: "income" }), (error) => error.code === "game_over");
  assert.deepEqual(getLegalActions(state, 0), []);
});

test("steal takes up to two coins and only the target may block with Captain or Ambassador", () => {
  let state = newGame(THREE, { coins: [2, 1, 0] });
  assert.match(validateAction(state, 0, { type: "steal", target: 2 }), /no coins to steal/);
  assert.ok(!getLegalActions(state, 0).some((action) => action.type === "steal" && action.target === 2));
  state = act(state, 0, { type: "steal", target: 1 });
  state = passAll(state);
  assert.deepEqual(awaitingSeats(state), [1]);
  assert.deepEqual(getLegalActions(state, 1), [{ type: "pass" }, { type: "block", card: "Captain" }, { type: "block", card: "Ambassador" }]);
  assert.match(validateAction(state, 1, { type: "block", card: "Contessa" }), /Captain or Ambassador/);
  state = act(state, 1, { type: "pass" });
  assert.equal(state.players[0].coins, 3);
  assert.equal(state.players[1].coins, 0);
  assert.equal(state.pendingAction, null);
  const resolved = state.log.find((entry) => entry.kind === "resolve" && entry.action === "steal");
  assert.equal(resolved.amount, 1);
});

test("an Ambassador block stops a steal", () => {
  let state = newGame(THREE, { coins: [2, 2, 4] });
  state = act(state, 0, { type: "steal", target: 2 });
  state = passAll(state);
  state = act(state, 2, { type: "block", card: "Ambassador" });
  state = passAll(state);
  assert.equal(state.players[0].coins, 2);
  assert.equal(state.players[2].coins, 4);
});

test("exchange draws two, keeps as many as the player has influence, returns the rest", () => {
  let state = newGame(THREE, { startingSeat: 2 });
  state = act(state, 2, { type: "exchange" });
  state = passAll(state);
  assert.equal(state.phase, "exchange");
  assert.equal(state.exchange.keepCount, 2);
  assert.equal(state.exchange.drawn.length, 2);
  const options = [...liveCards(state.players[2]), ...state.exchange.drawn];
  const legal = getLegalActions(state, 2);
  assert.ok(legal.length >= 1 && legal.length <= 6);
  assert.ok(legal.every((action) => action.type === "exchange_keep" && action.keep.length === 2));
  assert.match(validateAction(state, 2, { type: "exchange_keep", keep: ["Duke"] }), /Keep exactly 2/);
  const missing = CARDS.find((card) => !options.includes(card));
  assert.match(validateAction(state, 2, { type: "exchange_keep", keep: [missing, options[0]] }), /cannot keep/);
  const keep = [options[2], options[3]];
  state = act(state, 2, { type: "exchange_keep", keep });
  assert.deepEqual([...liveCards(state.players[2])].sort(), [...keep].sort());
  assert.equal(state.deck.length, 15 - 6);
  assert.equal(state.exchange, null);
  assert.equal(state.activeSeat, 0);
});

test("a one-influence player keeps one card in an exchange", () => {
  let state = newGame(THREE, { startingSeat: 2 });
  state = structuredClone(state);
  state.players[2].influence[0].revealed = true;
  state = act(state, 2, { type: "exchange" });
  state = passAll(state);
  assert.equal(state.exchange.keepCount, 1);
  assert.ok(getLegalActions(state, 2).every((action) => action.keep.length === 1));
  state = act(state, 2, getLegalActions(state, 2)[0]);
  assert.equal(liveCards(state.players[2]).length, 1);
});

test("coup costs seven, cannot be blocked or challenged, and is forced at ten coins", () => {
  let state = newGame(THREE, { coins: [6, 2, 2] });
  assert.match(validateAction(state, 0, { type: "coup", target: 1 }), /costs 7 coins and you have 6/);
  state = newGame(THREE, { coins: [7, 2, 2] });
  state = act(state, 0, { type: "coup", target: 1 });
  assert.equal(state.players[0].coins, 0);
  assert.equal(state.phase, "lose_influence", "no challenge or block window");
  state = act(state, 1, { type: "reveal", card: "Assassin" });
  assert.equal(state.activeSeat, 1);

  const forced = newGame(THREE, { coins: [10, 2, 2] });
  const legal = getLegalActions(forced, 0);
  assert.deepEqual(legal, [{ type: "coup", target: 1 }, { type: "coup", target: 2 }]);
  assert.match(validateAction(forced, 0, { type: "tax" }), /must launch a coup/);
});

test("eliminated players are skipped, cannot be targeted and the last survivor wins with a ranking", () => {
  let state = newGame(THREE, { coins: [7, 7, 2] });
  state = structuredClone(state);
  state.players[2].influence[0].revealed = true; // seat 2 down to one card
  state = act(state, 0, { type: "coup", target: 2 });
  assert.deepEqual(state.eliminationOrder, [2]);
  assert.match(validateAction(state, 1, { type: "coup", target: 2 }), /already out/);
  state = act(state, 1, { type: "coup", target: 0 });
  state = act(state, 0, { type: "reveal", card: "Duke" });
  assert.equal(state.activeSeat, 0, "seat 2 is skipped");
  state = act(state, 0, { type: "income" });
  state = structuredClone(state);
  state.players[1].coins = 7;
  state = act(state, 1, { type: "coup", target: 0 });
  assert.equal(state.phase, "game_over");
  assert.equal(state.result.winner, 1);
  assert.deepEqual(state.result.ranking.map((entry) => entry.seat), [1, 0, 2]);
  assert.deepEqual(state.result.ranking.map((entry) => entry.score), [2, 1, 0]);
});

test("in a three-player game a block may be challenged by the actor or the bystander", () => {
  let state = newGame(THREE, { coins: [2, 2, 4] });
  state = act(state, 0, { type: "steal", target: 2 });
  state = passAll(state);
  state = act(state, 2, { type: "block", card: "Captain" }); // seat 2 bluffs Captain
  assert.deepEqual(awaitingSeats(state), [0, 1]);
  state = act(state, 1, { type: "challenge" });
  state = act(state, 2, { type: "reveal", card: "Duke" });
  assert.equal(state.players[0].coins, 4, "the steal goes ahead after the block collapses");
  assert.equal(state.players[2].coins, 2);
});

test("save and resume mid-window continues the same game", () => {
  let state = newGame(THREE);
  state = act(state, 0, { type: "tax" }); // a true Duke claim: the challenge reshuffles with the stored RNG
  state = act(state, 2, { type: "pass" });
  const json = serializeCoupGame(state);
  const resumed = restoreCoupGame(json);
  assert.deepEqual(resumed, state);
  const a = act(act(state, 1, { type: "challenge" }), 1, { type: "reveal", card: "Contessa" });
  const b = act(act(resumed, 1, { type: "challenge" }), 1, { type: "reveal", card: "Contessa" });
  assert.deepEqual(a, b, "the stored RNG makes the resumed game identical");
});

test("restore rejects inconsistent saves", () => {
  const state = newGame(THREE);
  assert.throws(() => restoreCoupGame("{not json"), /not valid JSON/);
  const extraCard = structuredClone(state);
  extraCard.deck.push("Duke");
  assert.throws(() => restoreCoupGame(extraCard), /Duke count is 4/);
  const badPhase = structuredClone(state);
  badPhase.phase = "dancing";
  assert.throws(() => restoreCoupGame(badPhase), /unknown phase/);
  const deadActive = structuredClone(state);
  deadActive.players[0].influence.forEach((slot) => { slot.revealed = true; });
  assert.throws(() => restoreCoupGame(deadActive), /active seat/);
});

test("the public view hides other hands, the deck and the RNG", () => {
  let state = newGame(THREE, { startingSeat: 2 });
  const view = publicView(state, 0);
  assert.deepEqual(view.players[0].hidden, ["Duke", "Captain"]);
  assert.equal(view.players[1].hidden, null);
  assert.equal(view.players[1].influenceCount, 2);
  assert.equal(view.deckCount, 9);
  assert.equal("deck" in view, false);
  assert.equal("rngState" in view, false);
  const spectator = publicView(state, null);
  assert.ok(spectator.players.every((player) => player.hidden === null));
  assert.deepEqual(publicView(state, null, { revealAll: true }).players[1].hidden, ["Assassin", "Contessa"]);

  state = passAll(act(state, 2, { type: "exchange" }));
  assert.equal(publicView(state, 2).exchange.options.length, 4);
  assert.equal(publicView(state, 0).exchange.options, null);
  assert.ok(state.log.every((entry) => !/draws? (a )?(Duke|Assassin|Captain|Ambassador|Contessa)/.test(entry.text)));
});

test("random legal playouts always keep the invariants and finish", () => {
  for (let game = 0; game < 300; game += 1) {
    let seed = game * 9973 + 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let state = createCoupGame({ playerCount: 2 + (game % 5), seed: game });
    let moves = 0;
    while (state.phase !== "game_over") {
      const seats = awaitingSeats(state);
      const seat = seats[Math.floor(random() * seats.length)];
      const legal = getLegalActions(state, seat);
      assert.ok(legal.length > 0, `seat ${seat} has no legal action in ${state.phase}`);
      state = applyAction(state, seat, legal[Math.floor(random() * legal.length)]);
      moves += 1;
      assert.ok(moves < 3000, "game should finish");
    }
    assert.deepEqual(checkInvariants(state), []);
    assert.equal(state.result.ranking.length, state.players.length);
  }
});
