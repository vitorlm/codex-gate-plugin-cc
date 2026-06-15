import assert from "node:assert/strict";
import { test } from "node:test";
import { freshState, postReview, preReview } from "./loop-state.mjs";

const CONFIG = { maxIterations: 3, tokenBudget: 400_000, threshold: "blocker" };
const scope = (over = {}) => ({ empty: false, diffHash: "h1", ...over });
const usage = { input_tokens: 1000, output_tokens: 50 };

// --- preReview (steps 1–4) ---

test("preReview allows immediately when stop_hook_active (reentrancy guard)", () => {
  const r = preReview(freshState(), { hookActive: true, scope: scope(), config: CONFIG });
  assert.equal(r.action, "allow");
});

test("preReview allows when the scope is empty (nothing to review)", () => {
  const r = preReview(freshState(), {
    hookActive: false,
    scope: scope({ empty: true }),
    config: CONFIG,
  });
  assert.equal(r.action, "allow");
});

test("preReview allows when the diff is unchanged since the last pass", () => {
  const st = { ...freshState(), diffHash: "h1" };
  const r = preReview(st, { hookActive: false, scope: scope({ diffHash: "h1" }), config: CONFIG });
  assert.equal(r.action, "allow");
});

test("preReview increments iteration and proceeds to review on a fresh change", () => {
  const r = preReview(freshState(), {
    hookActive: false,
    scope: scope({ diffHash: "new" }),
    config: CONFIG,
  });
  assert.equal(r.action, "review");
  assert.equal(r.state.iteration, 1);
});

test("preReview opens (fail-open) once iteration exceeds the cap", () => {
  const st = { ...freshState(), iteration: 3 };
  const r = preReview(st, { hookActive: false, scope: scope({ diffHash: "x" }), config: CONFIG });
  assert.equal(r.action, "open");
  assert.match(r.reason, /iteration/i);
});

test("preReview opens when the token budget is exceeded", () => {
  const st = { ...freshState(), tokensSpent: 500_000 };
  const r = preReview(st, { hookActive: false, scope: scope({ diffHash: "x" }), config: CONFIG });
  assert.equal(r.action, "open");
  assert.match(r.reason, /budget/i);
});

// --- postReview (steps 5–8) ---

const finding = (over) => ({
  category: "security",
  severity: "info",
  title: "SQL injection",
  ...over,
});

test("postReview blocks on a new blocking-severity finding", () => {
  const r = postReview(freshState(), {
    findings: [finding()],
    usage,
    scope: scope(),
    config: CONFIG,
  });
  assert.equal(r.decision, "block");
  assert.match(r.reason, /SQL injection/);
});

test("postReview uses host-derived severity (model 'info' on security still blocks)", () => {
  const r = postReview(freshState(), {
    findings: [finding({ severity: "info" })],
    usage,
    scope: scope(),
    config: CONFIG,
  });
  assert.equal(r.decision, "block");
});

test("postReview allows when only non-blocking categories are present (nits)", () => {
  const r = postReview(freshState(), {
    findings: [
      finding({ category: "style", title: "naming" }),
      finding({ category: "performance", title: "slow loop" }),
    ],
    usage,
    scope: scope(),
    config: CONFIG,
  });
  assert.equal(r.decision, "allow");
});

test("postReview does not block on a pre-existing (already-open) blocker — new findings only", () => {
  const first = postReview(freshState(), {
    findings: [finding()],
    usage,
    scope: scope(),
    config: CONFIG,
  });
  assert.equal(first.decision, "block"); // first time it is new → blocks
  // same finding again on the next round → not new → allow
  const second = postReview(first.state, {
    findings: [finding()],
    usage,
    scope: scope({ diffHash: "h2" }),
    config: CONFIG,
  });
  assert.notEqual(second.decision, "block");
});

test("postReview marks an addressed-then-reappearing finding as contested (oscillation), excluded from blocking", () => {
  // Round 1: blocks on the finding.
  const r1 = postReview(freshState(), {
    findings: [finding()],
    usage,
    scope: scope(),
    config: CONFIG,
  });
  // Round 2: finding gone (addressed).
  const r2 = postReview(r1.state, {
    findings: [],
    usage,
    scope: scope({ diffHash: "h2" }),
    config: CONFIG,
  });
  // Round 3: finding reappears → contested, must NOT block.
  const r3 = postReview(r2.state, {
    findings: [finding()],
    usage,
    scope: scope({ diffHash: "h3" }),
    config: CONFIG,
  });
  assert.notEqual(r3.decision, "block");
});

test("postReview opens after 2 rounds with no strict shrink of the open-blocking set", () => {
  const two = [finding({ title: "A" }), finding({ category: "concurrency", title: "B" })];
  const r1 = postReview(freshState(), { findings: two, usage, scope: scope(), config: CONFIG });
  // same set churns (no shrink) across subsequent rounds
  const r2 = postReview(r1.state, {
    findings: two,
    usage,
    scope: scope({ diffHash: "h2" }),
    config: CONFIG,
  });
  const r3 = postReview(r2.state, {
    findings: two,
    usage,
    scope: scope({ diffHash: "h3" }),
    config: CONFIG,
  });
  assert.equal(r3.decision, "open");
  assert.match(r3.reason, /progress/i);
});

test("postReview accumulates token spend", () => {
  const r = postReview(freshState(), { findings: [], usage, scope: scope(), config: CONFIG });
  assert.equal(r.state.tokensSpent, 1050);
});
