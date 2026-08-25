import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { requestDoudizhuBid } from "../src/games/doudizhu-ai.js";
import { DouDizhuGame } from "../src/games/doudizhu-game.js";
import { requestGoDecision } from "../src/games/go-ai.js";
import { GoGame } from "../src/games/go-game.js";
import { requestWuziqiDecision } from "../src/games/wuziqi-ai.js";
import { WuziqiGame } from "../src/games/wuziqi-game.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(rootDir, ".env.local") });

const gameId = process.argv[2];
const modelConfig = { model: process.env.CHECK_MODEL || "gpt-5.6-luna", reasoningEffort: process.env.CHECK_EFFORT || "medium" };
let decision;
if (gameId === "go") {
  const game = new GoGame({ gameMode: "arena", arenaPaused: true, boardSize: 9, aiPlayers: [modelConfig, modelConfig] });
  decision = await requestGoDecision(game.aiSnapshot(), game.currentPlayer.aiConfig);
} else if (gameId === "wuziqi") {
  const game = new WuziqiGame({ gameMode: "arena", arenaPaused: true, boardSize: 15, aiPlayers: [modelConfig, modelConfig] });
  decision = await requestWuziqiDecision(game.aiSnapshot(), game.currentPlayer.aiConfig);
} else if (gameId === "doudizhu") {
  const game = new DouDizhuGame({ gameMode: "arena", arenaPaused: true, aiPlayers: [modelConfig, modelConfig, modelConfig] });
  decision = await requestDoudizhuBid(game.aiSnapshot(), game.currentActor.aiConfig);
} else {
  throw new Error("Choose either go, wuziqi, or doudizhu");
}

console.log(JSON.stringify({
  ok: true,
  gameId,
  model: modelConfig.model,
  reasoningEffort: modelConfig.reasoningEffort,
  action: decision.action,
  score: decision.score ?? null,
  row: decision.row ?? null,
  column: decision.column ?? null,
  hasPublicExplanation: Boolean(decision.explanation),
}));
