// Model-facing layer for Draw & Guess: what one seat may know, the numbered
// legal actions it may take, the JSON schema for its answer, and a parser that
// maps the answer to an engine action or a precise, retryable error.
//
// The room engineer sends `buildAiView()` (plus the blurred image from
// `visionInputFor()` when guessing) to the model with `decisionSchema()`, then
// feeds the output to `parseDecision()`. On { ok: false } it re-asks with the
// error in the retry context; on { ok: true } it calls engine.applyAction().

import { AIDecisionError } from "../../platform/ai-decision-error.js";
import {
  MAX_TABLE_TALK,
  findPromptLeak,
  guessesUsed,
  guesserPointsFor,
  legalActions,
  revealAt,
  seatKnowsWord,
  validateAction,
  wordById,
} from "./engine.js";

export const DRAW_GUESS_DECISION_MAX_ATTEMPTS = 3;

function describeAction(state, action) {
  switch (action.type) {
    case "choose_word": {
      const word = wordById(state, action.wordId);
      const bonus = state.config.scoring.tierBonus[word.difficulty];
      return {
        label: `Draw “${word.word}” (${word.zh}), ${word.difficulty}: guessers get +${bonus} bonus points`,
        textField: null,
      };
    }
    case "submit_prompt":
      return { label: "Submit an image prompt that depicts the secret word without naming it (put the prompt in text)", textField: "prompt" };
    case "submit_sketch":
      return { label: "Submit a hand sketch", textField: "imageRef" };
    case "guess":
      return { label: "Guess the word (put your guess in text)", textField: "text" };
    case "pass":
      return { label: "Stop guessing for the rest of this round", textField: null };
    default:
      return { label: action.type, textField: null };
  }
}

/** Numbered legal actions for a model seat. Hand sketches are human-only and never offered. */
export function numberedActions(state, seat, options = {}) {
  return legalActions(state, seat, options)
    .filter((action) => action.type !== "submit_sketch")
    .map((action, index) => {
      const { label, textField } = describeAction(state, action);
      return { number: index + 1, type: action.type, label, needsText: Boolean(textField), action };
    });
}

function seatSummary(state, seat) {
  return state.seats.map((entry) => ({
    seat: entry.seat,
    name: entry.name,
    score: entry.score,
    isYou: entry.seat === seat,
    isDrawer: entry.seat === state.round?.drawerSeat,
    solved: state.round?.solvedOrder.includes(entry.seat) ?? false,
  }));
}

function forbiddenTerms(word) {
  return [word.word, ...word.synonyms, word.zh, ...word.zhSynonyms];
}

/**
 * Snapshot for one model seat with only what that seat may know. Throws when the
 * seat has nothing to decide (callers should check numberedActions first).
 */
export function buildAiView(state, seat, options = {}) {
  const now = options.now ?? Date.now();
  const actions = numberedActions(state, seat, { now });
  if (!actions.length) throw new Error(`Seat ${seat} has no Draw & Guess decision to make now`);
  const round = state.round;
  const me = state.seats[seat];
  const isDrawer = seat === round.drawerSeat;
  const word = round.wordId ? wordById(state, round.wordId) : null;
  const view = {
    game: "Draw & Guess",
    phase: state.phase,
    you: { seat, name: me.name, role: isDrawer ? "drawer" : "guesser", score: me.score, character: options.character ?? null },
    round: {
      number: round.number,
      of: state.totalTurns,
      drawer: state.seats[round.drawerSeat].name,
      secondsLeft: round.deadlineAt === null ? null : Math.max(0, Math.ceil((round.deadlineAt - now) / 1000)),
    },
    seats: seatSummary(state, seat),
    tableTalk: round.talk.slice(-12).map((item) => ({ name: state.seats[item.seat].name, text: item.text })),
    legalActions: actions.map(({ number, type, label, needsText }) => ({ number, type, label, needsText })),
  };

  if (isDrawer && state.phase === "choosing") {
    view.choosing = {
      options: round.wordOptions.map((id) => {
        const option = wordById(state, id);
        return { word: option.word, zh: option.zh, difficulty: option.difficulty };
      }),
      note: "Harder words earn guessers a bonus; you earn points for every seat that guesses correctly, so pick something you can depict clearly.",
    };
  }
  if (isDrawer && state.phase === "prompting") {
    view.drawing = {
      secretWord: word.word,
      chinese: word.zh,
      difficulty: word.difficulty,
      forbidden: forbiddenTerms(word),
      maxPromptLength: state.config.maxPromptLength,
      attemptsLeft: state.config.maxPromptAttempts - round.promptAttempts.length,
      rejectedAttempts: round.promptAttempts
        .filter((attempt) => !attempt.accepted)
        .map((attempt) => ({ prompt: attempt.prompt, reason: attempt.leak.reason, match: attempt.leak.match })),
    };
  }
  if (!isDrawer && state.phase === "guessing") {
    const reveal = revealAt(state, now);
    view.guessing = {
      wordShape: word.word.replace(/[a-z]/gi, "_"),
      letterCount: word.word.replace(/[^a-z]/gi, "").length,
      difficulty: round.difficulty,
      pointsIfCorrectNow: guesserPointsFor(state, round.solvedOrder.length, round.difficulty),
      imageBlur: { stage: reveal.stage + 1, of: reveal.stages, blurPx: reveal.blurPx },
      guessesLeft: state.config.maxGuessesPerRound - guessesUsed(state, seat),
      yourGuesses: round.guesses.filter((guess) => guess.seat === seat).map((guess) => ({ text: guess.text, close: guess.close })),
      othersWrongGuesses: round.guesses
        .filter((guess) => guess.seat !== seat && !guess.correct)
        .map((guess) => ({ name: state.seats[guess.seat].name, text: guess.text })),
      solvedBy: round.solvedOrder.map((solvedSeat) => state.seats[solvedSeat].name),
    };
  }
  return view;
}

/** Structured-output schema for the decision. All keys are required (strict mode); unused ones are null. */
export function decisionSchema(state, seat, options = {}) {
  const count = numberedActions(state, seat, options).length;
  return {
    type: "object",
    properties: {
      choice: { type: "integer", enum: Array.from({ length: Math.max(count, 1) }, (_, index) => index + 1) },
      text: { anyOf: [{ type: "string", maxLength: Math.max(state.config.maxPromptLength, state.config.maxGuessLength) }, { type: "null" }] },
      tableTalk: { anyOf: [{ type: "string", maxLength: MAX_TABLE_TALK }, { type: "null" }] },
    },
    required: ["choice", "text", "tableTalk"],
    additionalProperties: false,
  };
}

/** Plain-language instructions to send with the view. */
export function decisionInstructions(view) {
  const lines = [
    `You are ${view.you.name}, playing Draw & Guess (你画我猜) as the ${view.you.role}. Round ${view.round.number} of ${view.round.of}.`,
  ];
  if (view.you.character?.personality) lines.push(`Character: ${view.you.character.personality}`);
  if (view.choosing) {
    lines.push("Choose the secret word you will depict. The other seats will see only an AI-generated image of your prompt.");
  }
  if (view.drawing) {
    lines.push(
      `Secret word: “${view.drawing.secretWord}” (${view.drawing.chinese}). Write an English image prompt (at most ${view.drawing.maxPromptLength} characters) that makes the guessers say it.`,
      `The prompt must NOT contain any of: ${view.drawing.forbidden.map((term) => `“${term}”`).join(", ")}, nor their plurals or -ed/-ing forms, nor the word spelled out letter by letter. Describe shape, color, setting and use instead. Never ask for text or letters in the image.`,
      `A leaking prompt is rejected and costs one of your ${view.drawing.attemptsLeft} remaining attempts; with none left the round is void and you score nothing.`,
    );
  }
  if (view.guessing) {
    lines.push(
      `Look at the image (blur stage ${view.guessing.imageBlur.stage} of ${view.guessing.imageBlur.of}; it sharpens over time). The answer has the shape “${view.guessing.wordShape}”.`,
      `A correct guess now earns ${view.guessing.pointsIfCorrectNow} points; earlier is better. You have ${view.guessing.guessesLeft} guesses left. Do not repeat a guess you already made.`,
    );
  }
  lines.push(
    "Pick exactly one action by its number in legalActions. Put the prompt or guess in text when the action needs it, otherwise text is null.",
    `tableTalk is an optional in-character line (at most ${MAX_TABLE_TALK} characters, or null) shown to the table. It must never contain the secret word or a guess.`,
  );
  return lines.join("\n");
}

function failure(code, message) {
  return { ok: false, code, message, retryable: true };
}

/**
 * Maps a model answer to a legal engine action. Returns { ok: true, action } or
 * { ok: false, code, message, retryable }. A prompt that leaks the word is still
 * returned as ok: the engine records it as a rejected attempt (that is how the
 * two-retry limit is enforced). A leaking tableTalk, by contrast, is an error
 * here because the engine would refuse the whole action.
 */
export function parseDecision(state, seat, output, options = {}) {
  const now = options.now ?? Date.now();
  if (!output || typeof output !== "object" || Array.isArray(output)) return failure("bad_shape", "The answer must be a JSON object with choice, text and tableTalk");
  const actions = numberedActions(state, seat, { now });
  if (!actions.length) return { ok: false, code: "no_decision", message: "This seat has no decision to make now", retryable: false };
  const { choice, text, tableTalk } = output;
  if (!Number.isInteger(choice) || choice < 1 || choice > actions.length) {
    return failure("bad_choice", `choice must be an integer from 1 to ${actions.length}`);
  }
  const picked = actions[choice - 1];
  if (text !== null && text !== undefined && typeof text !== "string") return failure("bad_text", "text must be a string or null");
  if (tableTalk !== null && tableTalk !== undefined && typeof tableTalk !== "string") return failure("bad_table_talk", "tableTalk must be a string or null");
  const trimmedText = typeof text === "string" ? text.trim() : "";
  const trimmedTalk = typeof tableTalk === "string" ? tableTalk.trim() : "";
  if (trimmedTalk.length > MAX_TABLE_TALK) return failure("bad_table_talk", `tableTalk is ${trimmedTalk.length} characters; the limit is ${MAX_TABLE_TALK}`);
  if (picked.needsText && !trimmedText) {
    return failure("missing_text", `Action ${choice} (${picked.type}) needs ${picked.type === "submit_prompt" ? "the image prompt" : "your guess"} in text`);
  }
  if (!picked.needsText && trimmedText) return failure("unexpected_text", `Action ${choice} (${picked.type}) takes no text; set text to null`);

  const round = state.round;
  if (trimmedTalk && round.wordId) {
    const leak = findPromptLeak(trimmedTalk, wordById(state, round.wordId));
    if (leak) {
      return failure("talk_leak", seat === round.drawerSeat || seatKnowsWord(state, seat)
        ? `tableTalk reveals the secret word (${leak.reason}: “${leak.match}”); remove it`
        : "tableTalk must not contain guesses; put a guess in text with the guess action");
    }
  }

  const action = { ...picked.action };
  if (picked.type === "submit_prompt") action.prompt = trimmedText;
  if (picked.type === "guess") action.text = trimmedText;
  if (trimmedTalk) action.tableTalk = trimmedTalk;
  const check = validateAction(state, action, { now });
  if (!check.ok) return { ok: false, code: check.code, message: check.message, retryable: !["time_up", "wrong_phase", "game_over"].includes(check.code) };
  return { ok: true, action };
}

/** Converts a failed parse into the AIDecisionError shape the platform retry loops use. */
export function toAIDecisionError(result, output) {
  const error = new AIDecisionError(result.message, result.retryable ? "invalid_draw_guess_decision" : `draw_guess_${result.code}`);
  error.rejectedDecision = output ?? null;
  error.parseCode = result.code;
  return error;
}
