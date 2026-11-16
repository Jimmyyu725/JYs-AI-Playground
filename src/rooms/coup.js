import fs from "node:fs";
import path from "node:path";
import { coupDecisionPrompt, coupDecisionSchema } from "../games/coup/ai-view.js";
import { publicView } from "../games/coup/engine.js";
import { CoupTable, GAME_ID, personaFor } from "../games/coup/table.js";
import { requestStructuredDecision } from "../platform/decision-gateway.js";
import { createMatchRecorder, createSSEChannel, httpError } from "../platform/room-kit.js";

export const id = GAME_ID;
export const defaults = { model: "gpt-6-luna", reasoningEffort: "low" };

const STRATEGY_NOTE = `

PLAYING WELL
Bluffing is legal and often strong: claim roles you do not hold when the odds favour it, and challenge claims that the revealed cards and the table's history make unlikely. Track which cards are already face up (only 3 of each exist). Remember that a failed challenge costs you an influence, so do not challenge by reflex. Speak up now and then (roughly one decision in three, and most of the time when you challenge, block, bluff or strike), in one short line. When you speak, stay in character: accuse, needle and bluff, but never state your real face-down cards.`;

/** Production decider: one structured request through the shared gateway. */
async function decideWithModel({ player, view, retry, onStatus }) {
  const schema = coupDecisionSchema(view);
  // The gateway adds its own required tableTalk string when `tableTalk` is passed.
  const { tableTalk: _talk, ...properties } = schema.properties;
  const response = await requestStructuredDecision(
    {
      gameId: GAME_ID,
      modelConfig: player.aiConfig,
      instructions: `${coupDecisionPrompt(view, retry)}${STRATEGY_NOTE}`,
      input: `Step ${view.step}. ${view.situation} Answer with your actionId now.`,
      schemaName: "coup_decision",
      schema: { ...schema, properties, required: schema.required.filter((key) => key !== "tableTalk") },
      tableTalk: { voice: player.character?.voice ?? "" },
    },
    { onStatus },
  );
  return response;
}

export function register(app, ctx) {
  const channel = createSSEChannel();
  const recordOnce = createMatchRecorder(ctx.results, GAME_ID);
  const savePath = path.join(ctx.dataDir, "coup-table.json");
  let table = null;
  let saveTimer = null;

  function save() {
    if (!table) return;
    clearTimeout(saveTimer);
    const current = table;
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        const temporary = `${savePath}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(current));
        fs.renameSync(temporary, savePath);
      } catch (error) {
        console.error(`Could not save the Coup table: ${error.message}`);
      }
    }, 250);
  }

  function recordResult(current) {
    const ranking = current.finalRanking();
    if (!ranking) return;
    recordOnce(current, "game", () => ({
      mode: current.mode,
      participants: ranking.map(({ seat, place }) => {
        const entry = current.seats[seat];
        return entry.isHuman
          ? { kind: "human", name: entry.name, place }
          : { kind: "ai", name: entry.name, characterId: entry.character?.id ?? null, model: entry.aiConfig.model, reasoningEffort: entry.aiConfig.reasoningEffort, place };
      }),
      details: { turns: current.state.turn, stalemate: Boolean(current.stalemate) },
    }));
  }

  function makeEmit(getTable) {
    return (type, payload) => {
      const current = getTable();
      if (!current || current !== table) return;
      if (type === "changed") {
        recordResult(current);
        save();
        return;
      }
      channel.broadcast(type, payload);
    };
  }

  function createTable(config, restore = null) {
    let created = null;
    created = new CoupTable(config, { decide: decideWithModel, emit: makeEmit(() => created), restore });
    return created;
  }

  try {
    if (fs.existsSync(savePath)) table = createTable({}, JSON.parse(fs.readFileSync(savePath, "utf8")));
  } catch (error) {
    console.error(`Could not restore the saved Coup table: ${error.message}`);
    table = null;
  }

  function requireTable() {
    if (!table) throw httpError(409, "Start a Coup table first");
    return table;
  }

  app.get("/api/coup/state", (_request, response) => response.json(table ? table.publicState() : null));
  app.get("/api/coup/events", channel.handler(() => (table ? table.publicState() : null)));

  app.post("/api/coup/game", (request, response) => {
    const next = createTable(request.body ?? {});
    // Without this, a replaced arena would keep playing (and paying for model calls) unseen.
    table?.retire();
    table = next;
    save();
    response.status(201).json(next.publicState());
    next.emitState();
    next.pump();
  });

  app.post("/api/coup/action", (request, response) => {
    const current = requireTable();
    current.humanAction(request.body?.action, request.body?.decisionKey);
    response.json(current.publicState());
  });

  // Post-game review in a character's own voice. Only after the game, when every card may be shown.
  app.post("/api/coup/review", async (request, response) => {
    const current = requireTable();
    if (!current.isOver) throw httpError(409, "Reviews open once the game is over");
    const seat = Number(request.body?.seat);
    const entry = current.seats[seat];
    if (!entry || entry.isHuman) throw httpError(400, "Choose an AI seat to review the game");
    current.reviews ??= {};
    if (!current.reviews[seat]) {
      const view = publicView(current.state, null, { revealAll: true });
      const human = current.seats.find((other) => other.isHuman);
      const table = view.players.map((player) => `${player.name} (seat ${player.seat}): ${player.alive ? `survived holding ${player.hidden.join(", ")}` : "eliminated"}; lost ${player.revealed.join(", ") || "nothing"}`).join("\n");
      const result = await requestStructuredDecision({
        gameId: GAME_ID,
        modelConfig: entry.aiConfig,
        instructions: `You are ${personaFor(entry.character)} Voice: ${entry.character?.voice ?? ""}\nYou just played a game of Coup (the bluffing card game) at a Venetian masquerade. Review the game in character, in at most 5 short sentences: the turning point, the best bluff or challenge, and one concrete lesson${human ? ` for ${human.name}, the human player` : " for the table"}. Refer to real events from the log only.`,
        input: `FINAL TABLE\n${table}\n\nGAME LOG\n${view.log.map((line) => line.text).join("\n")}`,
        schemaName: "coup_review",
        schema: { type: "object", properties: { review: { type: "string", maxLength: 900 } }, required: ["review"], additionalProperties: false },
      });
      current.reviews[seat] = String(result.output?.review ?? "").trim().slice(0, 900);
    }
    response.json({ seat, name: entry.name, review: current.reviews[seat] });
  });

  app.post("/api/coup/retry-ai", (_request, response) => {
    const current = requireTable();
    current.retryAI();
    response.json(current.publicState());
  });

  app.post("/api/coup/arena/pause", (_request, response) => {
    const current = requireTable();
    current.setPaused(true);
    response.json(current.publicState());
  });

  app.post("/api/coup/arena/resume", (_request, response) => {
    const current = requireTable();
    current.setPaused(false);
    response.json(current.publicState());
  });

  return {
    onListen() {
      table?.pump();
    },
  };
}
