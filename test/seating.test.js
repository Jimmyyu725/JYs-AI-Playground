import assert from "node:assert/strict";
import test from "node:test";
import { AI_CHARACTERS } from "../src/platform/characters.js";
import { publicCharacters, seatCharacters } from "../src/platform/seating.js";
import { PokerGame } from "../src/poker-game.js";

test("seats distinct random characters by default", () => {
  const cast = seatCharacters(5);
  assert.equal(cast.length, 5);
  assert.equal(new Set(cast.map((character) => character.id)).size, 5);
});

test("honours explicit character ids and fills the rest without duplicates", () => {
  const pinned = AI_CHARACTERS[2].id;
  const cast = seatCharacters(3, [undefined, pinned, pinned]);
  assert.equal(cast[1].id, pinned);
  assert.equal(new Set(cast.map((character) => character.id)).size, 3);
});

test("ignores unknown character ids", () => {
  const [character] = seatCharacters(1, ["no-such-character"]);
  assert.ok(AI_CHARACTERS.includes(character));
});

test("tables seat their AI players from the roster", () => {
  const game = new PokerGame({ opponentCount: 3, aiPlayers: [{ characterId: AI_CHARACTERS[3].id }] });
  assert.equal(game.players[1].character.id, AI_CHARACTERS[3].id);
  assert.equal(new Set(game.players.slice(1).map((player) => player.character.id)).size, 3);
});

test("public roster exposes portrait paths but not prompts", () => {
  const [first] = publicCharacters();
  assert.equal(first.portrait, `/assets/characters/${first.id}/`);
  assert.equal("personality" in first, false);
});
