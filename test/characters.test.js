import test from "node:test";
import assert from "node:assert/strict";
import { AI_CHARACTERS, getCharacter, pickCharacters } from "../src/platform/characters.js";

const REQUIRED = ["id", "name", "shortName", "title", "personality", "voice", "color", "initials", "look"];

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("roster has 50 complete characters with unique ids, names, and colours", () => {
  assert.equal(AI_CHARACTERS.length, 50);
  for (const character of AI_CHARACTERS) {
    for (const field of REQUIRED) assert.ok(character[field], `${character.id} is missing ${field}`);
    assert.match(character.id, /^[a-z]+$/);
    assert.match(character.color, /^#[0-9a-f]{6}$/i);
    assert.match(character.title, /^The /);
  }
  for (const field of ["id", "name", "color"]) {
    const values = AI_CHARACTERS.map((character) => character[field].toLowerCase());
    assert.equal(new Set(values).size, 50, `duplicate ${field}`);
  }
});

test("original cast keeps its order", () => {
  assert.deepEqual(AI_CHARACTERS.slice(0, 5).map((c) => c.id), ["vesper", "rook", "selene", "moss", "iris"]);
});

test("getCharacter looks up by id", () => {
  assert.equal(getCharacter("selene").name, "Selene Park");
  assert.equal(getCharacter("nobody"), null);
});

test("pickCharacters returns distinct characters and respects exclude", () => {
  const exclude = ["vesper", "rook", "iris"];
  for (let run = 0; run < 50; run += 1) {
    const picked = pickCharacters(8, { exclude });
    assert.equal(picked.length, 8);
    assert.equal(new Set(picked.map((c) => c.id)).size, 8);
    assert.ok(picked.every((c) => !exclude.includes(c.id)));
  }
  assert.equal(pickCharacters(47, { exclude }).length, 47);
});

test("pickCharacters is deterministic with a seeded rng", () => {
  const a = pickCharacters(6, { rng: seededRng(42) }).map((c) => c.id);
  const b = pickCharacters(6, { rng: seededRng(42) }).map((c) => c.id);
  assert.deepEqual(a, b);
});

test("pickCharacters throws when asking for more than available", () => {
  assert.throws(() => pickCharacters(51), RangeError);
  assert.throws(() => pickCharacters(48, { exclude: ["vesper", "rook", "moss"] }), RangeError);
});
