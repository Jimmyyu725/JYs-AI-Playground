import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { requestGoDecision } from "../src/games/go-ai.js";
import { GoGame } from "../src/games/go-game.js";
import { requestWuziqiDecision } from "../src/games/wuziqi-ai.js";
import { WuziqiGame } from "../src/games/wuziqi-game.js";
import { PokerGame } from "../src/poker-game.js";
import { requestHoldemDecision } from "../src/openai-player.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(rootDir, ".env.local") });

const modelConfig = { model: "deepseek-v4-pro", reasoningEffort: process.argv[3] || "medium" };
const requested = process.argv[2];
const gameIds = requested ? [requested] : ["holdem", "go", "wuziqi"];

async function checkHoldem() {
  const game = new PokerGame({ gameMode: "arena", opponentCount: 2, arenaPaused: true, aiPlayers: [modelConfig, modelConfig] });
  const snapshot = game.aiSnapshot();
  const decision = await requestHoldemDecision(snapshot, modelConfig);
  return { action: decision.action, targetTotal: decision.targetTotal, legal: snapshot.legal.actions.includes(decision.action) };
}

// A board decision only counts as legal if the server would actually accept it.
function boardMoveIsLegal(game, decision) {
  if (decision.action !== "place") return decision.row === null && decision.column === null;
  return game.legalPlacements().some(([row, column]) => row === decision.row && column === decision.column);
}

async function checkGo() {
  const game = new GoGame({ gameMode: "arena", arenaPaused: true, boardSize: 9, aiPlayers: [modelConfig, modelConfig] });
  const decision = await requestGoDecision(game.aiSnapshot(), modelConfig);
  return { action: decision.action, row: decision.row, column: decision.column, legal: boardMoveIsLegal(game, decision) };
}

async function checkWuziqi() {
  const game = new WuziqiGame({ gameMode: "arena", arenaPaused: true, boardSize: 15, aiPlayers: [modelConfig, modelConfig] });
  const decision = await requestWuziqiDecision(game.aiSnapshot(), modelConfig);
  return { action: decision.action, row: decision.row, column: decision.column, legal: boardMoveIsLegal(game, decision) };
}

const checks = { holdem: checkHoldem, go: checkGo, wuziqi: checkWuziqi };

for (const gameId of gameIds) {
  const check = checks[gameId];
  if (!check) throw new Error(`Choose holdem, go, or wuziqi (received “${gameId}”)`);
  const startedAt = performance.now();
  const result = await check();
  console.log(JSON.stringify({
    ok: true,
    gameId,
    ...modelConfig,
    ...result,
    latencyMs: Math.round(performance.now() - startedAt),
  }));
}
