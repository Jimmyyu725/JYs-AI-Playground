import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express from "express";

import { applyAction, fromSave, createDrawGuessGame, guesserIsActive, guesserSeats, imageRequestFor, revealAt, seatKnowsWord, systemActions, toSave, validateAction, viewFor, visionInputFor } from "../games/draw-guess/engine.js";
import { blurredPngDataUrl } from "../games/draw-guess/png-blur.js";
import { generateRoundImage, requestDrawGuessDecision, requestGameReview } from "../games/draw-guess/room-ai.js";
import { normalizeModelConfig } from "../platform/model-registry.js";
import { createMatchRecorder, createSSEChannel, httpError, participantFrom, publicError } from "../platform/room-kit.js";
import { seatCharacters } from "../platform/seating.js";
import { pushTableTalk } from "../platform/table-talk.js";

export const id = "draw-guess";
export const defaults = { model: "gpt-6-luna", reasoningEffort: "low" };

const TICK_MS = 400;
const ROUND_BREAK_MS = 9000;
const MAX_SKETCH_BYTES = 3_000_000;
const IMAGE_NAME = /^[a-z0-9-]{8,80}\.png$/;
const ROUND_SECONDS = [45, 60, 90, 120, 180];

const channel = createSSEChannel();
let recordOnce = () => null;
let imageDir = null;
let saveFile = null;
let table = null;
let tableVersion = 0;
const blurCache = new Map();

// ---------------------------------------------------------------------------
// Table construction

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function buildTable(body = {}) {
  const mode = body.mode === "arena" ? "arena" : "human-vs-ai";
  const aiRequests = Array.isArray(body.aiPlayers) ? body.aiPlayers.slice(0, 7) : [];
  const minAi = mode === "arena" ? 2 : 1;
  const aiCount = clampInt(body.aiCount ?? aiRequests.length, mode === "arena" ? 3 : 2, minAi, mode === "arena" ? 6 : 5);
  const cast = seatCharacters(aiCount, aiRequests.map((entry) => entry?.characterId));
  const players = [];
  if (mode === "human-vs-ai") {
    const name = String(body.humanName ?? "You").trim().slice(0, 24) || "You";
    players.push({ isHuman: true, name, character: null, aiConfig: null });
  }
  cast.forEach((character, index) => {
    const aiConfig = normalizeModelConfig(id, aiRequests[index] ?? body.model ?? {});
    players.push({ isHuman: false, name: character.shortName ?? character.name, character, aiConfig });
  });
  const roundSeconds = ROUND_SECONDS.includes(Number(body.roundSeconds)) ? Number(body.roundSeconds) : 90;
  const state = createDrawGuessGame({
    seats: players.map((player, index) => ({ id: player.isHuman ? "human" : `ai-${player.character.id}`, name: player.name, kind: player.isHuman ? "human" : "ai", characterId: player.character?.id ?? null, seat: index })),
    rotations: clampInt(body.rotations, 1, 1, 3),
    difficulty: ["easy", "medium", "hard", "mixed"].includes(body.difficulty) ? body.difficulty : "mixed",
    roundDurationMs: roundSeconds * 1000,
    promptTimeoutMs: 120000,
    chooseTimeoutMs: 25000,
    ...(Number.isInteger(body.firstDrawerSeat) && body.firstDrawerSeat >= 0 && body.firstDrawerSeat < players.length ? { firstDrawerSeat: body.firstDrawerSeat } : {}),
  }, { now: Date.now() });
  return freshTable({ mode, players, state, imageQuality: body.imageQuality === "medium" ? "medium" : "low" });
}

function freshTable({ mode, players, state, imageQuality, log = [], tableTalk = [], heldTalk = [] }) {
  return {
    tableId: randomUUID(),
    mode,
    players,
    humanSeat: players.findIndex((player) => player.isHuman),
    state,
    imageQuality,
    tableTalk,
    heldTalk,
    log,
    aiError: null,
    paused: false,
    thinking: {},
    inFlight: new Set(),
    imageJob: false,
    nextGuessAt: {},
    lastFrozenAt: null,
    revealStage: null,
    breakTimer: null,
    insights: {},
  };
}

// ---------------------------------------------------------------------------
// Public state

function publicPlayer(player, index) {
  const character = player.character
    ? { id: player.character.id, name: player.character.name, shortName: player.character.shortName, title: player.character.title, color: player.character.color, initials: player.character.initials }
    : null;
  return { seat: index, isHuman: player.isHuman, name: player.name, character, aiConfig: player.aiConfig };
}

function canSeeLogEntry(entry, viewerSeat, omniscient) {
  if (entry.audience !== "knowers" || omniscient) return true;
  const state = table.state;
  if (entry.round < state.round.number) return true;
  return viewerSeat >= 0 && seatKnowsWord(state, viewerSeat);
}

function publicState() {
  if (!table) return null;
  const now = Date.now();
  const omniscient = table.mode === "arena";
  const viewerSeat = omniscient ? null : table.humanSeat;
  const view = viewFor(table.state, viewerSeat, { now, revealSecret: omniscient });
  return {
    tableId: table.tableId,
    mode: table.mode,
    serverNow: now,
    humanSeat: omniscient ? null : table.humanSeat,
    players: table.players.map(publicPlayer),
    view,
    thinking: table.thinking,
    aiError: table.aiError,
    paused: table.paused,
    imagePending: table.imageJob,
    roundBreakEndsAt: table.breakEndsAt ?? null,
    tableTalk: table.tableTalk,
    insights: Object.fromEntries(Object.entries(table.insights).filter(([, value]) => canSeeLogEntry(value, viewerSeat ?? -1, omniscient))),
    log: table.log.filter((entry) => canSeeLogEntry(entry, viewerSeat ?? -1, omniscient)).slice(-60),
  };
}

function broadcastState() {
  recordResult();
  persist();
  if (table) channel.broadcast("state", publicState());
}

// ---------------------------------------------------------------------------
// Log lines from engine events (some reveal the word and are only for those who know it)

function nameOf(seat) {
  return table.players[seat]?.name ?? `Seat ${seat + 1}`;
}

/** Third-person verb, except for a human who kept the default name "You". */
function verb(seat, base) {
  return nameOf(seat) === "You" ? base : `${base}s`;
}

function addLog(text, { kind = "move", who = "", audience = "all" } = {}) {
  table.log.push({ id: randomUUID().slice(0, 8), round: table.state.round?.number ?? 0, kind, who, text, audience, at: Date.now() });
  if (table.log.length > 200) table.log.splice(0, table.log.length - 200);
}

function logEvents(events) {
  for (const event of events) {
    switch (event.type) {
      case "word_chosen":
        addLog(`${nameOf(event.seat)} picked a${event.difficulty === "easy" ? "n" : ""} ${event.difficulty} word${event.auto ? " (time ran out, so the house picked)" : ""}.`, { kind: "system" });
        break;
      case "prompt_rejected":
        addLog(`Prompt rejected (${event.leak?.reason}: “${event.leak?.match}”). ${event.attemptsLeft} attempt${event.attemptsLeft === 1 ? "" : "s"} left.`, { kind: "system", who: nameOf(event.seat), audience: "knowers" });
        if (event.attemptsLeft > 0) addLog(`${nameOf(event.seat)}'s description gave the word away. They try again.`, { kind: "system" });
        break;
      case "prompt_accepted":
        addLog(`${nameOf(event.seat)} described the picture. The easel is painting it…`, { kind: "system" });
        break;
      case "guessing_started":
        addLog(event.source === "sketch" ? "The sketch is up. Guess!" : "The painting is up. Guess!", { kind: "system" });
        break;
      case "guess_wrong":
        addLog(event.text, { kind: "move", who: nameOf(event.seat) });
        break;
      case "guess_correct":
        addLog(`got it! (#${event.order})`, { kind: "move", who: nameOf(event.seat) });
        break;
      case "guesser_passed":
        addLog("passes for this round.", { kind: "move", who: nameOf(event.seat) });
        break;
      case "image_failed":
        addLog(`The picture could not be painted: ${event.reason || "unknown error"}.`, { kind: "system" });
        break;
      case "round_over":
        addLog(event.word ? `The word was “${event.word}” (${event.zh}).` : "The round ended before a word was chosen.", { kind: "system" });
        break;
      case "round_started":
        addLog(`Round ${event.number}: ${nameOf(event.drawerSeat)} ${verb(event.drawerSeat, "draw")}.`, { kind: "system" });
        break;
      case "game_over":
        addLog(`Game over. ${event.result.winners.map(nameOf).join(" & ")} ${event.result.winners.length === 1 ? verb(event.result.winners[0], "win") : "win"}.`, { kind: "system" });
        break;
      default:
        break;
    }
  }
}

function publishTalk(event) {
  // A drawer often says the same line when choosing and again when describing; show it once.
  const last = table.tableTalk.at(-1);
  if (last && last.speaker === event.seat && last.text === event.text) return;
  const player = table.players[event.seat];
  const entry = pushTableTalk(table, { speaker: event.seat, playerName: player.name, characterId: player.character?.id ?? null, text: event.text });
  if (entry) channel.broadcast("table_talk", entry);
}

/** Whoever watches this table (arena spectators, or the human seat) may read held talk now. */
function viewerKnowsWord() {
  return table.mode === "arena" || (table.humanSeat >= 0 && seatKnowsWord(table.state, table.humanSeat));
}

/** Talk from seats that know the word waits until the viewer knows it too (solved, or round over). */
function talkFromEvents(events) {
  for (const event of events) {
    if (event.type !== "table_talk") continue;
    if (event.held && !viewerKnowsWord()) table.heldTalk.push({ seat: event.seat, text: event.text });
    else publishTalk(event);
  }
  if (table.heldTalk.length && viewerKnowsWord()) table.heldTalk.splice(0).forEach(publishTalk);
}

// ---------------------------------------------------------------------------
// Applying actions

function apply(action) {
  const { state, events } = applyAction(table.state, action, { now: Date.now() });
  table.state = state;
  logEvents(events);
  talkFromEvents(events);
  if (events.some((event) => event.type === "guessing_started")) table.revealStage = 0;
  if (events.some((event) => event.type === "round_started" || event.type === "game_over")) {
    table.nextGuessAt = {};
    table.insights = {};
  }
  for (const event of events) channel.broadcast("game_event", publicEvent(event));
  return events;
}

/** Event summaries safe for every viewer (the full detail lives in the per-viewer state). */
function publicEvent(event) {
  const safe = { type: event.type, seat: event.seat ?? null };
  if (event.type === "guess_wrong") Object.assign(safe, { text: event.text });
  if (event.type === "guess_correct") safe.order = event.order;
  if (event.type === "prompt_rejected") safe.attemptsLeft = event.attemptsLeft;
  return safe;
}

function recordResult() {
  const current = table;
  if (!current || current.state.phase !== "game_over" || !current.state.result) return;
  recordOnce(current, "game", () => ({
    mode: current.mode,
    participants: current.players.map((player, index) => participantFrom(player, { place: current.state.result.standings.find((entry) => entry.seat === index).rank })),
    details: { rounds: current.state.totalTurns, scores: current.state.seats.map((seat) => seat.score) },
  }));
}

function isFrozen() {
  const state = table.state;
  if (table.paused || table.aiError) return true;
  const drawer = table.players[state.round?.drawerSeat];
  return Boolean(drawer && !drawer.isHuman && (state.phase === "choosing" || state.phase === "prompting"));
}

function shiftClock(ms) {
  const round = table.state.round;
  if (!round || ms <= 0) return;
  if (Number.isFinite(round.deadlineAt)) round.deadlineAt += ms;
  if (Number.isFinite(round.phaseStartedAt)) round.phaseStartedAt += ms;
  if (Number.isFinite(round.guessingStartedAt)) round.guessingStartedAt += ms;
}

function tick() {
  if (!table) return;
  const state = table.state;
  const now = Date.now();
  if (["choosing", "prompting", "guessing"].includes(state.phase) && isFrozen()) {
    if (table.lastFrozenAt !== null) shiftClock(now - table.lastFrozenAt);
    table.lastFrozenAt = now;
    return;
  }
  table.lastFrozenAt = null;
  if (systemActions(state, { now }).some((action) => action.type === "tick")) {
    apply({ type: "tick" });
    broadcastState();
    pump();
    return;
  }
  if (state.phase === "guessing") {
    const stage = revealAt(state, now).stage;
    if (stage !== table.revealStage) {
      table.revealStage = stage;
      broadcastState();
    }
  }
}

// ---------------------------------------------------------------------------
// Images

function imagePath(imageRef) {
  const name = String(imageRef ?? "").split("/").pop();
  if (!IMAGE_NAME.test(name)) throw new Error("Unknown image");
  return path.join(imageDir, name);
}

/** Drops pictures from tables older than a few days so the data folder does not grow forever. */
function pruneImages(maxAgeMs = 3 * 24 * 3600 * 1000) {
  try {
    if (!fs.existsSync(imageDir)) return;
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(imageDir)) {
      const file = path.join(imageDir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch (error) {
    console.error(`Draw & Guess image cleanup failed: ${String(error?.message || error)}`);
  }
}

function storeImage(buffer) {
  fs.mkdirSync(imageDir, { recursive: true });
  const name = `${table.tableId.slice(0, 8)}-r${table.state.round.number}-${randomUUID().slice(0, 8)}.png`;
  const target = path.join(imageDir, name);
  fs.writeFileSync(`${target}.tmp`, buffer);
  fs.renameSync(`${target}.tmp`, target);
  return `/api/draw-guess/image/${name}`;
}

function blurredImageFor(state, seat, now) {
  const input = visionInputFor(state, seat, now);
  if (!input) return null;
  const key = `${input.imageRef}@${input.blurPx}`;
  if (!blurCache.has(key)) {
    blurCache.set(key, blurredPngDataUrl(fs.readFileSync(imagePath(input.imageRef)), input.blurPx));
    if (blurCache.size > 24) blurCache.delete(blurCache.keys().next().value);
  }
  return blurCache.get(key);
}

async function runImageJob() {
  const current = table;
  const version = tableVersion;
  const request = imageRequestFor(current.state);
  if (!request || current.imageJob) return;
  current.imageJob = true;
  current.thinking = { ...current.thinking, [request.drawerSeat]: { status: "The easel is painting the picture…", startedAt: Date.now() } };
  broadcastState();
  try {
    const buffer = await generateRoundImage(request.prompt, { quality: current.imageQuality });
    if (table !== current || version !== tableVersion || current.state.round.number !== request.roundNumber || current.state.phase !== "rendering") return;
    apply({ type: "image_ready", imageRef: storeImage(buffer) });
  } catch (error) {
    if (table !== current || version !== tableVersion) return;
    current.aiError = { seat: request.drawerSeat, kind: "image", message: publicError(error) };
    addLog(`The picture failed: ${publicError(error)}`, { kind: "system" });
  } finally {
    if (table === current) {
      current.imageJob = false;
      const { [request.drawerSeat]: _done, ...rest } = current.thinking;
      current.thinking = rest;
      broadcastState();
      pump();
    }
  }
}

// ---------------------------------------------------------------------------
// AI seats

function insightFrom(seat, response) {
  const summary = String(response?.reasoningSummary ?? "").trim().slice(0, 600);
  if (!summary) return;
  // A drawer's notes name the word and a guesser's notes list candidate answers, so a human
  // guesser sees them only once they know the word (solved, or the round is over).
  table.insights[seat] = { seat, text: summary, round: table.state.round?.number ?? 0, audience: "knowers" };
}

async function runAiSeat(seat) {
  const current = table;
  const version = tableVersion;
  const player = current.players[seat];
  current.inFlight.add(seat);
  current.thinking = { ...current.thinking, [seat]: { status: `Asking ${player.aiConfig.model}…`, startedAt: Date.now() } };
  broadcastState();
  const isCurrent = () => table === current && version === tableVersion;
  try {
    const decision = await requestDrawGuessDecision({
      getState: () => (isCurrent() ? current.state : null),
      seat,
      modelConfig: player.aiConfig,
      character: player.character,
      getImage: blurredImageFor,
      isCurrent,
    }, {
      onStatus(status) {
        if (!isCurrent()) return;
        current.thinking = { ...current.thinking, [seat]: { ...(current.thinking[seat] ?? {}), status } };
        channel.broadcast("thinking", { seat, status });
      },
    });
    if (!isCurrent() || !decision) return;
    const check = applyActionSafely(decision.action);
    if (check) insightFrom(seat, decision.response);
    const reveal = revealAt(current.state, Date.now());
    const wait = reveal.nextChangeAt ? Math.min(10000, Math.max(1500, reveal.nextChangeAt - Date.now() + 200)) : 1500;
    current.nextGuessAt[seat] = Date.now() + wait;
    if (current.state.phase === "guessing") setTimeout(() => { if (isCurrent()) pump(); }, wait + 20);
  } catch (error) {
    if (!isCurrent()) return;
    current.aiError = { seat, kind: "decision", message: publicError(error) };
    addLog(`${player.name}'s model failed: ${publicError(error)}`, { kind: "system" });
  } finally {
    if (table === current) {
      current.inFlight.delete(seat);
      const { [seat]: _done, ...rest } = current.thinking;
      current.thinking = rest;
      broadcastState();
      pump();
    }
  }
}

/** Applies an AI action that was legal a moment ago; returns false if the table moved on meanwhile. */
function applyActionSafely(action) {
  try {
    apply(action);
    return true;
  } catch (error) {
    if (error?.name === "DrawGuessRuleError") return false;
    throw error;
  }
}

function scheduleRoundBreak() {
  if (table.breakTimer) return;
  const current = table;
  const roundNumber = current.state.round.number;
  current.breakEndsAt = Date.now() + ROUND_BREAK_MS;
  current.breakTimer = setTimeout(() => {
    current.breakTimer = null;
    current.breakEndsAt = null;
    if (table !== current || current.state.phase !== "round_over" || current.state.round.number !== roundNumber) return;
    if (current.paused || current.aiError) return;
    apply({ type: "next_round" });
    broadcastState();
    pump();
  }, ROUND_BREAK_MS);
}

/** Starts whatever the table is waiting for: AI decisions, the round image, or the next round. */
function pump() {
  if (!table) return;
  const state = table.state;
  if (state.phase === "game_over" || table.paused || table.aiError) return;
  const round = state.round;
  const drawer = table.players[round.drawerSeat];
  if ((state.phase === "choosing" || state.phase === "prompting") && !drawer.isHuman && !table.inFlight.has(round.drawerSeat)) {
    runAiSeat(round.drawerSeat);
  } else if (state.phase === "rendering") {
    runImageJob();
  } else if (state.phase === "guessing") {
    const now = Date.now();
    for (const seat of guesserSeats(state)) {
      const player = table.players[seat];
      if (player.isHuman || table.inFlight.has(seat) || !guesserIsActive(state, seat)) continue;
      if ((table.nextGuessAt[seat] ?? 0) > now) continue;
      runAiSeat(seat);
    }
  } else if (state.phase === "round_over") {
    scheduleRoundBreak();
  }
}

// ---------------------------------------------------------------------------
// Save and resume (one table, survives a server restart)

function persist() {
  if (!saveFile || !table) return;
  try {
    const payload = {
      save: toSave(table.state),
      mode: table.mode,
      imageQuality: table.imageQuality,
      players: table.players.map((player) => ({ isHuman: player.isHuman, name: player.name, characterId: player.character?.id ?? null, aiConfig: player.aiConfig })),
      log: table.log.slice(-80),
      tableTalk: table.tableTalk,
      heldTalk: table.heldTalk,
    };
    fs.mkdirSync(path.dirname(saveFile), { recursive: true });
    fs.writeFileSync(`${saveFile}.tmp`, JSON.stringify(payload));
    fs.renameSync(`${saveFile}.tmp`, saveFile);
  } catch (error) {
    console.error(`Draw & Guess save failed: ${String(error?.message || error)}`);
  }
}

function restore() {
  try {
    if (!saveFile || !fs.existsSync(saveFile)) return null;
    const payload = JSON.parse(fs.readFileSync(saveFile, "utf8"));
    const state = fromSave(payload.save);
    const ids = payload.players.map((player) => player.characterId);
    const aiIds = ids.filter(Boolean);
    const cast = seatCharacters(aiIds.length, aiIds);
    let next = 0;
    const players = payload.players.map((player) => (player.isHuman
      ? { isHuman: true, name: player.name, character: null, aiConfig: null }
      : { isHuman: false, name: player.name, character: cast[next++], aiConfig: normalizeModelConfig(id, player.aiConfig) }));
    const restored = freshTable({ mode: payload.mode === "arena" ? "arena" : "human-vs-ai", players, state, imageQuality: payload.imageQuality, log: payload.log ?? [], tableTalk: payload.tableTalk ?? [], heldTalk: Array.isArray(payload.heldTalk) ? payload.heldTalk : [] });
    // Time stood still while the server was down: give the current phase its remaining time back.
    const round = restored.state.round;
    if (round && Number.isFinite(round.deadlineAt) && round.deadlineAt < Date.now() + 5000) {
      const shift = Date.now() + 15000 - round.deadlineAt;
      round.deadlineAt += shift;
      if (Number.isFinite(round.guessingStartedAt)) round.guessingStartedAt += shift;
    }
    restored.paused = restored.mode === "arena" && restored.state.phase !== "game_over";
    return restored;
  } catch (error) {
    console.error(`Draw & Guess restore skipped: ${String(error?.message || error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routes

function requireTable() {
  if (!table) throw httpError(409, "Start a Draw & Guess game first");
  return table;
}

function humanAction(body) {
  const current = requireTable();
  if (current.humanSeat < 0) throw httpError(409, "This is an AI arena; there is no human seat");
  const seat = current.humanSeat;
  const tableTalk = typeof body?.tableTalk === "string" && body.tableTalk.trim() ? body.tableTalk.trim() : undefined;
  switch (body?.type) {
    case "choose_word":
      return { type: "choose_word", seat, optionIndex: Number(body.optionIndex), tableTalk };
    case "submit_prompt":
      return { type: "submit_prompt", seat, prompt: String(body.prompt ?? ""), tableTalk };
    case "guess":
      return { type: "guess", seat, text: String(body.text ?? ""), tableTalk };
    case "pass":
      return { type: "pass", seat, tableTalk };
    default:
      throw httpError(400, "Unknown action");
  }
}

export function register(app, ctx) {
  recordOnce = createMatchRecorder(ctx.results, id);
  imageDir = path.join(ctx.dataDir, "draw-guess", "images");
  saveFile = path.join(ctx.dataDir, "draw-guess", "table.json");

  app.get("/api/draw-guess/state", (_request, response) => response.json(publicState()));
  app.get("/api/draw-guess/events", channel.handler(publicState));

  app.get("/api/draw-guess/image/:name", (request, response, next) => {
    try {
      const file = imagePath(request.params.name);
      if (!fs.existsSync(file)) throw httpError(404, "No such image");
      // The human guesser gets the same server-blurred picture the AI guessers get, never the sharp
      // original, until they solve it or the round ends. Arena spectators see everything anyway.
      const current = table;
      const now = Date.now();
      if (current && current.humanSeat >= 0 && current.state.phase === "guessing" && current.state.round.imageRef?.endsWith(`/${request.params.name}`)) {
        const input = visionInputFor(current.state, current.humanSeat, now);
        if (input?.blurPx > 0) {
          const dataUrl = blurredImageFor(current.state, current.humanSeat, now);
          response.set({ "Cache-Control": "no-store", "Content-Type": "image/png" });
          return response.send(Buffer.from(dataUrl.split(",")[1], "base64"));
        }
        response.set("Cache-Control", "no-store");
      } else {
        response.set("Cache-Control", "private, max-age=3600");
      }
      if (request.query.thumb !== undefined) {
        // Salon thumbnails: a 512 px copy instead of the full-size original.
        const key = `${request.params.name}@thumb`;
        if (!blurCache.has(key)) blurCache.set(key, blurredPngDataUrl(fs.readFileSync(file), 0));
        response.set("Content-Type", "image/png");
        return response.send(Buffer.from(blurCache.get(key).split(",")[1], "base64"));
      }
      response.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error.status ? error : httpError(404, "No such image"));
    }
  });

  app.post("/api/draw-guess/game", (request, response, next) => {
    try {
      const next = buildTable(request.body ?? {});
      pruneImages();
      if (table?.breakTimer) clearTimeout(table.breakTimer);
      tableVersion += 1;
      table = next;
      const round = table.state.round;
      addLog(`New ${table.mode === "arena" ? "arena" : "game"}: ${table.players.length} seats, ${table.state.totalTurns} rounds. ${nameOf(round.drawerSeat)} ${verb(round.drawerSeat, "draw")} first.`, { kind: "system" });
      response.status(201).json(publicState());
      broadcastState();
      pump();
    } catch (error) {
      next(error.status ? error : httpError(400, publicError(error)));
    }
  });

  app.post("/api/draw-guess/action", (request, response, next) => {
    try {
      const action = humanAction(request.body);
      apply(action);
      response.json(publicState());
      broadcastState();
      pump();
    } catch (error) {
      if (error?.name === "DrawGuessRuleError") return next(httpError(409, error.message));
      next(error);
    }
  });

  // The sketch arrives as a raw PNG body (the shared JSON parser caps bodies at 32 KB).
  app.post("/api/draw-guess/sketch", express.raw({ type: "image/png", limit: MAX_SKETCH_BYTES }), (request, response, next) => {
    try {
      const current = requireTable();
      if (current.humanSeat < 0) throw httpError(409, "This is an AI arena; there is no human seat");
      const buffer = request.body;
      if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(1, 4).equals(Buffer.from("PNG"))) throw httpError(400, "The sketch must be a PNG image");
      const action = { type: "submit_sketch", seat: current.humanSeat, imageRef: "pending" };
      const check = validateAction(current.state, action, { now: Date.now() });
      if (!check.ok) throw httpError(409, check.message);
      action.imageRef = storeImage(buffer);
      apply(action);
      response.json(publicState());
      broadcastState();
      pump();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/draw-guess/next-round", (_request, response, next) => {
    try {
      const current = requireTable();
      if (current.state.phase !== "round_over") throw httpError(409, "The round is not over");
      if (current.breakTimer) clearTimeout(current.breakTimer);
      current.breakTimer = null;
      current.breakEndsAt = null;
      apply({ type: "next_round" });
      response.json(publicState());
      broadcastState();
      pump();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/draw-guess/retry-ai", (_request, response, next) => {
    try {
      const current = requireTable();
      if (!current.aiError) throw httpError(409, "There is no paused AI request to retry");
      current.aiError = null;
      response.json(publicState());
      broadcastState();
      pump();
    } catch (error) {
      next(error);
    }
  });

  // After a failed picture the table may skip the round instead of retrying (the round is void).
  app.post("/api/draw-guess/skip-image", (_request, response, next) => {
    try {
      const current = requireTable();
      if (current.aiError?.kind !== "image" || current.state.phase !== "rendering") throw httpError(409, "No failed picture to skip");
      current.aiError = null;
      apply({ type: "image_failed", reason: "skipped after a failed picture" });
      response.json(publicState());
      broadcastState();
      pump();
    } catch (error) {
      next(error);
    }
  });

  // After the game: one AI sitter reviews the whole sitting in character.
  app.post("/api/draw-guess/review", async (request, response, next) => {
    try {
      const current = requireTable();
      if (current.state.phase !== "game_over") throw httpError(409, "Reviews open once the game is over");
      const seat = Number(request.body?.seat);
      const player = current.players[seat];
      if (!player || player.isHuman) throw httpError(400, "Pick an AI sitter to review the game");
      if (current.reviewing) throw httpError(409, "A review is already being written");
      current.reviewing = true;
      current.thinking = { ...current.thinking, [seat]: { status: "Writing a review…", startedAt: Date.now() } };
      broadcastState();
      const game = {
        players: current.players.map((entry, index) => ({ seat: index, name: entry.name, score: current.state.seats[index].score, isHuman: entry.isHuman })),
        rounds: current.state.history.map((round) => ({
          number: round.number,
          drawer: nameOf(round.drawerSeat),
          word: round.word,
          difficulty: round.difficulty,
          description: round.prompt ?? (round.imageRef ? "(hand sketch)" : null),
          solvedInOrder: round.solvedOrder.map(nameOf),
          points: Object.fromEntries(Object.entries(round.points).map(([key, value]) => [nameOf(Number(key)), value])),
          endReason: round.endReason,
        })),
        reviewer: player.name,
      };
      try {
        const text = await requestGameReview({ character: player.character, modelConfig: player.aiConfig, game });
        if (table === current) addLog(text, { kind: "review", who: `${player.name} reviews the sitting` });
        response.json({ review: text });
      } finally {
        current.reviewing = false;
        const { [seat]: _done, ...rest } = current.thinking;
        current.thinking = rest;
        if (table === current) broadcastState();
      }
    } catch (error) {
      next(error.status ? error : httpError(502, publicError(error)));
    }
  });

  app.post("/api/draw-guess/arena/pause", (_request, response, next) => {
    try {
      const current = requireTable();
      current.paused = true;
      response.json(publicState());
      broadcastState();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/draw-guess/arena/resume", (_request, response, next) => {
    try {
      const current = requireTable();
      current.paused = false;
      response.json(publicState());
      broadcastState();
      pump();
    } catch (error) {
      next(error);
    }
  });

  return {
    onListen() {
      table = restore();
      if (table) {
        tableVersion += 1;
        pump();
      }
      setInterval(tick, TICK_MS).unref();
    },
  };
}
