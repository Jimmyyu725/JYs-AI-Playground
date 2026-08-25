import test from "node:test";
import assert from "node:assert/strict";
import {
  DouDizhuGame,
  analyzeCombo,
  beatsCombo,
  createDouDizhuDeck,
  describeCombo,
} from "../src/games/doudizhu-game.js";

test("builds a unique 54-card deck with two jokers", () => {
  const deck = createDouDizhuDeck();
  assert.equal(deck.length, 54);
  assert.equal(new Set(deck).size, 54);
  assert.ok(deck.includes("SJ"));
  assert.ok(deck.includes("BJ"));
});

test("deals 17 cards each plus three bottom cards and opens bidding", () => {
  const game = new DouDizhuGame({ gameMode: "human", humanName: "Tester" });
  assert.equal(game.phase, "bidding");
  assert.equal(game.players.length, 3);
  assert.ok(game.players.every((player) => player.hand.length === 17));
  assert.equal(game.bottomCards.length, 3);
  assert.ok([0, 1, 2].includes(game.currentActorSeat));
  assert.equal(game.players[0].isHuman, true);
});

test("recognizes every legal combo type", () => {
  const cases = [
    [["3C"], "single"],
    [["3C", "3D"], "pair"],
    [["3C", "3D", "3H"], "triple"],
    [["3C", "3D", "3H", "5S"], "triple_single"],
    [["3C", "3D", "3H", "5S", "5D"], "triple_pair"],
    [["3C", "4D", "5H", "6S", "7C"], "straight"],
    [["3C", "4D", "5H", "6S", "7C", "8D", "9H", "TC", "JC", "QC", "KC", "AC"], "straight"],
    [["3C", "3D", "4H", "4S", "5C", "5D"], "pair_straight"],
    [["3C", "3D", "3H", "4S", "4C", "4D"], "airplane"],
    [["3C", "3D", "3H", "4S", "4C", "4D", "5H", "9C"], "airplane_single"],
    [["3C", "3D", "3H", "4S", "4C", "4D", "9H", "9S"], "airplane_single"],
    [["3C", "3D", "3H", "4S", "4C", "4D", "5H", "5S", "9C", "9D"], "airplane_pair"],
    [["3C", "3D", "3H", "3S", "5H", "9C"], "four_two_single"],
    [["3C", "3D", "3H", "3S", "5H", "5S"], "four_two_single"],
    [["3C", "3D", "3H", "3S", "5H", "5S", "9C", "9D"], "four_two_pair"],
    [["3C", "3D", "3H", "3S"], "bomb"],
    [["SJ", "BJ"], "rocket"],
  ];
  for (const [cards, type] of cases) {
    assert.equal(analyzeCombo(cards).type, type, `${cards.join(" ")} should be ${type}`);
  }
});

test("rejects malformed or non-existent combos", () => {
  const invalid = [
    ["3C", "4C"], // two different singles
    ["2C", "3D", "4H", "5S", "6C"], // straight cannot include 2
    ["JC", "QC", "KC", "AC", "2C"], // straight crossing 2
    ["3C", "3D", "4H", "4S"], // two pairs but not consecutive... actually consecutive but pair straight needs 3+
    ["3C", "3D", "4H", "4S", "5C", "5D", "6H", "7S"], // no valid structure
    ["SJ", "SJ"], // duplicate card
    ["3C", "3D", "3H", "3S", "4H"], // four plus one
    ["3C", "3D", "3H", "4S", "4C", "4D", "5H", "5S", "6C"], // airplane with mismatched wings (2 triples need exactly 2 wing cards)
    ["3C", "3D", "3H", "4S", "4C", "4D", "SJ", "BJ"], // airplane wings cannot be both jokers
    ["3C", "3D", "3H", "3S", "SJ", "BJ"], // four with two cannot attach both jokers
  ];
  for (const cards of invalid) {
    assert.throws(() => analyzeCombo(cards), undefined, `${cards.join(" ")} should be illegal`);
  }
});

test("enforces beat rules across combo types", () => {
  assert.equal(beatsCombo(analyzeCombo(["9C", "9D"]), analyzeCombo(["8C", "8D"])), true);
  assert.equal(beatsCombo(analyzeCombo(["8C", "8D"]), analyzeCombo(["9C", "9D"])), false);
  assert.equal(beatsCombo(analyzeCombo(["8C"]), analyzeCombo(["9C", "9D"])), false);
  assert.equal(beatsCombo(analyzeCombo(["8C", "8D", "8H", "8S"]), analyzeCombo(["9C", "9D"])), true);
  assert.equal(beatsCombo(analyzeCombo(["9C", "9D", "9H", "9S"]), analyzeCombo(["8C", "8D", "8H", "8S"])), true);
  assert.equal(beatsCombo(analyzeCombo(["8C", "8D", "8H", "8S"]), analyzeCombo(["9C", "9D", "9H", "9S"])), false);
  assert.equal(beatsCombo(analyzeCombo(["SJ", "BJ"]), analyzeCombo(["9C", "9D", "9H", "9S"])), true);
  assert.equal(beatsCombo(analyzeCombo(["9C", "9D", "9H", "9S"]), analyzeCombo(["SJ", "BJ"])), false);
  // Straights must match length to compare.
  assert.equal(beatsCombo(analyzeCombo(["4C", "5D", "6H", "7S", "8C"]), analyzeCombo(["3C", "4D", "5H", "6S", "7C"])), true);
  assert.equal(beatsCombo(analyzeCombo(["3C", "4D", "5H", "6S", "7C", "8D"]), analyzeCombo(["4C", "5D", "6H", "7S", "8C"])), false);
  // Four with two singles (6 cards) and four with two pairs (8 cards) are distinct combos.
  assert.equal(
    beatsCombo(analyzeCombo(["3C", "3D", "3H", "3S", "5H", "9C"]), analyzeCombo(["4C", "4D", "4H", "4S", "5H", "5S", "9C", "9D"])),
    false,
  );
  assert.equal(
    beatsCombo(analyzeCombo(["5C", "5D", "5H", "5S", "6H", "6S", "9C", "9D"]), analyzeCombo(["4C", "4D", "4H", "4S", "5H", "5S", "9C", "9D"])),
    true,
  );
});

test("redeals when every player passes the bid", () => {
  const game = new DouDizhuGame({ gameMode: "human" });
  const first = game.currentActorSeat;
  game.applyBid(first, 0);
  game.applyBid((first + 1) % 3, 0);
  game.applyBid((first + 2) % 3, 0);
  assert.equal(game.handNumber, 2);
  assert.equal(game.phase, "bidding");
});

test("a bid of 3 wins immediately and the landlord takes the bottom cards", () => {
  const game = new DouDizhuGame({ gameMode: "human" });
  const bidder = game.currentActorSeat;
  game.applyBid(bidder, 3);
  assert.equal(game.phase, "playing");
  assert.equal(game.landlordSeat, bidder);
  assert.equal(game.players[bidder].hand.length, 20);
  assert.equal(game.currentActorSeat, bidder);
  assert.equal(game.highestBid, 3);
});

test("two passes after a bid close the bidding", () => {
  const game = new DouDizhuGame({ gameMode: "human" });
  const bidder = game.currentActorSeat;
  game.applyBid(bidder, 2);
  game.applyBid((bidder + 1) % 3, 0);
  assert.equal(game.phase, "bidding");
  game.applyBid((bidder + 2) % 3, 0);
  assert.equal(game.phase, "playing");
  assert.equal(game.landlordSeat, bidder);
  assert.equal(game.highestBid, 2);
  assert.throws(() => game.applyBid((bidder + 2) % 3, 1), /Bidding is not open/);
});

test("rejects bids that do not raise the current bid", () => {
  const game = new DouDizhuGame({ gameMode: "human" });
  const bidder = game.currentActorSeat;
  game.applyBid(bidder, 2);
  const next = (bidder + 1) % 3;
  assert.throws(() => game.applyBid(next, 2), /bid higher/i);
  assert.throws(() => game.applyBid(next, 1), /bid higher/i);
  assert.throws(() => game.applyBid(next, 4), /Bid must be 1, 2, or 3/);
});

test("enforces turn order, hand membership, and pass rules during play", () => {
  const game = new DouDizhuGame({ gameMode: "human" });
  const landlord = game.currentActorSeat;
  game.applyBid(landlord, 1);
  const farmerOne = (landlord + 1) % 3;
  const farmerTwo = (landlord + 2) % 3;
  game.applyBid(farmerOne, 0);
  game.applyBid(farmerTwo, 0);

  assert.throws(() => game.applyAction(farmerOne, "play", [game.players[farmerOne].hand[0]]), /not acting/i);
  assert.throws(() => game.applyAction(landlord, "pass"), /cannot pass/i);
  assert.throws(() => game.applyAction(landlord, "play", [game.players[farmerOne].hand[0]]), /not in your hand/i);
  assert.throws(() => game.applyAction(landlord, "fold"), /Unknown Dou Dizhu action/i);

  const leadCard = game.players[landlord].hand[0];
  game.applyAction(landlord, "play", [leadCard]);
  assert.equal(game.currentActorSeat, farmerOne);
  game.applyAction(farmerOne, "pass");
  game.applyAction(farmerTwo, "pass");
  assert.equal(game.currentActorSeat, landlord);
  assert.equal(game.lastPlay, null);
});

test("a follower must beat the last play with the same type or a bomb", () => {
  const game = new DouDizhuGame({ gameMode: "human" });
  const landlord = game.currentActorSeat;
  game.applyBid(landlord, 1);
  const farmerOne = (landlord + 1) % 3;
  const farmerTwo = (landlord + 2) % 3;
  game.applyBid(farmerOne, 0);
  game.applyBid(farmerTwo, 0);

  game.players[landlord].hand = ["KC", "KD", "AC"];
  game.players[farmerOne].hand = ["3C", "4D", "8H", "8S", "8D", "8C"];
  game.applyAction(landlord, "play", ["KC", "KD"]);
  assert.throws(() => game.applyAction(farmerOne, "play", ["3C", "4D"]), /not a legal Dou Dizhu/i);
  assert.throws(() => game.applyAction(farmerOne, "play", ["3C"]), /cannot beat/i);
  game.applyAction(farmerOne, "play", ["8H", "8S", "8D", "8C"]);
  assert.equal(game.lastPlay.combo.type, "bomb");
  assert.equal(game.bombsPlayed, 1);
});

test("emptying the landlord's hand wins for the landlord with bomb multiplier", () => {
  const game = new DouDizhuGame({ gameMode: "human" });
  const landlord = game.currentActorSeat;
  game.applyBid(landlord, 2);
  const farmerOne = (landlord + 1) % 3;
  const farmerTwo = (landlord + 2) % 3;
  game.applyBid(farmerOne, 0);
  game.applyBid(farmerTwo, 0);

  game.players[landlord].hand = ["SJ", "BJ"];
  game.players[farmerOne].hand = ["3C"];
  game.players[farmerTwo].hand = ["4C"];
  game.applyAction(landlord, "play", ["SJ", "BJ"]);
  assert.equal(game.phase, "complete");
  assert.equal(game.result.winner, "landlord");
  assert.equal(game.result.bombsPlayed, 1);
  // The farmers never played a card: spring doubles the pot again.
  assert.equal(game.result.spring, "spring");
  assert.equal(game.result.multiplier, 4);
  assert.equal(game.result.score, 8);
});

test("emptying a farmer's hand wins for the farmers", () => {
  const game = new DouDizhuGame({ gameMode: "human" });
  const landlord = game.currentActorSeat;
  game.applyBid(landlord, 1);
  const farmerOne = (landlord + 1) % 3;
  const farmerTwo = (landlord + 2) % 3;
  game.applyBid(farmerOne, 0);
  game.applyBid(farmerTwo, 0);

  game.players[landlord].hand = ["3C", "3D"];
  game.players[farmerOne].hand = ["4D"];
  game.players[farmerTwo].hand = ["5C"];
  game.applyAction(landlord, "play", ["3C"]);
  game.applyAction(farmerOne, "play", ["4D"]);
  assert.equal(game.phase, "complete");
  assert.equal(game.result.winner, "farmers");
  // The landlord managed only one play: anti-spring doubles the pot.
  assert.equal(game.result.spring, "anti_spring");
  assert.equal(game.result.multiplier, 2);
  assert.equal(game.result.score, 2);
  assert.deepEqual(game.result.winningSeats.sort(), [farmerOne, farmerTwo].sort());
});

test("no spring bonus when farmers played and the landlord played more than once", () => {
  const game = new DouDizhuGame({ gameMode: "human" });
  const landlord = game.currentActorSeat;
  game.applyBid(landlord, 1);
  const farmerOne = (landlord + 1) % 3;
  const farmerTwo = (landlord + 2) % 3;
  game.applyBid(farmerOne, 0);
  game.applyBid(farmerTwo, 0);

  game.players[landlord].hand = ["3C", "AH"];
  game.players[farmerOne].hand = ["4D", "4S"];
  game.players[farmerTwo].hand = ["5C", "6C"];
  game.applyAction(landlord, "play", ["3C"]);
  game.applyAction(farmerOne, "play", ["4D"]);
  game.applyAction(farmerTwo, "play", ["5C"]);
  game.applyAction(landlord, "play", ["AH"]);
  assert.equal(game.phase, "complete");
  assert.equal(game.result.winner, "landlord");
  assert.equal(game.result.spring, "none");
  assert.equal(game.result.multiplier, 1);
  assert.equal(game.result.score, 1);
});

test("hides AI hands from the human but reveals everything in arena mode", () => {
  const humanGame = new DouDizhuGame({ gameMode: "human", humanName: "Tester" });
  const humanState = humanGame.publicState();
  assert.equal(humanState.players[0].hand.length, 17);
  assert.equal(humanState.players[1].hand.length, 0);
  assert.equal(humanState.players[2].hand.length, 0);

  const arenaGame = new DouDizhuGame({ gameMode: "arena", arenaPaused: true });
  const arenaState = arenaGame.publicState();
  assert.ok(arenaState.players.every((player) => player.hand.length === 17 && !player.isHuman));
  assert.equal(arenaState.humanCanAct, false);
});

test("describes combos for the transcript", () => {
  assert.equal(describeCombo(analyzeCombo(["3C", "4D", "5H", "6S", "7C"])), "Straight");
  assert.equal(describeCombo(analyzeCombo(["SJ", "BJ"])), "Rocket");
  assert.equal(describeCombo(analyzeCombo(["9C", "9D", "9H", "9S"])), "Bomb");
});
