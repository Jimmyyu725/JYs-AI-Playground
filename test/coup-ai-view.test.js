import test from "node:test";
import assert from "node:assert/strict";
import { applyAction, createCoupGame, getLegalActions, liveCards } from "../src/games/coup/engine.js";
import {
  TABLE_TALK_MAX,
  buildCoupAiView,
  coupDecisionPrompt,
  coupDecisionSchema,
  parseCoupDecision,
} from "../src/games/coup/ai-view.js";

function newGame({ coins = null, startingSeat = 0 } = {}) {
  const state = createCoupGame({
    players: ["Ada", "Bo", "Cy"],
    deal: [["Duke", "Captain"], ["Assassin", "Contessa"], ["Ambassador", "Duke"]],
    startingSeat,
    seed: 11,
  });
  if (coins) coins.forEach((amount, seat) => { state.players[seat].coins = amount; });
  return state;
}

test("the view shows the seat's own cards but only counts for opponents", () => {
  const state = newGame();
  const view = buildCoupAiView(state, 1, { persona: "Cold and patient." });
  assert.deepEqual(view.you.faceDownCards, ["Assassin", "Contessa"]);
  assert.equal(view.you.persona, "Cold and patient.");
  assert.equal(view.yourTurnToDecide, false);
  assert.deepEqual(view.legalActions, []);
  assert.deepEqual(view.opponents.map((player) => player.seat), [0, 2]);
  for (const opponent of view.opponents) {
    assert.equal(opponent.faceDownCount, 2);
    assert.deepEqual(Object.keys(opponent).sort(), ["alive", "coins", "faceDownCount", "lostCards", "name", "seat"]);
  }
  const json = JSON.stringify(view);
  assert.equal(json.includes("rngState"), false);
  assert.equal(json.includes("\"deck\""), false);
  // Only seat 2 holds an Ambassador, so seat 1's view must not mention one anywhere.
  assert.equal(json.includes("Ambassador"), false);
});

test("legal actions are numbered from 1 and match the engine", () => {
  const state = newGame();
  const view = buildCoupAiView(state, 0);
  assert.equal(view.yourTurnToDecide, true);
  assert.deepEqual(view.legalActions.map((entry) => entry.id), view.legalActions.map((_, index) => index + 1));
  assert.deepEqual(view.legalActions.map((entry) => entry.action), getLegalActions(state, 0));
  assert.ok(view.legalActions.every((entry) => typeof entry.label === "string" && entry.label.length > 0));
  assert.match(view.situation, /your turn/);
});

test("forced coup leaves only coup options and says so", () => {
  const view = buildCoupAiView(newGame({ coins: [10, 2, 2] }), 0);
  assert.deepEqual(view.legalActions.map((entry) => entry.action.type), ["coup", "coup"]);
  assert.match(view.situation, /must launch a Coup/);
});

test("reaction windows describe the claim and offer pass or challenge", () => {
  let state = newGame({ coins: [3, 2, 2] });
  state = applyAction(state, 0, { type: "assassinate", target: 1 });
  const view = buildCoupAiView(state, 1);
  assert.match(view.situation, /Ada declared assassinate against YOU claiming Assassin \(the 3-coin cost is already paid/);
  assert.deepEqual(view.legalActions.map((entry) => entry.action.type), ["pass", "challenge"]);
  assert.match(view.legalActions[1].label, /Challenge Ada's claim to hold Assassin/);
  assert.deepEqual(view.pendingAction, { type: "assassinate", actor: 0, target: 1, claim: "Assassin" });
});

test("exchange options are visible only to the exchanging seat", () => {
  let state = newGame({ startingSeat: 2 });
  state = applyAction(state, 2, { type: "exchange" });
  state = applyAction(state, 0, { type: "pass" });
  state = applyAction(state, 1, { type: "pass" });
  const actorView = buildCoupAiView(state, 2);
  assert.equal(actorView.exchangeOptions.length, 4);
  assert.ok(actorView.legalActions.every((entry) => /^Keep .+, return .+/.test(entry.label)));
  assert.equal(buildCoupAiView(state, 0).exchangeOptions, null);
});

test("the decision schema is strict and caps table talk at 140 characters", () => {
  const view = buildCoupAiView(newGame(), 0);
  const schema = coupDecisionSchema(view);
  assert.deepEqual(schema.required, ["actionId", "tableTalk"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.actionId.enum, view.legalActions.map((entry) => entry.id));
  assert.equal(schema.properties.tableTalk.anyOf[0].maxLength, TABLE_TALK_MAX);
  assert.equal(TABLE_TALK_MAX, 140);
  assert.deepEqual(schema.properties.tableTalk.anyOf[1], { type: "null" });
});

test("the prompt lists the numbered options, the situation and retry feedback", () => {
  const view = buildCoupAiView(newGame(), 0, { persona: "Loud." });
  const prompt = coupDecisionPrompt(view);
  assert.match(prompt, /You are Ada, playing Coup at seat 0/);
  assert.match(prompt, /Character: Loud\./);
  assert.match(prompt, /1\. Income: take 1 coin/);
  assert.match(prompt, /Face-down cards \(secret\): Duke, Captain/);
  assert.doesNotMatch(prompt, /AUTOMATIC RETRY/);
  const retry = coupDecisionPrompt(view, { retryNumber: 1, maxRetries: 2, error: "actionId 99 is not one of the legal options 1-10" });
  assert.match(retry, /AUTOMATIC RETRY 1\/2: .*actionId 99/);
});

test("a valid answer maps to the legal action and applies cleanly", () => {
  const state = newGame();
  const view = buildCoupAiView(state, 0);
  const taxId = view.legalActions.find((entry) => entry.action.type === "tax").id;
  const parsed = parseCoupDecision(state, 0, JSON.stringify({ actionId: taxId, tableTalk: "  The Duke sends his regards.  " }), { viewStep: view.step });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.action, { type: "tax" });
  assert.equal(parsed.tableTalk, "The Duke sends his regards.");
  const next = applyAction(state, 0, parsed.action);
  assert.equal(next.phase, "challenge_action");

  const silent = parseCoupDecision(state, 0, { actionId: 1, tableTalk: null });
  assert.equal(silent.tableTalk, null);
  const missingTalk = parseCoupDecision(state, 0, { actionId: 1 });
  assert.equal(missingTalk.ok, true);
  assert.equal(missingTalk.tableTalk, null);
  const long = parseCoupDecision(state, 0, { actionId: 1, tableTalk: "x".repeat(300) });
  assert.equal(long.tableTalk.length, TABLE_TALK_MAX);
});

test("malformed answers return precise retryable errors", () => {
  const state = newGame();
  const count = getLegalActions(state, 0).length;
  const cases = [
    ["{oops", "invalid_json", /not valid JSON/],
    ["[1]", "invalid_shape", /JSON object/],
    [{ tableTalk: null }, "invalid_action_id", /actionId is missing/],
    [{ actionId: "2", tableTalk: null }, "invalid_action_id", /must be an integer in 1-\d+, got "2"/],
    [{ actionId: 1.5, tableTalk: null }, "invalid_action_id", /must be an integer/],
    [{ actionId: 0, tableTalk: null }, "invalid_action_id", new RegExp(`actionId 0 is not one of the legal options 1-${count}`)],
    [{ actionId: count + 1, tableTalk: null }, "invalid_action_id", /not one of the legal options/],
    [{ actionId: 1, tableTalk: 42 }, "invalid_table_talk", /tableTalk must be a string/],
  ];
  for (const [raw, code, message] of cases) {
    const result = parseCoupDecision(state, 0, raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, code, JSON.stringify(raw));
    assert.equal(result.retryable, true);
    assert.match(result.error, message);
  }
});

test("answers from the wrong seat, a stale view or a finished game are not retryable", () => {
  const state = newGame();
  const wrongSeat = parseCoupDecision(state, 1, { actionId: 1, tableTalk: null });
  assert.equal(wrongSeat.code, "not_awaited");
  assert.equal(wrongSeat.retryable, false);
  const stale = parseCoupDecision(state, 0, { actionId: 1, tableTalk: null }, { viewStep: state.step - 1 });
  assert.equal(stale.code, "stale_view");
  assert.equal(stale.retryable, false);

  const finished = createCoupGame({ players: ["A", "B"], deal: [["Duke", "Duke"], ["Captain", "Contessa"]], startingSeat: 0, seed: 2 });
  finished.players[0].coins = 7;
  finished.players[1].influence[0].revealed = true;
  const over = applyAction(finished, 0, { type: "coup", target: 1 });
  assert.equal(over.phase, "game_over");
  assert.equal(parseCoupDecision(over, 0, { actionId: 1, tableTalk: null }).code, "game_over");
});

test("lose-influence choices list only the seat's own face-down cards", () => {
  let state = newGame({ coins: [7, 2, 2] });
  state = applyAction(state, 0, { type: "coup", target: 1 });
  const view = buildCoupAiView(state, 1);
  assert.match(view.situation, /must lose one influence \(reason: coup\)/);
  assert.deepEqual(view.legalActions.map((entry) => entry.action), [
    { type: "reveal", card: "Assassin" },
    { type: "reveal", card: "Contessa" },
  ]);
  const parsed = parseCoupDecision(state, 1, { actionId: 2, tableTalk: "Fine." });
  const next = applyAction(state, 1, parsed.action);
  assert.deepEqual(liveCards(next.players[1]), ["Assassin"]);
});

test("recent events leave out passes so earlier claims stay in view", () => {
  let state = newGame();
  state = applyAction(state, 0, { type: "tax" });
  state = applyAction(state, 1, { type: "pass" });
  state = applyAction(state, 2, { type: "pass" });
  const view = buildCoupAiView(state, 1);
  assert.ok(view.recentEvents.some((text) => text.includes("declares tax")));
  assert.equal(view.recentEvents.some((text) => text.includes("passes")), false);
});
