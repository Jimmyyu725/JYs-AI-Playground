import assert from "node:assert/strict";
import test from "node:test";
import { CoupTable, MAX_DECISION_RETRIES } from "../src/games/coup/table.js";
import { awaitingSeats, checkInvariants } from "../src/games/coup/engine.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(table, limit = 20_000) {
  for (let index = 0; index < limit; index += 1) {
    await tick();
    if (table.inflight.size === 0) return;
  }
  throw new Error("table did not settle");
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

/** A stand-in model that picks a random legal option. */
function randomDecider(seed = 7) {
  const random = seededRandom(seed);
  return async ({ view }) => ({ output: { actionId: 1 + Math.floor(random() * view.legalActions.length) }, tableTalk: random() < 0.1 ? "Is that so?" : "" });
}

test("a human-vs-AI table seats the human at 0 and distinct random characters elsewhere", () => {
  const table = new CoupTable({ mode: "human-vs-ai", playerCount: 5, humanName: "Jay" }, { decide: randomDecider() });
  const state = table.publicState();
  assert.equal(state.seats.length, 5);
  assert.equal(state.seats[0].isHuman, true);
  assert.equal(state.seats[0].name, "Jay");
  const ids = state.seats.slice(1).map((seat) => seat.character.id);
  assert.equal(new Set(ids).size, 4);
  assert.ok(state.seats.slice(1).every((seat) => seat.model && seat.reasoningEffort));
  // The human sees their own cards and nobody else's.
  assert.equal(state.players[0].hidden.length, 2);
  assert.ok(state.players.slice(1).every((player) => player.hidden === null));
  assert.equal(JSON.stringify(state).includes("rngState"), false);
});

test("a pinned character takes its seat and the rest are filled at random", () => {
  const table = new CoupTable({ mode: "arena", playerCount: 3, aiPlayers: [{ characterId: "kenji" }, { characterId: "kenji" }, {}] }, { decide: randomDecider() });
  const ids = table.seats.map((seat) => seat.character.id);
  assert.equal(ids[0], "kenji");
  assert.equal(new Set(ids).size, 3);
});

test("AI reasoning summaries stay hidden from the human until the game ends", async () => {
  const table = new CoupTable({ mode: "human-vs-ai", playerCount: 2, seed: 2 }, {
    decide: async () => ({ output: { actionId: 1 }, reasoningSummary: "I hold the Duke.", tableTalk: "" }),
  });
  table.state.activeSeat = 1;
  table.pump();
  await settle(table);
  assert.equal(table.insights[1].summary, "I hold the Duke.");
  assert.equal(table.publicState().insights[1].summary, "");
  assert.equal(JSON.stringify(table.publicState()).includes("I hold the Duke"), false);
});

test("rejects a bad player count", () => {
  assert.throws(() => new CoupTable({ playerCount: 7 }, { decide: randomDecider() }), /2-6/);
});

test("arena games driven by a stand-in model all finish with a ranking", async () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const table = new CoupTable({ mode: "arena", playerCount: 2 + (seed % 5), seed }, { decide: randomDecider(seed) });
    table.pump();
    for (let guard = 0; guard < 400 && !table.isOver; guard += 1) await settle(table);
    assert.ok(table.isOver, `seed ${seed} did not finish`);
    assert.deepEqual(checkInvariants(table.state), []);
    const ranking = table.finalRanking();
    assert.equal(ranking.length, table.seats.length);
    assert.deepEqual(ranking.map((entry) => entry.place), table.seats.map((_, index) => index + 1));
  }
});

test("the table waits for the human and applies their legal moves", async () => {
  const table = new CoupTable({ mode: "human-vs-ai", playerCount: 3, seed: 11 }, { decide: randomDecider(3) });
  table.pump();
  for (let guard = 0; guard < 500 && !table.isOver; guard += 1) {
    await settle(table);
    if (table.isOver) break;
    if (awaitingSeats(table.state).includes(0)) {
      const { legalActions } = table.publicState();
      assert.ok(legalActions.length > 0);
      table.humanAction(legalActions[0].action);
    }
  }
  assert.ok(table.isOver);
  assert.throws(() => table.humanAction({ type: "income" }), /over/);
});

test("illegal human actions are refused with a 400", () => {
  const table = new CoupTable({ mode: "human-vs-ai", playerCount: 2, seed: 5 }, { decide: randomDecider() });
  table.state.activeSeat = 0;
  assert.throws(() => table.humanAction({ type: "coup", target: 1 }), (error) => error.status === 400);
});

test("malformed answers are retried twice with the error fed back, then the table pauses", async () => {
  const calls = [];
  const table = new CoupTable({ mode: "arena", playerCount: 2, seed: 3 }, {
    decide: async (request) => {
      calls.push(request.retry);
      return { output: { actionId: 99 }, tableTalk: null };
    },
  });
  table.pump();
  await settle(table);
  assert.equal(calls.length, MAX_DECISION_RETRIES + 1);
  assert.equal(calls[0], null);
  assert.match(calls[1].error, /not one of the legal options/);
  assert.equal(calls[2].retryNumber, 2);
  assert.ok(table.aiError);
  assert.match(table.aiError.message, /unusable answers/);
  // Nothing moved: there is no fallback player.
  assert.equal(table.state.step, 0);
});

test("a gateway failure pauses immediately and retry resumes the same decision", async () => {
  let fail = true;
  let calls = 0;
  const table = new CoupTable({ mode: "arena", playerCount: 2, seed: 4 }, {
    decide: async () => {
      calls += 1;
      if (fail) throw Object.assign(new Error("rate limited"), { code: "rate_limit" });
      return { output: { actionId: 1 }, tableTalk: "Patience." };
    },
  });
  table.pump();
  await settle(table);
  assert.equal(calls, 1);
  assert.deepEqual({ ...table.aiError, seat: undefined }, { seat: undefined, name: table.seats[table.aiError.seat].name, message: "rate limited" });
  fail = false;
  table.retryAI();
  await settle(table);
  assert.equal(table.aiError, null);
  assert.ok(table.state.step > 0);
  assert.ok(table.tableTalk.some((line) => line.text === "Patience."));
});

test("answers to a reaction window that already closed are dropped", async () => {
  // Seat 1 challenges at once; seat 2's slower answer arrives after the window has closed.
  const releases = [];
  const table = new CoupTable({ mode: "arena", playerCount: 3, seed: 9 }, {
    decide: ({ seat, view }) => {
      const option = (type) => view.legalActions.find((entry) => entry.action.type === type)?.id ?? 1;
      if (view.phase === "action") return Promise.resolve({ output: { actionId: option("tax") } });
      if (view.phase === "challenge_action" && seat === 2) return new Promise((resolve) => releases.push(() => resolve({ output: { actionId: option("pass") } })));
      if (view.phase === "challenge_action") return Promise.resolve({ output: { actionId: option("challenge") } });
      return new Promise(() => {});
    },
  });
  table.state.activeSeat = 0;
  table.pump();
  for (let index = 0; index < 50; index += 1) await tick();
  const stepAfterChallenge = table.state.step;
  assert.notEqual(table.state.phase, "challenge_action");
  releases.forEach((release) => release());
  for (let index = 0; index < 20; index += 1) await tick();
  assert.equal(table.state.step, stepAfterChallenge);
  assert.equal(table.state.log.filter((entry) => entry.kind === "pass").length, 0);
});

test("a saved table restores with the same state and seats", () => {
  const table = new CoupTable({ mode: "human-vs-ai", playerCount: 4, seed: 21 }, { decide: randomDecider() });
  const saved = JSON.parse(JSON.stringify(table));
  const restored = new CoupTable({}, { decide: randomDecider(), restore: saved });
  assert.deepEqual(restored.state, table.state);
  assert.deepEqual(restored.publicState().seats, table.publicState().seats);
});
