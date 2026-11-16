import * as roster from "./characters.js";

function shuffled(list, rng) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

export function allCharacters() {
  return roster.AI_CHARACTERS;
}

export function findCharacter(id) {
  if (typeof id !== "string" || !id) return null;
  if (typeof roster.getCharacter === "function") return roster.getCharacter(id) ?? null;
  return roster.AI_CHARACTERS.find((character) => character.id === id) ?? null;
}

function pickRandom(count, exclude, rng) {
  if (count <= 0) return [];
  if (typeof roster.pickCharacters === "function") return roster.pickCharacters(count, { exclude, rng });
  const excluded = new Set(exclude);
  return shuffled(roster.AI_CHARACTERS.filter((character) => !excluded.has(character.id)), rng).slice(0, count);
}

/**
 * Casts `count` distinct AI characters for a new table. `requestedIds[i]` pins seat i to a specific
 * character (from the setup's picker); unknown, duplicate, or missing ids get a random character.
 */
export function seatCharacters(count, requestedIds = [], { rng = Math.random } = {}) {
  const cast = new Array(count).fill(null);
  const taken = new Set();
  for (let index = 0; index < count; index += 1) {
    const character = findCharacter(requestedIds?.[index]);
    if (character && !taken.has(character.id)) {
      cast[index] = character;
      taken.add(character.id);
    }
  }
  const open = cast.filter((character) => !character).length;
  const random = pickRandom(open, [...taken], rng);
  let next = 0;
  for (let index = 0; index < count; index += 1) {
    if (!cast[index]) cast[index] = random[next++];
  }
  if (cast.some((character) => !character)) throw new Error(`The house roster cannot seat ${count} distinct characters`);
  return cast;
}

/** The client-facing roster served at GET /api/characters. */
export function publicCharacters() {
  return roster.AI_CHARACTERS.map((character) => ({
    id: character.id,
    name: character.name,
    shortName: character.shortName,
    title: character.title,
    color: character.color,
    initials: character.initials,
    portrait: `/assets/characters/${character.id}/`,
  }));
}
