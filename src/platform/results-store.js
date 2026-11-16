import fs from "node:fs";
import path from "node:path";

export const MATCH_MODES = Object.freeze(["human-vs-ai", "arena"]);
export const INITIAL_RATING = 1500;
const K_FACTOR = 32;
const MAX_MATCHES = 5000;
const RECENT_LIMIT = 20;

function clampText(value, max = 80) {
  return String(value ?? "").trim().slice(0, max);
}

/** The ladder rates AI entrants by model + reasoning effort; every human shares one "human" entrant. */
export function entrantKey(participant) {
  if (participant.kind === "human") return "human";
  return `${participant.model}@${participant.reasoningEffort}`;
}

function normalizeParticipant(raw, index) {
  if (!raw || typeof raw !== "object") throw new Error(`Participant ${index} is not an object`);
  const kind = raw.kind === "human" ? "human" : raw.kind === "ai" ? "ai" : null;
  if (!kind) throw new Error(`Participant ${index} must have kind "human" or "ai"`);
  const participant = { kind, name: clampText(raw.name) || (kind === "human" ? "You" : `AI ${index + 1}`) };
  if (raw.characterId != null) participant.characterId = clampText(raw.characterId, 40);
  if (kind === "ai") {
    if (!raw.model || !raw.reasoningEffort) throw new Error(`AI participant ${index} needs model and reasoningEffort`);
    participant.model = clampText(raw.model, 60);
    participant.reasoningEffort = clampText(raw.reasoningEffort, 20);
  }
  const hasPlace = Number.isFinite(raw.place);
  const hasScore = Number.isFinite(raw.score);
  if (!hasPlace && !hasScore) throw new Error(`Participant ${index} needs a place or a score`);
  if (hasPlace) participant.place = raw.place;
  if (hasScore) participant.score = raw.score;
  return participant;
}

/** Lower rank is better. Places win over scores; scores rank highest-first; ties share a rank. */
function ranksFor(participants) {
  if (participants.every((participant) => Number.isFinite(participant.place))) return participants.map((participant) => participant.place);
  return participants.map((participant) => participants.filter((other) => (other.score ?? 0) > (participant.score ?? 0)).length + 1);
}

/** Multiplayer Elo: every pair of entrants plays one virtual game, scaled so a match moves at most K. */
function applyElo(ratings, match) {
  const entrants = match.participants.map((participant, index) => ({ key: entrantKey(participant), participant, rank: match.ranks[index] }));
  const n = entrants.length;
  if (n < 2) return {};
  const before = Object.fromEntries(entrants.map(({ key }) => [key, ratings[key]?.rating ?? INITIAL_RATING]));
  const delta = Object.fromEntries(entrants.map(({ key }) => [key, 0]));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = entrants[i];
      const b = entrants[j];
      if (a.key === b.key) continue; // Mirror matches (same model on both sides) carry no rating signal.
      const expected = 1 / (1 + 10 ** ((before[b.key] - before[a.key]) / 400));
      const actual = a.rank < b.rank ? 1 : a.rank > b.rank ? 0 : 0.5;
      const change = (K_FACTOR / (n - 1)) * (actual - expected);
      delta[a.key] += change;
      delta[b.key] -= change;
    }
  }
  const best = Math.min(...match.ranks);
  const worst = Math.max(...match.ranks);
  const seen = new Set();
  for (const { key, participant, rank } of entrants) {
    const entry = (ratings[key] ??= {
      key,
      kind: participant.kind,
      model: participant.model ?? null,
      reasoningEffort: participant.reasoningEffort ?? null,
      rating: INITIAL_RATING,
      matches: 0,
      wins: 0,
      losses: 0,
      draws: 0,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    entry.rating += delta[key];
    entry.matches += 1;
    if (best === worst) entry.draws += 1;
    else if (rank === best) entry.wins += 1;
    else entry.losses += 1;
  }
  return Object.fromEntries(Object.entries(delta).map(([key, value]) => [key, Math.round(value * 10) / 10]));
}

function publicRatings(ratings) {
  return Object.values(ratings)
    .map((entry) => ({ ...entry, rating: Math.round(entry.rating) }))
    .sort((a, b) => b.rating - a.rating || b.matches - a.matches);
}

export class ResultsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.matches = [];
    this._load();
  }

  _load() {
    try {
      const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (Array.isArray(payload?.matches)) this.matches = payload.matches;
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`Results store reset: ${String(error?.message || error)}`);
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, matches: this.matches }));
    fs.renameSync(temporary, this.filePath);
  }

  /**
   * recordMatch({ gameId, mode: "human-vs-ai" | "arena", participants: [{ kind, name, characterId, model, reasoningEffort, place | score }] })
   * Returns the stored match including per-entrant rating changes for that game.
   */
  recordMatch({ gameId, mode, participants, details = null }) {
    if (typeof gameId !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(gameId)) throw new Error(`Invalid game id “${gameId}”`);
    if (!MATCH_MODES.includes(mode)) throw new Error(`Invalid match mode “${mode}”`);
    if (!Array.isArray(participants) || participants.length < 2) throw new Error("A match needs at least two participants");
    const normalized = participants.map(normalizeParticipant);
    const match = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      gameId,
      mode,
      at: new Date().toISOString(),
      participants: normalized,
      ranks: ranksFor(normalized),
    };
    if (details && typeof details === "object") match.details = details;
    match.ratingChanges = applyElo(this._ratings(gameId), match);
    this.matches.push(match);
    if (this.matches.length > MAX_MATCHES) this.matches.splice(0, this.matches.length - MAX_MATCHES);
    this._save();
    return match;
  }

  /** Replays the stored matches; cheap at this scale and immune to rating drift. */
  _ratings(gameId = null) {
    const ratings = {};
    for (const match of this.matches) {
      if (gameId && match.gameId !== gameId) continue;
      applyElo(ratings, match);
    }
    return ratings;
  }

  ladder(gameId = null) {
    const matches = gameId ? this.matches.filter((match) => match.gameId === gameId) : this.matches;
    return {
      gameId: gameId ?? "overall",
      ratings: publicRatings(this._ratings(gameId)),
      matchCount: matches.length,
      recentMatches: matches.slice(-RECENT_LIMIT).reverse(),
    };
  }

  overview() {
    const games = [...new Set(this.matches.map((match) => match.gameId))];
    return {
      overall: publicRatings(this._ratings(null)),
      games: Object.fromEntries(games.map((gameId) => [gameId, publicRatings(this._ratings(gameId))])),
      matchCount: this.matches.length,
      recentMatches: this.matches.slice(-RECENT_LIMIT).reverse(),
    };
  }
}
