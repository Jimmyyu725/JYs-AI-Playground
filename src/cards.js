export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
export const SUITS = ["C", "D", "H", "S"];

export function createDeck() {
  return RANKS.flatMap((rank) => SUITS.map((suit) => `${rank}${suit}`));
}

export function shuffleDeck(deck, random = Math.random) {
  const shuffled = [...deck];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

export function cardLabel(code) {
  if (!code) return "";
  const rank = code[0] === "T" ? "10" : code[0];
  const suit = { C: "♣", D: "♦", H: "♥", S: "♠" }[code[1]] ?? code[1];
  return `${rank}${suit}`;
}

