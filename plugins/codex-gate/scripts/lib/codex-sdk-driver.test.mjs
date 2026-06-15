import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeEvents, createSdkDriver, formatEvent, stripApiKeys } from "./codex-sdk-driver.mjs";
import { strictOutputSchema, validate } from "./review-schema.mjs";

const VALID_REVIEW = {
  verdict: "approve",
  summary: "Looks fine.",
  findings: [],
  next_steps: [],
};

/** No-op timers so heartbeat/timeout never fire real wall-clock callbacks in tests. */
const NOOP_TIMERS = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
};

/** Turn an array of events into the `{ events }` async-generator shape the SDK returns. */
async function* toAsyncGen(arr) {
  for (const e of arr) yield e;
}

/** Default event stream: a single final agent_message carrying the structured JSON. */
function defaultEvents(behavior) {
  const finalResponse = behavior.finalResponse ?? JSON.stringify(VALID_REVIEW);
  return [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "a1", type: "agent_message", text: finalResponse } },
    { type: "turn.completed", usage: behavior.usage ?? null },
  ];
}

/**
 * Build a fake Codex class that records how it was constructed/called and streams events.
 * @param {{ finalResponse?: string, usage?: object|null, throwError?: Error, events?: any[], abortThrows?: boolean }} behavior
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
        async runStreamed(input, turnOptions) {
          calls.runInput = input;
          calls.runTurnOptions = turnOptions;
          if (behavior.abortThrows && turnOptions?.signal?.aborted) {
            throw new Error("The operation was aborted");
          }
          if (behavior.throwError) throw behavior.throwError;
          return { events: toAsyncGen(behavior.events ?? defaultEvents(behavior)) };
        },
      };
    }
  }
  return { FakeCodex, calls };
}

function makeDriver(behavior, opts = {}) {
  const { FakeCodex, calls } = fakeCodex(behavior);
  const progress = [];
  const driver = createSdkDriver({
    getCodex: async () => FakeCodex,
    env: opts.env ?? { PATH: "/usr/bin" },
    validate,
    strictOutputSchema,
    onProgress: (line) => progress.push(line),
    timers: opts.timers ?? NOOP_TIMERS,
    timeoutMs: opts.timeoutMs ?? 300_000,
    heartbeatMs: opts.heartbeatMs ?? 0,
  });
  return { driver, calls, progress };
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
    { env: { OPENAI_API_KEY: "sk-x", CODEX_API_KEY: "ck-y", PATH: "/bin" } },
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

test("review streams the strict outputSchema + an AbortSignal for the kind", async () => {
  const { driver, calls } = makeDriver({});
  await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.deepEqual(calls.runTurnOptions.outputSchema, strictOutputSchema("review"));
  assert.ok(calls.runTurnOptions.signal, "a signal must be passed for cancellation/timeout");
});

test("review happy path returns validated payload + usage (reconstructed from events)", async () => {
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

test("review emits human-readable progress lines as Codex works", async () => {
  const events = [
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: "c1",
        type: "command_execution",
        command: "git show HEAD",
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "git show HEAD",
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: { id: "a1", type: "agent_message", text: JSON.stringify(VALID_REVIEW) },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  ];
  const { driver, progress } = makeDriver({ events });
  await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  const joined = progress.join("\n");
  assert.match(joined, /git show HEAD/);
  assert.match(joined, /Codex/);
  assert.ok(progress.length >= 2, "expected multiple progress lines");
});

test("review maps a timeout (abort) to a TIMEOUT envelope (never a verdict)", async () => {
  // setTimeout fires its callback synchronously → aborts before runStreamed resolves.
  const timers = {
    setTimeout: (cb) => {
      cb();
      return 1;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const { driver } = makeDriver({ abortThrows: true }, { timers, timeoutMs: 1 });
  const result = await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TIMEOUT");
  assert.ok(result.error.remediation);
});

test("review clears its timeout/heartbeat timers on the happy path", async () => {
  const cleared = { timeout: 0, interval: 0 };
  const timers = {
    setTimeout: () => 42,
    clearTimeout: () => {
      cleared.timeout++;
    },
    setInterval: () => 7,
    clearInterval: () => {
      cleared.interval++;
    },
  };
  const { driver } = makeDriver({}, { timers, heartbeatMs: 15_000 });
  await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.equal(cleared.timeout, 1);
  assert.equal(cleared.interval, 1);
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

test("review surfaces a turn.failed event as a CODEX_ERROR (not a verdict)", async () => {
  const events = [
    { type: "turn.started" },
    { type: "turn.failed", error: { message: "model exploded" } },
  ];
  const { driver } = makeDriver({ events });
  const result = await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CODEX_ERROR");
  assert.match(result.error.message, /model exploded/);
});

// --- consumeEvents (pure reconstruction) ---

test("consumeEvents reconstructs items, last agent_message as finalResponse, and usage", async () => {
  const usage = {
    input_tokens: 9,
    output_tokens: 1,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
  };
  const events = [
    { type: "turn.started" },
    { type: "item.completed", item: { id: "a0", type: "agent_message", text: "first" } },
    {
      type: "item.completed",
      item: { id: "c1", type: "command_execution", command: "ls", status: "completed" },
    },
    { type: "item.completed", item: { id: "a1", type: "agent_message", text: "final" } },
    { type: "turn.completed", usage },
  ];
  const turn = await consumeEvents(toAsyncGen(events), () => {});
  assert.equal(turn.finalResponse, "final");
  assert.deepEqual(turn.usage, usage);
  assert.equal(turn.items.length, 3);
});

test("consumeEvents throws on a stream-level error event", async () => {
  const events = [{ type: "turn.started" }, { type: "error", message: "stream died" }];
  await assert.rejects(() => consumeEvents(toAsyncGen(events), () => {}), /stream died/);
});

// --- formatEvent (pure rendering) ---

test("formatEvent renders command starts, completions, and is quiet on noise", () => {
  assert.equal(
    formatEvent({ type: "item.started", item: { type: "command_execution", command: "git diff" } }),
    "  $ git diff",
  );
  assert.match(
    formatEvent({
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cached_input_tokens: 0,
        reasoning_output_tokens: 1,
      },
    }),
    /10\/2\/1/,
  );
  // agent_message carries the final JSON — noise on the wire.
  assert.equal(
    formatEvent({ type: "item.completed", item: { type: "agent_message", text: "{...}" } }),
    null,
  );
  // item.updated is intermediate churn.
  assert.equal(formatEvent({ type: "item.updated", item: { type: "reasoning", text: "x" } }), null);
  assert.equal(formatEvent({ type: "thread.started", thread_id: "t" }), null);
});

test("formatEvent surfaces web search, reasoning, and command failures", () => {
  assert.match(
    formatEvent({ type: "item.completed", item: { type: "web_search", query: "race condition" } }),
    /race condition/,
  );
  assert.match(
    formatEvent({
      type: "item.completed",
      item: { type: "reasoning", text: "thinking hard\nmore" },
    }),
    /thinking hard/,
  );
  assert.match(
    formatEvent({
      type: "item.completed",
      item: { type: "command_execution", command: "false", exit_code: 1, status: "failed" },
    }),
    /1/,
  );
});
