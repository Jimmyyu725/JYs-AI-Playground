// Draw & Guess (你画我猜) rules engine.
//
// Pure functions over a plain, JSON-serializable state object. The engine never
// reads the clock or calls a model: callers pass `now` (epoch milliseconds) and
// may inject `rng` (a function returning a float in [0, 1)). Without an injected
// rng the engine advances a seeded PRNG stored in the state, so a saved game
// resumes deterministically.
//
// Round flow: choosing -> prompting -> rendering -> guessing -> round_over,
// repeated until every seat has drawn `config.rotations` times, then game_over.
// A human drawer may skip rendering by submitting a sketch.
//
// External work the room performs between engine actions:
// - Image generation: when phase is "rendering", `imageRequestFor(state)` returns
//   { drawerSeat, prompt, roundNumber }. The room generates the image and applies
//   { type: "image_ready", imageRef } or { type: "image_failed", reason }.
// - Vision: during "guessing", `visionInputFor(state, seat, now)` returns
//   { imageRef, blurPx, stage } for the seat. The room blurs the image by blurPx
//   before showing it to that guesser (human or model).

export const DRAW_GUESS_GAME_ID = "draw-guess";
export const DRAW_GUESS_SAVE_VERSION = 1;
export const DIFFICULTIES = Object.freeze(["easy", "medium", "hard"]);
export const PHASES = Object.freeze(["choosing", "prompting", "rendering", "guessing", "round_over", "game_over"]);
export const MIN_SEATS = 2;
export const MAX_SEATS = 8;
export const MAX_TABLE_TALK = 140;

const entry = (id, word, zh, difficulty, synonyms = [], zhSynonyms = []) =>
  Object.freeze({ id, word, zh, difficulty, synonyms: Object.freeze(synonyms), zhSynonyms: Object.freeze(zhSynonyms) });

export const DEFAULT_WORD_BANK = Object.freeze([
  entry("apple", "apple", "苹果", "easy"),
  entry("cat", "cat", "猫", "easy", ["kitty", "kitten"], ["猫咪", "小猫"]),
  entry("dog", "dog", "狗", "easy", ["puppy"], ["小狗"]),
  entry("house", "house", "房子", "easy", ["home"], ["房屋"]),
  entry("tree", "tree", "树", "easy", [], ["大树"]),
  entry("sun", "sun", "太阳", "easy"),
  entry("car", "car", "汽车", "easy", ["automobile"], ["车", "小汽车"]),
  entry("fish", "fish", "鱼", "easy"),
  entry("book", "book", "书", "easy"),
  entry("chair", "chair", "椅子", "easy"),
  entry("cake", "cake", "蛋糕", "easy"),
  entry("flower", "flower", "花", "easy", ["blossom"], ["花朵"]),
  entry("moon", "moon", "月亮", "easy", [], ["月球"]),
  entry("star", "star", "星星", "easy"),
  entry("ball", "ball", "球", "easy"),
  entry("hat", "hat", "帽子", "easy", ["cap"]),
  entry("bird", "bird", "鸟", "easy", [], ["小鸟"]),
  entry("egg", "egg", "鸡蛋", "easy", [], ["蛋"]),
  entry("shoe", "shoe", "鞋", "easy", ["sneaker"], ["鞋子"]),
  entry("boat", "boat", "船", "easy", [], ["小船"]),
  entry("guitar", "guitar", "吉他", "medium"),
  entry("umbrella", "umbrella", "雨伞", "medium", ["parasol"], ["伞"]),
  entry("lighthouse", "lighthouse", "灯塔", "medium"),
  entry("volcano", "volcano", "火山", "medium"),
  entry("rainbow", "rainbow", "彩虹", "medium"),
  entry("penguin", "penguin", "企鹅", "medium"),
  entry("ice-cream", "ice cream", "冰淇淋", "medium", ["gelato"], ["冰激凌", "雪糕"]),
  entry("hot-dog", "hot dog", "热狗", "medium"),
  entry("dragon", "dragon", "龙", "medium"),
  entry("castle", "castle", "城堡", "medium"),
  entry("bicycle", "bicycle", "自行车", "medium", ["bike"], ["单车", "脚踏车"]),
  entry("rocket", "rocket", "火箭", "medium"),
  entry("snowman", "snowman", "雪人", "medium"),
  entry("pizza", "pizza", "披萨", "medium", [], ["比萨"]),
  entry("butterfly", "butterfly", "蝴蝶", "medium"),
  entry("mushroom", "mushroom", "蘑菇", "medium"),
  entry("camera", "camera", "相机", "medium", [], ["照相机"]),
  entry("teapot", "teapot", "茶壶", "medium"),
  entry("kite", "kite", "风筝", "medium"),
  entry("robot", "robot", "机器人", "medium", ["android"]),
  entry("astronaut", "astronaut", "宇航员", "hard", ["spaceman", "cosmonaut"], ["航天员"]),
  entry("time-machine", "time machine", "时光机", "hard"),
  entry("jellyfish", "jellyfish", "水母", "hard"),
  entry("telescope", "telescope", "望远镜", "hard"),
  entry("chameleon", "chameleon", "变色龙", "hard"),
  entry("skyscraper", "skyscraper", "摩天大楼", "hard"),
  entry("submarine", "submarine", "潜艇", "hard", [], ["潜水艇"]),
  entry("waterfall", "waterfall", "瀑布", "hard"),
  entry("scarecrow", "scarecrow", "稻草人", "hard"),
  entry("compass", "compass", "指南针", "hard"),
  entry("dumpling", "dumpling", "饺子", "hard", ["jiaozi"], ["水饺"]),
  entry("lantern", "lantern", "灯笼", "hard"),
  entry("traffic-jam", "traffic jam", "堵车", "hard", ["gridlock"], ["交通堵塞"]),
  entry("hourglass", "hourglass", "沙漏", "hard"),
  entry("origami", "origami", "折纸", "hard"),
  entry("tornado", "tornado", "龙卷风", "hard", ["twister"]),
  entry("octopus", "octopus", "章鱼", "hard"),
  entry("mermaid", "mermaid", "美人鱼", "hard"),
  entry("parachute", "parachute", "降落伞", "hard"),
  entry("windmill", "windmill", "风车", "hard"),
]);

// Blur stages over the guessing clock. `afterMs` is measured from the moment the
// image is shown; the last stage lasts until the round ends. After the round the
// image is always shown sharp (blurPx 0).
export const DEFAULT_REVEAL_SCHEDULE = Object.freeze([
  Object.freeze({ afterMs: 0, blurPx: 28 }),
  Object.freeze({ afterMs: 15000, blurPx: 16 }),
  Object.freeze({ afterMs: 30000, blurPx: 8 }),
  Object.freeze({ afterMs: 45000, blurPx: 2 }),
]);

export const DEFAULT_SCORING = Object.freeze({
  // Points for the 1st, 2nd, 3rd... correct guesser; later guessers get the last value.
  orderPoints: Object.freeze([10, 8, 6, 5, 4]),
  tierBonus: Object.freeze({ easy: 0, medium: 2, hard: 4 }),
  drawerPerCorrect: 3,
});

export const DEFAULT_CONFIG = Object.freeze({
  rotations: 1,
  difficulty: "mixed",
  wordChoices: 3,
  chooseTimeoutMs: 20000,
  promptTimeoutMs: 90000,
  roundDurationMs: 60000,
  maxGuessesPerRound: 5,
  maxPromptAttempts: 3,
  maxPromptLength: 400,
  maxGuessLength: 60,
  revealSchedule: DEFAULT_REVEAL_SCHEDULE,
  scoring: DEFAULT_SCORING,
});

export class DrawGuessRuleError extends Error {
  constructor(message, code = "illegal_action") {
    super(message);
    this.name = "DrawGuessRuleError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DrawGuessRuleError(message, code);
}

// ---------------------------------------------------------------------------
// Randomness

function mulberry32Step(stateValue) {
  const next = (stateValue + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/** Deterministic rng for tests and seeded tables. */
export function createSeededRng(seed) {
  let current = seed >>> 0;
  return () => {
    const step = mulberry32Step(current);
    current = step.next;
    return step.value;
  };
}

function random(state, rng) {
  if (typeof rng === "function") {
    const value = rng();
    if (!(value >= 0 && value < 1)) fail("bad_rng", "The injected rng must return a number in [0, 1)");
    return value;
  }
  const step = mulberry32Step(state.rngState);
  state.rngState = step.next;
  return step.value;
}

function randomInt(state, rng, exclusiveMax) {
  return Math.floor(random(state, rng) * exclusiveMax);
}

function shuffled(state, rng, items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = randomInt(state, rng, index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Text normalization, inflections, leak detection, guess matching

function baseNormalize(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'");
}

/** Lowercased word tokens. Separators inside a word (b-a-n, ice-cream, cat's) are collapsed. */
export function tokenize(text) {
  const collapsed = baseNormalize(text).replace(/(?<=[\p{L}\d])[-._*·'/]+(?=[\p{L}\d])/gu, "");
  return collapsed.split(/[^\p{L}\d]+/u).filter(Boolean);
}

function isVowel(char) {
  return "aeiou".includes(char);
}

/** Plural forms of one lowercase token, including the token itself. */
export function pluralForms(token) {
  const forms = new Set([token, `${token}s`, `${token}es`]);
  const last = token.at(-1);
  const beforeLast = token.at(-2) ?? "";
  if (last === "y" && !isVowel(beforeLast)) forms.add(`${token.slice(0, -1)}ies`);
  if (last === "f") forms.add(`${token.slice(0, -1)}ves`);
  if (token.endsWith("fe")) forms.add(`${token.slice(0, -2)}ves`);
  return forms;
}

/** Plurals plus simple verb inflections (-ed, -ing, -d, doubled consonant, dropped e, -ied). */
export function inflectedForms(token) {
  const forms = pluralForms(token);
  const last = token.at(-1);
  const beforeLast = token.at(-2) ?? "";
  forms.add(`${token}ed`);
  forms.add(`${token}ing`);
  if (last === "e") {
    forms.add(`${token}d`);
    forms.add(`${token.slice(0, -1)}ing`);
  }
  if (last === "y" && !isVowel(beforeLast)) forms.add(`${token.slice(0, -1)}ied`);
  if (token.length >= 3 && !isVowel(last) && isVowel(beforeLast) && !"wxy".includes(last)) {
    forms.add(`${token}${last}ed`);
    forms.add(`${token}${last}ing`);
  }
  return forms;
}

function englishAnswers(wordEntry) {
  return [wordEntry.word, ...(wordEntry.synonyms ?? [])].map((answer) => tokenize(answer)).filter((tokens) => tokens.length);
}

function chineseAnswers(wordEntry) {
  return [wordEntry.zh, ...(wordEntry.zhSynonyms ?? [])]
    .map((answer) => compactCjk(answer))
    .filter(Boolean);
}

function compactCjk(text) {
  return baseNormalize(text).replace(/[\s\p{P}\p{S}]+/gu, "");
}

function tokensMatchSequence(tokens, start, answerTokens, formsOf) {
  for (let offset = 0; offset < answerTokens.length; offset += 1) {
    const token = tokens[start + offset];
    if (token === undefined || !formsOf(answerTokens[offset]).has(token)) return false;
  }
  return true;
}

/**
 * Checks whether `text` gives away the secret word: the word or a synonym (also
 * pluralized or inflected, also written without spaces), its Chinese translation,
 * or the word spelled out letter by letter. Returns null when clean, otherwise
 * { reason, match } where reason is "word", "synonym", "chinese" or "spelled_out".
 */
export function findPromptLeak(text, wordEntry) {
  const tokens = tokenize(text);
  const answers = [
    { tokens: tokenize(wordEntry.word), reason: "word" },
    ...(wordEntry.synonyms ?? []).map((synonym) => ({ tokens: tokenize(synonym), reason: "synonym" })),
  ].filter((answer) => answer.tokens.length);

  for (const answer of answers) {
    const compactForms = inflectedForms(answer.tokens.join(""));
    for (let index = 0; index < tokens.length; index += 1) {
      if (compactForms.has(tokens[index])) return { reason: answer.reason, match: tokens[index] };
      if (answer.tokens.length > 1 && tokensMatchSequence(tokens, index, answer.tokens, inflectedForms)) {
        return { reason: answer.reason, match: tokens.slice(index, index + answer.tokens.length).join(" ") };
      }
    }
  }

  const compactText = compactCjk(text);
  for (const zh of chineseAnswers(wordEntry)) {
    if (compactText.includes(zh)) return { reason: "chinese", match: zh };
  }

  // Runs of single-character tokens: "b a n a n a", "B, A, N, A, N, A".
  let run = "";
  const runs = [];
  for (const token of tokens) {
    if (token.length === 1) run += token;
    else {
      if (run.length > 1) runs.push(run);
      run = "";
    }
  }
  if (run.length > 1) runs.push(run);
  for (const answer of answers) {
    const compact = answer.tokens.join("");
    for (const letters of runs) {
      if (compact.length > 1 && (letters.includes(compact) || letters.includes([...compact].reverse().join("")))) {
        return { reason: "spelled_out", match: letters };
      }
    }
  }
  return null;
}

const LEADING_ARTICLES = new Set(["a", "an", "the"]);

/** Guess normalization: case, accents, punctuation, whitespace, leading article. */
export function normalizeGuess(text) {
  const tokens = tokenize(text);
  while (tokens.length > 1 && LEADING_ARTICLES.has(tokens[0])) tokens.shift();
  return tokens.join(" ");
}

/** True when the guess names the word or a listed synonym (English plurals allowed) or its Chinese translation. */
export function isCorrectGuess(text, wordEntry) {
  const normalized = normalizeGuess(text);
  if (!normalized) return false;
  const tokens = normalized.split(" ");
  for (const answer of englishAnswers(wordEntry)) {
    if (pluralForms(answer.join("")).has(tokens.join(""))) return true;
    if (tokens.length === answer.length && tokensMatchSequence(tokens, 0, answer, pluralForms)) return true;
  }
  const compact = compactCjk(text);
  return chineseAnswers(wordEntry).includes(compact);
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        above + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

/** A wrong guess within one typo (two for answers of 8+ letters) of an English answer. */
export function isCloseGuess(text, wordEntry) {
  if (isCorrectGuess(text, wordEntry)) return false;
  const compact = normalizeGuess(text).replace(/ /g, "");
  if (compact.length < 3) return false;
  return englishAnswers(wordEntry).some((answer) => {
    const target = answer.join("");
    if (target.length < 4) return false;
    return editDistance(compact, target) <= (target.length >= 8 ? 2 : 1);
  });
}

// ---------------------------------------------------------------------------
// Configuration and creation

function validateWordBank(bank) {
  if (!Array.isArray(bank) || bank.length === 0) fail("bad_config", "The word bank must be a non-empty array");
  const ids = new Set();
  for (const item of bank) {
    if (!item || typeof item !== "object") fail("bad_config", "Every word bank entry must be an object");
    if (typeof item.id !== "string" || !item.id) fail("bad_config", "Every word bank entry needs an id");
    if (ids.has(item.id)) fail("bad_config", `Duplicate word bank id “${item.id}”`);
    ids.add(item.id);
    if (typeof item.word !== "string" || tokenize(item.word).length === 0) fail("bad_config", `Word bank entry ${item.id} needs an English word`);
    if (typeof item.zh !== "string" || !compactCjk(item.zh)) fail("bad_config", `Word bank entry ${item.id} needs a Chinese translation`);
    if (!DIFFICULTIES.includes(item.difficulty)) fail("bad_config", `Word bank entry ${item.id} has an unknown difficulty`);
    for (const key of ["synonyms", "zhSynonyms"]) {
      if (item[key] !== undefined && !(Array.isArray(item[key]) && item[key].every((value) => typeof value === "string"))) {
        fail("bad_config", `Word bank entry ${item.id} has an invalid ${key} list`);
      }
    }
  }
  return bank.map((item) => ({
    id: item.id,
    word: item.word,
    zh: item.zh,
    difficulty: item.difficulty,
    synonyms: [...(item.synonyms ?? [])],
    zhSynonyms: [...(item.zhSynonyms ?? [])],
  }));
}

function intInRange(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail("bad_config", `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function normalizeConfig(config = {}) {
  const difficulty = config.difficulty ?? DEFAULT_CONFIG.difficulty;
  if (difficulty !== "mixed" && !DIFFICULTIES.includes(difficulty)) fail("bad_config", "difficulty must be easy, medium, hard or mixed");
  const revealSchedule = config.revealSchedule ?? DEFAULT_REVEAL_SCHEDULE;
  if (
    !Array.isArray(revealSchedule)
    || revealSchedule.length === 0
    || revealSchedule[0].afterMs !== 0
    || revealSchedule.some((stage, index) => !Number.isFinite(stage?.afterMs) || !Number.isFinite(stage?.blurPx) || stage.blurPx < 0
      || (index > 0 && stage.afterMs <= revealSchedule[index - 1].afterMs))
  ) {
    fail("bad_config", "revealSchedule must start at afterMs 0 and increase strictly, with blurPx >= 0");
  }
  const scoring = { ...DEFAULT_SCORING, ...(config.scoring ?? {}) };
  if (!Array.isArray(scoring.orderPoints) || scoring.orderPoints.length === 0 || !scoring.orderPoints.every((points) => Number.isInteger(points) && points >= 0)) {
    fail("bad_config", "scoring.orderPoints must be a non-empty list of non-negative integers");
  }
  if (!DIFFICULTIES.every((tier) => Number.isInteger(scoring.tierBonus?.[tier]) && scoring.tierBonus[tier] >= 0)) {
    fail("bad_config", "scoring.tierBonus needs a non-negative integer per difficulty");
  }
  if (!Number.isInteger(scoring.drawerPerCorrect) || scoring.drawerPerCorrect < 0) fail("bad_config", "scoring.drawerPerCorrect must be a non-negative integer");
  return {
    rotations: intInRange(config.rotations, DEFAULT_CONFIG.rotations, 1, 10, "rotations"),
    difficulty,
    wordChoices: intInRange(config.wordChoices, DEFAULT_CONFIG.wordChoices, 1, 5, "wordChoices"),
    chooseTimeoutMs: intInRange(config.chooseTimeoutMs, DEFAULT_CONFIG.chooseTimeoutMs, 1000, 600000, "chooseTimeoutMs"),
    promptTimeoutMs: intInRange(config.promptTimeoutMs, DEFAULT_CONFIG.promptTimeoutMs, 1000, 600000, "promptTimeoutMs"),
    roundDurationMs: intInRange(config.roundDurationMs, DEFAULT_CONFIG.roundDurationMs, 5000, 600000, "roundDurationMs"),
    maxGuessesPerRound: intInRange(config.maxGuessesPerRound, DEFAULT_CONFIG.maxGuessesPerRound, 1, 50, "maxGuessesPerRound"),
    maxPromptAttempts: intInRange(config.maxPromptAttempts, DEFAULT_CONFIG.maxPromptAttempts, 1, 10, "maxPromptAttempts"),
    maxPromptLength: intInRange(config.maxPromptLength, DEFAULT_CONFIG.maxPromptLength, 40, 2000, "maxPromptLength"),
    maxGuessLength: intInRange(config.maxGuessLength, DEFAULT_CONFIG.maxGuessLength, 10, 200, "maxGuessLength"),
    revealSchedule: revealSchedule.map((stage) => ({ afterMs: stage.afterMs, blurPx: stage.blurPx })),
    scoring: {
      orderPoints: [...scoring.orderPoints],
      tierBonus: { ...scoring.tierBonus },
      drawerPerCorrect: scoring.drawerPerCorrect,
    },
  };
}

function normalizeSeats(seats) {
  if (!Array.isArray(seats) || seats.length < MIN_SEATS || seats.length > MAX_SEATS) {
    fail("bad_config", `Draw & Guess needs ${MIN_SEATS} to ${MAX_SEATS} seats`);
  }
  const ids = new Set();
  return seats.map((seat, index) => {
    const kind = seat?.kind === "human" ? "human" : "ai";
    const id = String(seat?.id ?? `seat-${index}`);
    if (ids.has(id)) fail("bad_config", `Duplicate seat id “${id}”`);
    ids.add(id);
    return {
      seat: index,
      id,
      name: String(seat?.name ?? `Player ${index + 1}`).trim().slice(0, 24) || `Player ${index + 1}`,
      kind,
      characterId: seat?.characterId ?? null,
      score: 0,
    };
  });
}

/**
 * Creates a new table. `config.seats` is an array of { id, name, kind: "human"|"ai", characterId }.
 * Options: { rng, now, seed }. `config.firstDrawerSeat` fixes who draws first; otherwise it is random.
 */
export function createDrawGuessGame(config = {}, options = {}) {
  const seats = normalizeSeats(config.seats);
  const seed = Number.isInteger(options.seed ?? config.seed)
    ? (options.seed ?? config.seed) >>> 0
    : Math.floor(Math.random() * 4294967296) >>> 0;
  const state = {
    gameId: DRAW_GUESS_GAME_ID,
    version: DRAW_GUESS_SAVE_VERSION,
    config: normalizeConfig(config),
    customWordBank: config.wordBank ? validateWordBank(config.wordBank) : null,
    seats,
    rngState: seed,
    phase: "choosing",
    turnNumber: 0,
    totalTurns: 0,
    drawerOrder: [],
    usedWordIds: [],
    round: null,
    history: [],
    result: null,
  };
  state.totalTurns = seats.length * state.config.rotations;
  let first;
  if (config.firstDrawerSeat !== undefined) {
    if (!Number.isInteger(config.firstDrawerSeat) || !seats[config.firstDrawerSeat]) fail("bad_config", "firstDrawerSeat is not a seat");
    first = config.firstDrawerSeat;
  } else {
    first = randomInt(state, options.rng, seats.length);
  }
  state.drawerOrder = seats.map((_, offset) => (first + offset) % seats.length);
  startRound(state, options.rng, nowFrom(options));
  return state;
}

export function wordBankOf(state) {
  return state.customWordBank ?? DEFAULT_WORD_BANK;
}

export function wordById(state, wordId) {
  const found = wordBankOf(state).find((item) => item.id === wordId);
  if (!found) fail("bad_state", `Unknown word id “${wordId}”`);
  return found;
}

function nowFrom(options) {
  const now = options?.now ?? Date.now();
  if (!Number.isFinite(now)) fail("bad_time", "now must be a finite epoch millisecond value");
  return now;
}

function pickWordOptions(state, rng) {
  const bank = wordBankOf(state);
  const used = new Set(state.usedWordIds);
  const { difficulty, wordChoices } = state.config;
  let fresh = bank.filter((item) => !used.has(item.id));
  if (fresh.length < wordChoices) {
    // The bank ran dry: allow repeats again rather than stalling the table.
    state.usedWordIds = [];
    fresh = [...bank];
  }
  const options = [];
  const take = (pool) => {
    const available = pool.filter((item) => !options.includes(item.id));
    if (!available.length) return false;
    options.push(available[randomInt(state, rng, available.length)].id);
    return true;
  };
  const tiers = difficulty === "mixed" ? DIFFICULTIES : [difficulty];
  for (let index = 0; options.length < wordChoices && index < wordChoices * 4; index += 1) {
    const tier = tiers[index % tiers.length];
    if (!take(fresh.filter((item) => item.difficulty === tier))) take(fresh);
  }
  if (options.length < wordChoices) fail("bad_config", "The word bank is too small for the requested word choices");
  return shuffled(state, rng, options);
}

function startRound(state, rng, now) {
  const drawerSeat = state.drawerOrder[state.turnNumber % state.seats.length];
  state.turnNumber += 1;
  state.phase = "choosing";
  state.round = {
    number: state.turnNumber,
    rotation: Math.ceil(state.turnNumber / state.seats.length),
    drawerSeat,
    wordOptions: pickWordOptions(state, rng),
    wordId: null,
    difficulty: null,
    phaseStartedAt: now,
    deadlineAt: now + state.config.chooseTimeoutMs,
    promptAttempts: [],
    prompt: null,
    imageRef: null,
    imageSource: null,
    guessingStartedAt: null,
    guesses: [],
    solvedOrder: [],
    passedSeats: [],
    talk: [],
    points: Object.fromEntries(state.seats.map((seat) => [seat.seat, 0])),
    endReason: null,
  };
}

// ---------------------------------------------------------------------------
// Queries

export function guesserSeats(state) {
  return state.seats.map((seat) => seat.seat).filter((seat) => seat !== state.round?.drawerSeat);
}

export function guessesUsed(state, seat) {
  return state.round ? state.round.guesses.filter((guess) => guess.seat === seat).length : 0;
}

/** Whether a guesser can still guess this round (not solved, not passed, guesses left). */
export function guesserIsActive(state, seat) {
  const round = state.round;
  if (!round || state.phase !== "guessing" || seat === round.drawerSeat || !state.seats[seat]) return false;
  if (round.solvedOrder.includes(seat) || round.passedSeats.includes(seat)) return false;
  return guessesUsed(state, seat) < state.config.maxGuessesPerRound;
}

/** Whether this seat currently knows the secret word. */
export function seatKnowsWord(state, seat) {
  const round = state.round;
  if (!round || round.wordId === null) return false;
  if (state.phase === "round_over" || state.phase === "game_over") return true;
  return seat === round.drawerSeat || round.solvedOrder.includes(seat);
}

/** Current blur stage for the guessing image: { stage, blurPx, nextChangeAt, stages }. */
export function revealAt(state, now) {
  const schedule = state.config.revealSchedule;
  const round = state.round;
  if (!round || round.guessingStartedAt === null) return { stage: 0, blurPx: schedule[0].blurPx, nextChangeAt: null, stages: schedule.length };
  if (state.phase !== "guessing") return { stage: schedule.length, blurPx: 0, nextChangeAt: null, stages: schedule.length };
  const elapsed = Math.max(0, now - round.guessingStartedAt);
  let stage = 0;
  for (let index = 0; index < schedule.length; index += 1) if (elapsed >= schedule[index].afterMs) stage = index;
  const next = schedule[stage + 1];
  return {
    stage,
    blurPx: schedule[stage].blurPx,
    nextChangeAt: next ? round.guessingStartedAt + next.afterMs : null,
    stages: schedule.length,
  };
}

export function guesserPointsFor(state, orderIndex, difficulty) {
  const { orderPoints, tierBonus } = state.config.scoring;
  return (orderPoints[orderIndex] ?? orderPoints.at(-1)) + tierBonus[difficulty];
}

/**
 * Legal actions for one seat right now. Free-text fields are templates: the
 * caller fills `prompt` / `text`. System actions (seat null) are listed by
 * systemActions().
 */
export function legalActions(state, seat, options = {}) {
  const round = state.round;
  if (!round || !state.seats[seat]) return [];
  const now = nowFrom(options);
  if (now >= round.deadlineAt && ["choosing", "prompting", "guessing"].includes(state.phase)) return [];
  if (state.phase === "choosing" && seat === round.drawerSeat) {
    return round.wordOptions.map((wordId, optionIndex) => ({ type: "choose_word", seat, optionIndex, wordId }));
  }
  if (state.phase === "prompting" && seat === round.drawerSeat) {
    const actions = [{ type: "submit_prompt", seat, prompt: "" }];
    if (state.seats[seat].kind === "human") actions.push({ type: "submit_sketch", seat, imageRef: "" });
    return actions;
  }
  if (state.phase === "guessing" && guesserIsActive(state, seat)) {
    return [{ type: "guess", seat, text: "" }, { type: "pass", seat }];
  }
  return [];
}

/** Actions only the room (no seat) may apply right now. */
export function systemActions(state, options = {}) {
  const now = nowFrom(options);
  const round = state.round;
  if (state.phase === "rendering") return [{ type: "image_ready", imageRef: "" }, { type: "image_failed", reason: "" }];
  if (state.phase === "round_over") return [{ type: "next_round" }];
  if (round && ["choosing", "prompting", "guessing"].includes(state.phase) && now >= round.deadlineAt) return [{ type: "tick" }];
  return [];
}

// ---------------------------------------------------------------------------
// Applying actions

const SEAT_ACTIONS = new Set(["choose_word", "submit_prompt", "submit_sketch", "guess", "pass"]);
const SYSTEM_ACTIONS = new Set(["image_ready", "image_failed", "tick", "next_round"]);

function requireSeatTurn(state, action, now) {
  if (!Number.isInteger(action.seat) || !state.seats[action.seat]) fail("bad_seat", "The action needs a valid seat");
  if (now >= state.round.deadlineAt) fail("time_up", "Time is up for this phase; the room must apply a tick");
}

function checkTableTalk(state, action) {
  if (action.tableTalk === undefined || action.tableTalk === null) return null;
  if (typeof action.tableTalk !== "string") fail("bad_table_talk", "tableTalk must be a string");
  const talk = action.tableTalk.trim();
  if (talk.length > MAX_TABLE_TALK) fail("bad_table_talk", `tableTalk must be at most ${MAX_TABLE_TALK} characters`);
  if (!talk) return null;
  const round = state.round;
  if (round.wordId !== null) {
    const leak = findPromptLeak(talk, wordById(state, round.wordId));
    if (leak) fail("talk_leak", `tableTalk may not reveal the secret word (${leak.reason}: “${leak.match}”)`);
  }
  return talk;
}

function addTalk(state, seat, talk, now, events) {
  if (!talk) return;
  state.round.talk.push({ seat, text: talk, at: now });
  events.push({ type: "table_talk", seat, text: talk });
}

function validateInPlace(state, action, now) {
  if (!action || typeof action !== "object" || typeof action.type !== "string") fail("bad_action", "An action needs a type");
  if (state.phase === "game_over") fail("game_over", "The game is over");
  const round = state.round;
  const isSystem = SYSTEM_ACTIONS.has(action.type);
  if (!isSystem && !SEAT_ACTIONS.has(action.type)) fail("bad_action", `Unknown Draw & Guess action “${action.type}”`);
  if (isSystem && action.seat !== undefined && action.seat !== null) fail("bad_seat", `${action.type} is a system action and takes no seat`);

  switch (action.type) {
    case "choose_word": {
      if (state.phase !== "choosing") fail("wrong_phase", "No word is being chosen now");
      requireSeatTurn(state, action, now);
      if (action.seat !== round.drawerSeat) fail("not_drawer", "Only the drawer chooses the word");
      if (!Number.isInteger(action.optionIndex) || action.optionIndex < 0 || action.optionIndex >= round.wordOptions.length) {
        fail("bad_option", `optionIndex must be from 0 to ${round.wordOptions.length - 1}`);
      }
      checkTableTalk(state, action);
      return;
    }
    case "submit_prompt": {
      if (state.phase !== "prompting") fail("wrong_phase", "No prompt is expected now");
      requireSeatTurn(state, action, now);
      if (action.seat !== round.drawerSeat) fail("not_drawer", "Only the drawer writes the image prompt");
      if (typeof action.prompt !== "string" || !action.prompt.trim()) fail("empty_prompt", "The image prompt is empty");
      if (action.prompt.trim().length > state.config.maxPromptLength) {
        fail("prompt_too_long", `The image prompt must be at most ${state.config.maxPromptLength} characters`);
      }
      checkTableTalk(state, action);
      return;
    }
    case "submit_sketch": {
      if (state.phase !== "prompting") fail("wrong_phase", "No drawing is expected now");
      requireSeatTurn(state, action, now);
      if (action.seat !== round.drawerSeat) fail("not_drawer", "Only the drawer submits the drawing");
      if (state.seats[action.seat].kind !== "human") fail("not_human", "Only a human drawer may submit a hand sketch");
      if (typeof action.imageRef !== "string" || !action.imageRef.trim()) fail("bad_image", "The sketch needs an imageRef");
      checkTableTalk(state, action);
      return;
    }
    case "guess":
    case "pass": {
      if (state.phase !== "guessing") fail("wrong_phase", "Guessing is not open");
      requireSeatTurn(state, action, now);
      if (action.seat === round.drawerSeat) fail("is_drawer", "The drawer cannot guess");
      if (round.solvedOrder.includes(action.seat)) fail("already_solved", "This seat already guessed the word");
      if (round.passedSeats.includes(action.seat)) fail("already_passed", "This seat passed for the rest of the round");
      if (guessesUsed(state, action.seat) >= state.config.maxGuessesPerRound) fail("no_guesses_left", "No guesses left this round");
      if (action.type === "guess") {
        if (typeof action.text !== "string") fail("empty_guess", "The guess is empty");
        const normalized = normalizeGuess(action.text);
        if (!normalized && !compactCjk(action.text)) fail("empty_guess", "The guess is empty");
        if (action.text.trim().length > state.config.maxGuessLength) fail("guess_too_long", `A guess must be at most ${state.config.maxGuessLength} characters`);
        const repeated = round.guesses.some((guess) => guess.seat === action.seat
          && guess.normalized === normalized && compactCjk(guess.text) === compactCjk(action.text));
        if (repeated) fail("repeated_guess", `You already guessed “${action.text.trim()}” this round`);
      }
      checkTableTalk(state, action);
      return;
    }
    case "image_ready": {
      if (state.phase !== "rendering") fail("wrong_phase", "No image is being rendered");
      if (typeof action.imageRef !== "string" || !action.imageRef.trim()) fail("bad_image", "image_ready needs an imageRef");
      return;
    }
    case "image_failed": {
      if (state.phase !== "rendering") fail("wrong_phase", "No image is being rendered");
      return;
    }
    case "tick": {
      if (!["choosing", "prompting", "guessing"].includes(state.phase)) fail("wrong_phase", "Nothing is timed now");
      if (now < round.deadlineAt) fail("not_yet", "The phase deadline has not passed");
      return;
    }
    case "next_round": {
      if (state.phase !== "round_over") fail("wrong_phase", "The round is not over");
      return;
    }
    default:
      fail("bad_action", `Unknown Draw & Guess action “${action.type}”`);
  }
}

/** Dry-run check. Returns { ok: true } or { ok: false, code, message }. Never mutates. */
export function validateAction(state, action, options = {}) {
  try {
    validateInPlace(state, action, nowFrom(options));
    return { ok: true };
  } catch (error) {
    if (error instanceof DrawGuessRuleError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

function chooseWord(state, optionIndex, now, events, auto = false) {
  const round = state.round;
  const wordId = round.wordOptions[optionIndex];
  const word = wordById(state, wordId);
  round.wordId = wordId;
  round.difficulty = word.difficulty;
  state.usedWordIds.push(wordId);
  state.phase = "prompting";
  round.phaseStartedAt = now;
  round.deadlineAt = now + state.config.promptTimeoutMs;
  events.push({ type: "word_chosen", seat: round.drawerSeat, difficulty: word.difficulty, auto });
}

function startGuessing(state, imageRef, source, now, events) {
  const round = state.round;
  round.imageRef = imageRef;
  round.imageSource = source;
  state.phase = "guessing";
  round.guessingStartedAt = now;
  round.phaseStartedAt = now;
  round.deadlineAt = now + state.config.roundDurationMs;
  events.push({ type: "guessing_started", imageRef, source, deadlineAt: round.deadlineAt });
}

function endRound(state, reason, now, events) {
  const round = state.round;
  const scored = reason === "all_solved" || reason === "time_up" || reason === "all_done";
  if (scored) {
    round.solvedOrder.forEach((seat, orderIndex) => {
      round.points[seat] = guesserPointsFor(state, orderIndex, round.difficulty);
    });
    round.points[round.drawerSeat] = round.solvedOrder.length * state.config.scoring.drawerPerCorrect;
  }
  for (const seat of state.seats) seat.score += round.points[seat.seat];
  round.endReason = reason;
  round.deadlineAt = null;
  round.phaseStartedAt = now;
  state.phase = "round_over";
  const word = round.wordId ? wordById(state, round.wordId) : null;
  state.history.push({
    number: round.number,
    drawerSeat: round.drawerSeat,
    wordId: round.wordId,
    word: word?.word ?? null,
    zh: word?.zh ?? null,
    difficulty: round.difficulty,
    prompt: round.prompt,
    imageRef: round.imageRef,
    solvedOrder: [...round.solvedOrder],
    points: { ...round.points },
    endReason: reason,
  });
  events.push({ type: "round_over", reason, wordId: round.wordId, word: word?.word ?? null, zh: word?.zh ?? null, points: { ...round.points } });
}

function finishGame(state, events) {
  state.phase = "game_over";
  const ordered = [...state.seats].sort((left, right) => right.score - left.score || left.seat - right.seat);
  const standings = ordered.map((seat) => ({
    seat: seat.seat,
    score: seat.score,
    rank: 1 + ordered.filter((other) => other.score > seat.score).length,
  }));
  const top = ordered[0].score;
  state.result = { standings, winners: ordered.filter((seat) => seat.score === top).map((seat) => seat.seat) };
  events.push({ type: "game_over", result: structuredClone(state.result) });
}

function maybeFinishGuessing(state, now, events) {
  const round = state.round;
  const guessers = guesserSeats(state);
  if (round.solvedOrder.length === guessers.length) return endRound(state, "all_solved", now, events);
  if (guessers.every((seat) => !guesserIsActive(state, seat))) return endRound(state, "all_done", now, events);
  return undefined;
}

/**
 * Applies one action and returns { state, events } with a new state; the input
 * state is never mutated. Throws DrawGuessRuleError (with .code) on an illegal
 * action. A leaking prompt is NOT an error: it is recorded as a rejected attempt
 * (event "prompt_rejected"); after config.maxPromptAttempts rejections the round
 * is void ("prompt_failed").
 */
export function applyAction(inputState, action, options = {}) {
  const now = nowFrom(options);
  validateInPlace(inputState, action, now);
  const state = structuredClone(inputState);
  const { rng } = options;
  const round = state.round;
  const events = [];

  switch (action.type) {
    case "choose_word": {
      const talk = checkTableTalk(state, action);
      chooseWord(state, action.optionIndex, now, events);
      addTalk(state, action.seat, talk, now, events);
      break;
    }
    case "submit_prompt": {
      const prompt = action.prompt.trim();
      const leak = findPromptLeak(prompt, wordById(state, round.wordId));
      round.promptAttempts.push({ prompt, accepted: !leak, leak, at: now });
      const talk = checkTableTalk(state, action);
      if (leak) {
        const attemptsLeft = state.config.maxPromptAttempts - round.promptAttempts.length;
        events.push({ type: "prompt_rejected", seat: action.seat, leak, attemptsLeft });
        if (attemptsLeft <= 0) endRound(state, "prompt_failed", now, events);
        break;
      }
      round.prompt = prompt;
      state.phase = "rendering";
      round.phaseStartedAt = now;
      round.deadlineAt = null;
      events.push({ type: "prompt_accepted", seat: action.seat });
      addTalk(state, action.seat, talk, now, events);
      break;
    }
    case "submit_sketch": {
      const talk = checkTableTalk(state, action);
      startGuessing(state, action.imageRef.trim(), "sketch", now, events);
      addTalk(state, action.seat, talk, now, events);
      break;
    }
    case "image_ready":
      startGuessing(state, action.imageRef.trim(), "generated", now, events);
      break;
    case "image_failed":
      events.push({ type: "image_failed", reason: String(action.reason ?? "").slice(0, 200) });
      endRound(state, "image_failed", now, events);
      break;
    case "guess": {
      const talk = checkTableTalk(state, action);
      const text = action.text.trim();
      const word = wordById(state, round.wordId);
      const correct = isCorrectGuess(text, word);
      const close = !correct && isCloseGuess(text, word);
      round.guesses.push({ seat: action.seat, text, normalized: normalizeGuess(text), correct, close, at: now });
      if (correct) {
        round.solvedOrder.push(action.seat);
        events.push({ type: "guess_correct", seat: action.seat, order: round.solvedOrder.length });
      } else {
        events.push({ type: "guess_wrong", seat: action.seat, text, close, guessesLeft: state.config.maxGuessesPerRound - guessesUsed(state, action.seat) });
      }
      addTalk(state, action.seat, talk, now, events);
      maybeFinishGuessing(state, now, events);
      break;
    }
    case "pass": {
      const talk = checkTableTalk(state, action);
      round.passedSeats.push(action.seat);
      events.push({ type: "guesser_passed", seat: action.seat });
      addTalk(state, action.seat, talk, now, events);
      maybeFinishGuessing(state, now, events);
      break;
    }
    case "tick": {
      if (state.phase === "choosing") {
        chooseWord(state, randomInt(state, rng, round.wordOptions.length), now, events, true);
      } else if (state.phase === "prompting") {
        endRound(state, "prompt_timeout", now, events);
      } else {
        endRound(state, "time_up", now, events);
      }
      break;
    }
    case "next_round": {
      if (state.turnNumber >= state.totalTurns) finishGame(state, events);
      else {
        startRound(state, rng, now);
        events.push({ type: "round_started", number: state.round.number, drawerSeat: state.round.drawerSeat });
      }
      break;
    }
    default:
      fail("bad_action", `Unknown Draw & Guess action “${action.type}”`);
  }
  return { state, events };
}

// ---------------------------------------------------------------------------
// External-call interfaces (image generation and vision are done by the room)

/** What the room should render while phase is "rendering", else null. */
export function imageRequestFor(state) {
  if (state.phase !== "rendering") return null;
  return { roundNumber: state.round.number, drawerSeat: state.round.drawerSeat, prompt: state.round.prompt };
}

/** What a guesser may look at right now, else null. The room applies blurPx before display or vision. */
export function visionInputFor(state, seat, now) {
  const round = state.round;
  if (!round?.imageRef) return null;
  if (state.phase === "guessing") {
    if (!state.seats[seat]) return null;
    const reveal = revealAt(state, now);
    const sharp = seat === round.drawerSeat || round.solvedOrder.includes(seat);
    return { imageRef: round.imageRef, blurPx: sharp ? 0 : reveal.blurPx, stage: reveal.stage };
  }
  if (state.phase === "round_over" || state.phase === "game_over") return { imageRef: round.imageRef, blurPx: 0, stage: state.config.revealSchedule.length };
  return null;
}

// ---------------------------------------------------------------------------
// Views

function publicWord(word) {
  return word ? { id: word.id, word: word.word, zh: word.zh, difficulty: word.difficulty } : null;
}

/**
 * Redacted state for one seat (or spectators with seat null). The secret word,
 * word options, prompts and correct guess texts are hidden from anyone who must
 * not know them yet. `revealSecret: true` gives an omniscient spectator view
 * (AI-vs-AI arena).
 */
export function viewFor(state, seat = null, options = {}) {
  const now = nowFrom(options);
  const round = state.round;
  const omniscient = Boolean(options.revealSecret);
  const knows = omniscient || (seat !== null && seatKnowsWord(state, seat));
  const isDrawer = seat !== null && round?.drawerSeat === seat;
  const roundEnded = state.phase === "round_over" || state.phase === "game_over";
  const word = round?.wordId ? wordById(state, round.wordId) : null;
  return {
    gameId: state.gameId,
    phase: state.phase,
    viewerSeat: seat,
    turnNumber: state.turnNumber,
    totalTurns: state.totalTurns,
    config: structuredClone(state.config),
    seats: state.seats.map((entrySeat) => ({ ...entrySeat })),
    result: state.result ? structuredClone(state.result) : null,
    history: state.history.map((item) => ({ ...item, solvedOrder: [...item.solvedOrder], points: { ...item.points } })),
    round: round ? {
      number: round.number,
      rotation: round.rotation,
      drawerSeat: round.drawerSeat,
      deadlineAt: round.deadlineAt,
      difficulty: round.difficulty,
      wordOptions: isDrawer || omniscient ? round.wordOptions.map((id) => publicWord(wordById(state, id))) : null,
      secret: knows ? publicWord(word) : null,
      wordLength: word ? word.word.length : null,
      wordShape: word ? word.word.replace(/[a-z]/gi, "_") : null,
      prompt: isDrawer || omniscient || roundEnded ? round.prompt : null,
      promptAttempts: isDrawer || omniscient ? round.promptAttempts.map((attempt) => ({ ...attempt })) : null,
      promptAttemptsLeft: state.config.maxPromptAttempts - round.promptAttempts.length,
      image: seat === null && !omniscient && state.phase === "guessing"
        ? (round.imageRef ? { imageRef: round.imageRef, ...pickReveal(revealAt(state, now)) } : null)
        : visionInputFor(state, seat ?? round.drawerSeat, now),
      reveal: revealAt(state, now),
      guesses: round.guesses.map((guess) => ({
        seat: guess.seat,
        text: !guess.correct || knows || roundEnded || guess.seat === seat ? guess.text : null,
        correct: guess.correct,
        close: guess.seat === seat || knows ? guess.close : false,
        at: guess.at,
      })),
      solvedOrder: [...round.solvedOrder],
      passedSeats: [...round.passedSeats],
      talk: round.talk.map((item) => ({ ...item })),
      points: roundEnded ? { ...round.points } : null,
      endReason: round.endReason,
    } : null,
  };
}

function pickReveal(reveal) {
  return { blurPx: reveal.blurPx, stage: reveal.stage };
}

// ---------------------------------------------------------------------------
// Save and resume

function requireSaved(condition, message) {
  if (!condition) throw new DrawGuessRuleError(`Invalid Draw & Guess save: ${message}`, "bad_save");
}

export function toSave(state, savedAt = new Date().toISOString()) {
  return { gameId: DRAW_GUESS_GAME_ID, version: DRAW_GUESS_SAVE_VERSION, savedAt, state: structuredClone(state) };
}

export function fromSave(payload) {
  requireSaved(payload && typeof payload === "object", "payload is missing");
  requireSaved(payload.gameId === DRAW_GUESS_GAME_ID, "game identifier is not draw-guess");
  requireSaved(payload.version === DRAW_GUESS_SAVE_VERSION, `unsupported version ${payload.version}`);
  const saved = payload.state;
  requireSaved(saved && typeof saved === "object", "state is missing");
  requireSaved(PHASES.includes(saved.phase), "phase is invalid");
  let state;
  try {
    // Re-normalizing catches tampered config, seats and word banks.
    const seats = normalizeSeats(saved.seats);
    state = {
      gameId: DRAW_GUESS_GAME_ID,
      version: DRAW_GUESS_SAVE_VERSION,
      config: normalizeConfig(saved.config),
      customWordBank: saved.customWordBank ? validateWordBank(saved.customWordBank) : null,
      seats: seats.map((seat, index) => ({ ...seat, score: saved.seats[index].score })),
      rngState: saved.rngState,
      phase: saved.phase,
      turnNumber: saved.turnNumber,
      totalTurns: saved.totalTurns,
      drawerOrder: structuredClone(saved.drawerOrder),
      usedWordIds: structuredClone(saved.usedWordIds),
      round: structuredClone(saved.round),
      history: structuredClone(saved.history),
      result: structuredClone(saved.result ?? null),
    };
  } catch (error) {
    if (error instanceof DrawGuessRuleError) requireSaved(false, error.message);
    throw error;
  }
  const seatCount = state.seats.length;
  const isSeat = (value) => Number.isInteger(value) && value >= 0 && value < seatCount;
  requireSaved(state.seats.every((seat) => Number.isInteger(seat.score) && seat.score >= 0), "scores are invalid");
  requireSaved(Number.isInteger(state.rngState) && state.rngState >= 0 && state.rngState <= 0xffffffff, "rng state is invalid");
  requireSaved(state.totalTurns === seatCount * state.config.rotations, "total turns do not match seats and rotations");
  requireSaved(Number.isInteger(state.turnNumber) && state.turnNumber >= 1 && state.turnNumber <= state.totalTurns, "turn number is invalid");
  requireSaved(Array.isArray(state.drawerOrder) && state.drawerOrder.length === seatCount
    && new Set(state.drawerOrder).size === seatCount && state.drawerOrder.every(isSeat), "drawer order is invalid");
  requireSaved(Array.isArray(state.usedWordIds) && state.usedWordIds.every((id) => typeof id === "string"), "used words are invalid");
  requireSaved(Array.isArray(state.history), "history is invalid");
  const round = state.round;
  requireSaved(round && typeof round === "object", "round is missing");
  requireSaved(round.number === state.turnNumber, "round number does not match turn number");
  requireSaved(round.drawerSeat === state.drawerOrder[(state.turnNumber - 1) % seatCount], "drawer does not match rotation");
  const bankIds = new Set(wordBankOf(state).map((item) => item.id));
  requireSaved(Array.isArray(round.wordOptions) && round.wordOptions.length > 0 && round.wordOptions.every((id) => bankIds.has(id)), "word options are invalid");
  requireSaved(round.wordId === null || round.wordOptions.includes(round.wordId), "word is not one of the options");
  requireSaved((round.wordId === null) === (state.phase === "choosing") || state.phase === "round_over" || state.phase === "game_over", "word presence does not match phase");
  requireSaved(Array.isArray(round.guesses) && round.guesses.every((guess) => isSeat(guess?.seat) && guess.seat !== round.drawerSeat && typeof guess.text === "string"), "guesses are invalid");
  requireSaved(Array.isArray(round.solvedOrder) && round.solvedOrder.every((seat) => isSeat(seat) && seat !== round.drawerSeat)
    && new Set(round.solvedOrder).size === round.solvedOrder.length, "solved order is invalid");
  requireSaved(Array.isArray(round.passedSeats) && round.passedSeats.every(isSeat), "passed seats are invalid");
  requireSaved(Array.isArray(round.promptAttempts) && round.promptAttempts.length <= state.config.maxPromptAttempts, "prompt attempts are invalid");
  requireSaved(Array.isArray(round.talk), "talk is invalid");
  requireSaved(round.points && state.seats.every((seat) => Number.isInteger(round.points[seat.seat])), "round points are invalid");
  if (["choosing", "prompting", "guessing"].includes(state.phase)) requireSaved(Number.isFinite(round.deadlineAt), "deadline is missing");
  if (state.phase === "guessing") requireSaved(typeof round.imageRef === "string" && Number.isFinite(round.guessingStartedAt), "guessing image is missing");
  if (state.phase === "game_over") requireSaved(state.result && Array.isArray(state.result.winners), "result is missing");
  return state;
}
