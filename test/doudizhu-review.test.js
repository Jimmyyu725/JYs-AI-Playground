import assert from "node:assert/strict";
import test from "node:test";
import { requestDoudizhuReview, reviewInput } from "../src/games/doudizhu-ai.js";
import { DouDizhuGame } from "../src/games/doudizhu-game.js";

test("the review input carries the public record of the hand and no card holdings", () => {
  const game = new DouDizhuGame({ gameMode: "arena" });
  game.applyBid(game.currentActorSeat, 3);
  const input = reviewInput(game, 1);
  assert.equal(input.players.length, 3);
  assert.ok(input.players.every((player) => !("hand" in player) && Number.isInteger(player.cardsLeft)));
  assert.ok(input.moves.some((text) => /bids 3/.test(text)));
  assert.equal(input.reviewer.seat, 1);
});

test("only an AI seat can review", async () => {
  const game = new DouDizhuGame({ gameMode: "human" });
  await assert.rejects(() => requestDoudizhuReview(game, 0), /Only an AI seat/);
});
