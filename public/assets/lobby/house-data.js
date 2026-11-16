// Pure helpers shared by the corridor, The House and the ladder pages. No DOM, so Node tests import it.

/** Each room's light, taken from its ART.md palette: `glow` spills from the door, `tint` colours the frame. */
export const ROOM_LIGHT = Object.freeze({
  holdem: { glow: "#c9a24a", tint: "#0f3b26" },
  go: { glow: "#e39a52", tint: "#1b1824" },
  wuziqi: { glow: "#d3e0cd", tint: "#b23a2a" },
  doudizhu: { glow: "#e0a43c", tint: "#b9120b" },
  "liars-dice": { glow: "#f6b545", tint: "#1f3b42" },
  xiangqi: { glow: "#f2b8c6", tint: "#6f8f7e" },
  coup: { glow: "#3fa79a", tint: "#6e1810" },
  "draw-guess": { glow: "#e9a23b", tint: "#56708f" },
  "taiwan-mahjong": { glow: "#ff4fb8", tint: "#3ef0e0" },
});
const DEFAULT_LIGHT = Object.freeze({ glow: "#aab6ff", tint: "#1a2266" });

export function roomLight(gameId) {
  return ROOM_LIGHT[gameId] ?? DEFAULT_LIGHT;
}

/** A room's door can be walked through only when it is live and the server mounts it. */
export function isOpen(game) {
  return game?.status === "live" && game?.serverRoom !== false;
}

export function shuffled(list, rng = Math.random) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/** `count` distinct entries, avoiding `exclude` ids when enough others remain. */
export function pickTrio(characters, { count = 3, exclude = [], rng = Math.random } = {}) {
  const fresh = characters.filter((character) => !exclude.includes(character.id));
  const pool = fresh.length >= count ? fresh : characters;
  return shuffled(pool, rng).slice(0, count);
}

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
export function numberWord(value) {
  return NUMBER_WORDS[value] ?? String(value);
}

export function playersLabel(players) {
  if (!players) return "";
  const { min, max } = players;
  return min === max ? `${min} players` : `${min}–${max} players`;
}

/** "GPT-6 Luna · high" for an AI entrant, "Human players" for the shared human entrant. */
export function entrantLabel(entry, registry) {
  if (!entry || entry.kind === "human" || entry.key === "human") return "Human players";
  const model = registry?.models?.find((candidate) => candidate.id === entry.model);
  return `${model?.label ?? entry.model} · ${entry.reasoningEffort}`;
}

export function entrantKey(participant) {
  return participant.kind === "human" ? "human" : `${participant.model}@${participant.reasoningEffort}`;
}

/** Recent-match lists from several ladder responses, de-duplicated and newest first. */
export function mergeMatches(...lists) {
  const byId = new Map();
  for (const list of lists) for (const match of list ?? []) if (match?.id && !byId.has(match.id)) byId.set(match.id, match);
  return [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** Win / loss / draw per character id, from whichever matches the caller has (the API serves recent ones). */
export function characterRecords(matches) {
  const records = {};
  for (const match of matches) {
    const ranks = match.ranks ?? [];
    if (ranks.length !== match.participants?.length) continue;
    const best = Math.min(...ranks);
    const worst = Math.max(...ranks);
    match.participants.forEach((participant, index) => {
      if (!participant.characterId) return;
      const record = (records[participant.characterId] ??= { matches: 0, wins: 0, losses: 0, draws: 0, games: [] });
      record.matches += 1;
      if (best === worst) record.draws += 1;
      else if (ranks[index] === best) record.wins += 1;
      else record.losses += 1;
      if (!record.games.includes(match.gameId)) record.games.push(match.gameId);
    });
  }
  return records;
}

/**
 * Rating path per entrant over one game's recent matches, oldest first, ending at the current rating.
 * Works backwards from `ratings` (current, rounded) through each match's per-game ratingChanges.
 */
export function ratingPaths(ratings, recentMatches) {
  const current = Object.fromEntries((ratings ?? []).map((entry) => [entry.key, entry.rating]));
  const paths = Object.fromEntries(Object.keys(current).map((key) => [key, [current[key]]]));
  const running = { ...current };
  for (const match of recentMatches ?? []) {
    for (const [key, change] of Object.entries(match.ratingChanges ?? {})) {
      if (!(key in running)) continue;
      running[key] -= change;
      paths[key].unshift(Math.round(running[key]));
    }
  }
  return paths;
}

/** "OpenAI · DeepSeek" style summary from /api/health providerKeys. */
export function providerSummary(health, registry = health?.models) {
  const providers = health?.providerKeys ?? {};
  const ready = Object.entries(providers)
    .filter(([, rooms]) => rooms && Object.values(rooms).some(Boolean))
    .map(([id]) => registry?.providers?.find((provider) => provider.id === id)?.label ?? id);
  return ready;
}

export function relativeTime(iso, now = Date.now()) {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
