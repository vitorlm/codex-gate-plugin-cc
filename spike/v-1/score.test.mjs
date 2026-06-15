import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreAll, scoreFixture } from "./score.mjs";

test("scoreFixture: Codex edge = TP class Codex caught and Claude missed", () => {
  const r = scoreFixture({
    id: "x",
    truthClasses: ["security:sqli", "correctness:off-by-one"],
    codexClasses: ["security:sqli", "correctness:off-by-one"],
    claudeClasses: ["correctness:off-by-one"],
  });
  assert.deepEqual(r.codexTruePositives, ["correctness:off-by-one", "security:sqli"]);
  assert.deepEqual(r.claudeTruePositives, ["correctness:off-by-one"]);
  assert.deepEqual(r.codexEdgeClasses, ["security:sqli"]);
  assert.equal(r.codexHasEdge, true);
  assert.deepEqual(r.claudeEdgeClasses, []);
});

test("scoreFixture: both catch the same classes → no edge for either", () => {
  const r = scoreFixture({
    id: "x",
    truthClasses: ["concurrency:race"],
    codexClasses: ["concurrency:race"],
    claudeClasses: ["concurrency:race"],
  });
  assert.deepEqual(r.codexEdgeClasses, []);
  assert.deepEqual(r.claudeEdgeClasses, []);
  assert.equal(r.codexHasEdge, false);
});

test("scoreFixture: both miss → no TPs, no edge", () => {
  const r = scoreFixture({
    id: "x",
    truthClasses: ["data-integrity:unvalidated"],
    codexClasses: [],
    claudeClasses: [],
  });
  assert.deepEqual(r.codexTruePositives, []);
  assert.deepEqual(r.claudeTruePositives, []);
  assert.equal(r.codexHasEdge, false);
});

test("scoreFixture: a class NOT in truth is never an edge (hallucination guard)", () => {
  const r = scoreFixture({
    id: "x",
    truthClasses: ["security:sqli"],
    // Codex reports a class Claude didn't, but it isn't in truth → FP, not edge.
    codexClasses: ["security:sqli", "performance:n-plus-one"],
    claudeClasses: ["security:sqli"],
  });
  assert.deepEqual(r.codexEdgeClasses, []);
  assert.equal(r.codexHasEdge, false);
  assert.deepEqual(r.codexFalsePositives, ["performance:n-plus-one"]);
});

test("scoreFixture: false positives counted on the defect-free control", () => {
  const r = scoreFixture({
    id: "control",
    truthClasses: [],
    codexClasses: ["security:sqli"],
    claudeClasses: ["correctness:logic", "style:naming"],
  });
  assert.deepEqual(r.codexFalsePositives, ["security:sqli"]);
  assert.deepEqual(r.claudeFalsePositives, ["correctness:logic", "style:naming"]);
  assert.deepEqual(r.codexTruePositives, []);
  assert.equal(r.codexHasEdge, false);
});

test("scoreFixture: edge is distinct-class based, dedupes repeated classes", () => {
  const r = scoreFixture({
    id: "x",
    truthClasses: ["security:sqli", "security:sqli"],
    codexClasses: ["security:sqli", "security:sqli"],
    claudeClasses: [],
  });
  assert.deepEqual(r.truth, ["security:sqli"]);
  assert.deepEqual(r.codexEdgeClasses, ["security:sqli"]);
});

test("scoreAll: >=30% threshold — exactly at boundary passes", () => {
  // 10 fixtures, 3 with a Codex edge → 0.30, FP-free.
  const edge = {
    truthClasses: ["security:sqli"],
    codexClasses: ["security:sqli"],
    claudeClasses: [],
  };
  const noEdge = {
    truthClasses: ["security:sqli"],
    codexClasses: ["security:sqli"],
    claudeClasses: ["security:sqli"],
  };
  const fixtures = [];
  for (let i = 0; i < 3; i++) fixtures.push({ id: `e${i}`, ...edge });
  for (let i = 0; i < 7; i++) fixtures.push({ id: `n${i}`, ...noEdge });

  const v = scoreAll(fixtures);
  assert.equal(v.fixtureCount, 10);
  assert.equal(v.fixturesWithCodexEdge, 3);
  assert.equal(v.fractionWithCodexEdge, 0.3);
  assert.equal(v.threshold, 0.3);
  assert.equal(v.criterionMet, true);
});

test("scoreAll: just below 30% fails the criterion", () => {
  // 10 fixtures, 2 with edge → 0.20 < 0.30.
  const edge = {
    truthClasses: ["security:sqli"],
    codexClasses: ["security:sqli"],
    claudeClasses: [],
  };
  const noEdge = {
    truthClasses: ["security:sqli"],
    codexClasses: ["security:sqli"],
    claudeClasses: ["security:sqli"],
  };
  const fixtures = [];
  for (let i = 0; i < 2; i++) fixtures.push({ id: `e${i}`, ...edge });
  for (let i = 0; i < 8; i++) fixtures.push({ id: `n${i}`, ...noEdge });

  const v = scoreAll(fixtures);
  assert.equal(v.fractionWithCodexEdge, 0.2);
  assert.equal(v.criterionMet, false);
});

test("scoreAll: edge threshold met but FP rate too high → criterion fails", () => {
  // 1 fixture: clears the edge fraction (1.0) but Codex over-reports 3 FPs
  // (rate 3.0 > default limit 0.5) → not acceptable.
  const v = scoreAll([
    {
      id: "noisy",
      truthClasses: ["security:sqli"],
      codexClasses: ["security:sqli", "a:1", "b:2", "c:3"],
      claudeClasses: [],
    },
  ]);
  assert.equal(v.fractionWithCodexEdge, 1);
  assert.equal(v.codexFpRate, 3);
  assert.equal(v.fpRateAcceptable, false);
  assert.equal(v.criterionMet, false);
});

test("scoreAll: configurable threshold and fpRateLimit are honoured", () => {
  const fixtures = [
    {
      id: "a",
      truthClasses: ["security:sqli"],
      codexClasses: ["security:sqli", "x:1"],
      claudeClasses: [],
    },
    {
      id: "b",
      truthClasses: ["security:sqli"],
      codexClasses: ["security:sqli"],
      claudeClasses: ["security:sqli"],
    },
  ];
  // 1/2 = 0.5 edge fraction; codex FP rate = 0.5.
  const strict = scoreAll(fixtures, { threshold: 0.6, fpRateLimit: 1 });
  assert.equal(strict.criterionMet, false); // 0.5 < 0.6
  const lenient = scoreAll(fixtures, { threshold: 0.5, fpRateLimit: 1 });
  assert.equal(lenient.criterionMet, true); // 0.5 >= 0.5 and FP 0.5 <= 1
  const fpStrict = scoreAll(fixtures, { threshold: 0.5, fpRateLimit: 0.4 });
  assert.equal(fpStrict.criterionMet, false); // FP 0.5 > 0.4
});

test("scoreAll: empty fixture set never passes", () => {
  const v = scoreAll([]);
  assert.equal(v.fixtureCount, 0);
  assert.equal(v.fractionWithCodexEdge, 0);
  assert.equal(v.criterionMet, false);
});

test("scoreAll: FP rate is a mean across all fixtures incl. control", () => {
  const v = scoreAll([
    { id: "f1", truthClasses: ["security:sqli"], codexClasses: ["security:sqli"], claudeClasses: [] },
    { id: "ctrl", truthClasses: [], codexClasses: ["x:1", "y:2"], claudeClasses: ["z:3"] },
  ]);
  assert.equal(v.codexTotalFalsePositives, 2);
  assert.equal(v.claudeTotalFalsePositives, 1);
  assert.equal(v.codexFpRate, 1); // 2 FPs / 2 fixtures
  assert.equal(v.claudeFpRate, 0.5);
});
