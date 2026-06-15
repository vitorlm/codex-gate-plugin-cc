import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprint, gatingSeverity, madeProgress, severityRank } from "./loop-state.mjs";

test("fingerprint is stable across reworded location/line but keyed by category+message", () => {
  const a = fingerprint({ category: "security", title: "SQL injection in query", line_start: 14 });
  const b = fingerprint({
    category: "security",
    title: "SQL   injection in query",
    line_start: 99,
  });
  assert.equal(a, b); // whitespace + line differences normalize away
  assert.match(a, /^v1:/);
});

test("fingerprint differs when category or message differs", () => {
  const base = fingerprint({ category: "security", title: "x" });
  assert.notEqual(base, fingerprint({ category: "concurrency", title: "x" }));
  assert.notEqual(base, fingerprint({ category: "security", title: "y" }));
});

test("gatingSeverity is host-derived by category, ignoring any model severity", () => {
  // model says "info" but security is host-mapped to blocker
  assert.equal(gatingSeverity({ category: "security", severity: "info" }), "blocker");
  assert.equal(gatingSeverity({ category: "concurrency", severity: "minor" }), "blocker");
  assert.equal(gatingSeverity({ category: "correctness" }), "blocker");
  assert.equal(gatingSeverity({ category: "data-integrity" }), "blocker");
  assert.equal(gatingSeverity({ category: "style", severity: "blocker" }), "info");
  assert.equal(gatingSeverity({ category: "unknown-thing" }), "minor"); // default
});

test("severityRank orders info < minor < major < blocker", () => {
  assert.ok(severityRank("info") < severityRank("minor"));
  assert.ok(severityRank("minor") < severityRank("major"));
  assert.ok(severityRank("major") < severityRank("blocker"));
});

test("madeProgress requires the open-blocking set to strictly shrink (subset)", () => {
  // shrank: {a,b} -> {a}  → progress
  assert.equal(madeProgress(["a", "b"], ["a"]), true);
  // unchanged: {a,b} -> {a,b}  → no progress
  assert.equal(madeProgress(["a", "b"], ["a", "b"]), false);
  // churn (swapped one): {a,b} -> {a,c}  → no progress (c is new)
  assert.equal(madeProgress(["a", "b"], ["a", "c"]), false);
  // fixed all: {a} -> {}  → progress
  assert.equal(madeProgress(["a"], []), true);
});
