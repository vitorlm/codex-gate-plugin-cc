import assert from "node:assert/strict";
import { test } from "node:test";
import { dropNulls, strictOutputSchema, validate } from "./review-schema.mjs";

const VALID_REVIEW = {
  verdict: "request_changes",
  summary: "One blocker found.",
  findings: [
    {
      category: "security",
      severity: "blocker",
      file: "cart.js",
      title: "SQL injection",
      detail: "User id interpolated into SQL.",
    },
  ],
  next_steps: ["Parameterize the query."],
};

test("dropNulls removes null-valued keys recursively, leaves non-null values", () => {
  const input = {
    a: 1,
    b: null,
    nested: { c: null, d: "keep" },
    arr: [{ e: null, f: 2 }],
  };
  assert.deepEqual(dropNulls(input), {
    a: 1,
    nested: { d: "keep" },
    arr: [{ f: 2 }],
  });
});

test("dropNulls does not mutate its input", () => {
  const input = { a: null, b: 1 };
  dropNulls(input);
  assert.deepEqual(input, { a: null, b: 1 });
});

test("validate('review', payload) returns ok with the normalized value for a valid payload", async () => {
  const result = await validate("review", VALID_REVIEW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, VALID_REVIEW);
});

test("strictOutputSchema('review') returns an OpenAI-strict schema (all props required, no minimum)", () => {
  const schema = strictOutputSchema("review");
  const finding = schema.properties.findings.items;
  // every declared property is required (OpenAI strict subset)
  assert.deepEqual([...finding.required].sort(), [...Object.keys(finding.properties)].sort());
  assert.equal(finding.properties.line_start.minimum, undefined);
});

test("strictOutputSchema('adversarial') returns an OpenAI-strict schema", () => {
  const schema = strictOutputSchema("adversarial");
  const challenge = schema.properties.challenges.items;
  assert.deepEqual([...challenge.required].sort(), [...Object.keys(challenge.properties)].sort());
});

// --- Increment B: tolerant normalization (the §9 pipeline) ---

test("validate normalizes strict-output nulls on optional fields away", async () => {
  // What Codex returns under the strict outputSchema: optionals present as null.
  const strictShaped = {
    ...VALID_REVIEW,
    findings: [{ ...VALID_REVIEW.findings[0], line_start: null, line_end: null, suggestion: null }],
  };
  const result = await validate("review", strictShaped);
  assert.equal(result.ok, true);
  assert.equal("line_start" in result.value.findings[0], false);
  assert.equal("suggestion" in result.value.findings[0], false);
});

test("validate strips unknown keys instead of hard-failing (model verbosity)", async () => {
  const verbose = {
    ...VALID_REVIEW,
    confidence: 0.9, // not in schema
    findings: [{ ...VALID_REVIEW.findings[0], rationale: "extra" }],
  };
  const result = await validate("review", verbose);
  assert.equal(result.ok, true);
  assert.equal("confidence" in result.value, false);
  assert.equal("rationale" in result.value.findings[0], false);
});

// --- Increment C: failure contract (never silently approve) ---

test("validate rejects an invalid severity enum as SCHEMA_INVALID", async () => {
  const bad = {
    ...VALID_REVIEW,
    findings: [{ ...VALID_REVIEW.findings[0], severity: "catastrophic" }],
  };
  const result = await validate("review", bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, "SCHEMA_INVALID");
});

test("validate rejects a payload missing verdict (no silent approval)", async () => {
  const { verdict, ...noVerdict } = VALID_REVIEW;
  const result = await validate("review", noVerdict);
  assert.equal(result.ok, false);
  assert.equal(result.code, "SCHEMA_INVALID");
});

test("adversarial: empty challenges with an explicit 'sound' verdict is a valid result", async () => {
  const sound = { verdict: "sound", summary: "No blocking challenges.", challenges: [] };
  const result = await validate("adversarial", sound);
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, "sound");
});

test("adversarial: missing verdict is rejected ('sound' is never inferred)", async () => {
  const result = await validate("adversarial", { summary: "x", challenges: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SCHEMA_INVALID");
});

test("validate rejects an unknown schema kind", async () => {
  await assert.rejects(() => validate("nonsense", VALID_REVIEW), /unknown schema kind/);
});
