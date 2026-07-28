import test from "node:test";
import assert from "node:assert/strict";
import { compareEvaluations, evaluateBest, resolveSidePots } from "../src/hand-evaluator.js";

test("evaluates a royal flush as a straight flush", () => {
  const result = evaluateBest(["AS", "KS", "QS", "JS", "TS", "2D", "3C"]);
  assert.equal(result.category, 8);
  assert.equal(result.description, "Straight flush");
  assert.deepEqual(result.score, [8, 14]);
});

test("recognizes an ace-low straight", () => {
  const result = evaluateBest(["AS", "2D", "3C", "4H", "5S", "KD", "QC"]);
  assert.deepEqual(result.score, [4, 5]);
});

test("breaks pair ties with kickers", () => {
  const aceKicker = evaluateBest(["9S", "9D", "AS", "KC", "4H", "3D", "2C"]);
  const queenKicker = evaluateBest(["9H", "9C", "QS", "JC", "8H", "3S", "2D"]);
  assert.equal(compareEvaluations(aceKicker, queenKicker), 1);
});

test("resolves main and side pots independently", () => {
  const players = [
    { seat: 0, totalCommitted: 100, inHand: true, folded: false, holeCards: ["AS", "AD"] },
    { seat: 1, totalCommitted: 300, inHand: true, folded: false, holeCards: ["KS", "KD"] },
    { seat: 2, totalCommitted: 300, inHand: true, folded: false, holeCards: ["QS", "QD"] },
  ];
  const result = resolveSidePots(players, ["2C", "3D", "4H", "8S", "9C"], 2);
  assert.deepEqual(result.payouts, { 0: 300, 1: 400, 2: 0 });
  assert.equal(result.pots.length, 2);
});

