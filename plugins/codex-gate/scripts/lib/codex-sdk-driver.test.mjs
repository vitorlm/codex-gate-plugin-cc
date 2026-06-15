import assert from "node:assert/strict";
import { test } from "node:test";
import { createSdkDriver, stripApiKeys } from "./codex-sdk-driver.mjs";
import { strictOutputSchema, validate } from "./review-schema.mjs";

const VALID_REVIEW = {
  verdict: "approve",
  summary: "Looks fine.",
  findings: [],
  next_steps: [],
};

/**
 * Build a fake Codex class that records how it was constructed and called.
 * @param {{finalResponse?: string, usage?: object|null, throwError?: Error}} behavior
 */
function fakeCodex(behavior = {}) {
  const calls = { env: null, threadOptions: null, runInput: null, runTurnOptions: null };
  class FakeCodex {
    constructor(opts) {
      calls.env = opts?.env ?? null;
    }
    startThread(options) {
      calls.threadOptions = options;
      return {
        id: "thread-1",
        async run(input, turnOptions) {
          calls.runInput = input;
          calls.runTurnOptions = turnOptions;
          if (behavior.throwError) throw behavior.throwError;
          return {
            items: [],
            finalResponse: behavior.finalResponse ?? JSON.stringify(VALID_REVIEW),
            usage: behavior.usage ?? null,
          };
        },
      };
    }
  }
  return { FakeCodex, calls };
}

function makeDriver(behavior, env) {
  const { FakeCodex, calls } = fakeCodex(behavior);
  const driver = createSdkDriver({
    getCodex: async () => FakeCodex,
    env: env ?? { PATH: "/usr/bin" },
    validate,
    strictOutputSchema,
  });
  return { driver, calls };
}

test("stripApiKeys removes OpenAI/Codex API keys, preserves other vars, non-mutating", () => {
  const env = { OPENAI_API_KEY: "sk-x", CODEX_API_KEY: "ck-y", PATH: "/bin", HOME: "/h" };
  const out = stripApiKeys(env);
  assert.equal("OPENAI_API_KEY" in out, false);
  assert.equal("CODEX_API_KEY" in out, false);
  assert.deepEqual(out, { PATH: "/bin", HOME: "/h" });
  assert.equal(env.OPENAI_API_KEY, "sk-x"); // original untouched
});

test("review constructs Codex with an env stripped of API keys (subscription forced)", async () => {
  const { driver, calls } = makeDriver(
    {},
    { OPENAI_API_KEY: "sk-x", CODEX_API_KEY: "ck-y", PATH: "/bin" },
  );
  await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.equal("OPENAI_API_KEY" in calls.env, false);
  assert.equal("CODEX_API_KEY" in calls.env, false);
  assert.equal(calls.env.PATH, "/bin");
});

test("review starts a read-only, no-approval thread with scope + model", async () => {
  const { driver, calls } = makeDriver({});
  await driver.review({
    kind: "review",
    prompt: "p",
    workingDirectory: "/repo",
    skipGitRepoCheck: true,
    model: "gpt-5.5",
  });
  assert.equal(calls.threadOptions.sandboxMode, "read-only");
  assert.equal(calls.threadOptions.approvalPolicy, "never");
  assert.equal(calls.threadOptions.skipGitRepoCheck, true);
  assert.equal(calls.threadOptions.workingDirectory, "/repo");
  assert.equal(calls.threadOptions.model, "gpt-5.5");
});

test("review sends the strict outputSchema for the kind", async () => {
  const { driver, calls } = makeDriver({});
  await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.deepEqual(calls.runTurnOptions.outputSchema, strictOutputSchema("review"));
});

test("review happy path returns validated payload + usage", async () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 5,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
  };
  const { driver } = makeDriver({ finalResponse: JSON.stringify(VALID_REVIEW), usage });
  const result = await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, VALID_REVIEW);
  assert.deepEqual(result.usage, usage);
});

test("review maps an unparseable payload to a CODEX_ERROR envelope (never a verdict)", async () => {
  const { driver } = makeDriver({ finalResponse: "not json{" });
  const result = await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CODEX_ERROR");
});

test("review maps a schema-invalid payload to SCHEMA_INVALID (never a verdict)", async () => {
  const bad = JSON.stringify({ ...VALID_REVIEW, verdict: "lgtm" });
  const { driver } = makeDriver({ finalResponse: bad });
  const result = await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SCHEMA_INVALID");
});

test("review maps a rate-limit throw to RATE_LIMITED with remediation", async () => {
  const { driver } = makeDriver({
    throwError: new Error("Request failed: 429 rate limit exceeded"),
  });
  const result = await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "RATE_LIMITED");
  assert.ok(result.error.remediation);
});

test("review maps an auth failure to AUTH_REQUIRED", async () => {
  const { driver } = makeDriver({
    throwError: new Error("401 Unauthorized: please run codex login"),
  });
  const result = await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTH_REQUIRED");
});

test("review maps an unknown throw to CODEX_ERROR", async () => {
  const { driver } = makeDriver({ throwError: new Error("kaboom") });
  const result = await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CODEX_ERROR");
});
