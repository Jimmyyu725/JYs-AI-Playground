import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { requestLunaDecision } from "../src/openai-player.js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(rootDir, ".env.local") });

const snapshot = {
  handNumber: 0,
  phase: "flop",
  actor: {
    seat: 1,
    name: "Selene Park",
    title: "The Oracle",
    personality: "Analytical, disciplined, and observant.",
    stack: 980,
    holeCards: ["AS", "KD"],
    streetBet: 0,
    totalCommitted: 20,
  },
  table: {
    dealerSeat: 0,
    smallBlind: 10,
    bigBlind: 20,
    pot: 60,
    currentBet: 0,
    communityCards: ["QS", "7D", "2C"],
    players: [
      { seat: 0, name: "You", stack: 980, streetBet: 0, totalCommitted: 20, folded: false, allIn: false, inHand: true, lastAction: "Check" },
      { seat: 1, name: "Selene Park", stack: 980, streetBet: 0, totalCommitted: 20, folded: false, allIn: false, inHand: true, lastAction: "" },
      { seat: 2, name: "Rook Mercer", stack: 980, streetBet: 0, totalCommitted: 20, folded: false, allIn: false, inHand: true, lastAction: "Check" },
    ],
  },
  legal: {
    actions: ["check", "bet", "all_in"],
    toCall: 0,
    callAmount: 0,
    aggressiveAction: "bet",
    minimumTotal: 20,
    maximumTotal: 980,
    allInTotal: 980,
  },
  recentActions: ["You check.", "Rook checks."],
};

const startedAt = performance.now();
const decision = await requestLunaDecision(snapshot);
console.log(
  JSON.stringify({
    ok: true,
    model: "gpt-6-luna",
    reasoningEffort: "medium",
    action: decision.action,
    hasReasoningSummary: Boolean(decision.reasoningSummary),
    latencyMs: Math.round(performance.now() - startedAt),
  }),
);

