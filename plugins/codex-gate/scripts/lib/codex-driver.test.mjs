import assert from "node:assert/strict";
import { test } from "node:test";
import { createDriver } from "./codex-driver.mjs";

test("createDriver returns a driver exposing review()", () => {
  const driver = createDriver();
  assert.equal(typeof driver.review, "function");
});

test("createDriver wires the default validate + strictOutputSchema (CodexClass overridable)", async () => {
  const VALID = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };
  let sentSchema = null;
  async function* events(finalResponse) {
    yield {
      type: "item.completed",
      item: { id: "a1", type: "agent_message", text: finalResponse },
    };
    yield { type: "turn.completed", usage: null };
  }
  class FakeCodex {
    startThread() {
      return {
        async runStreamed(_input, turnOptions) {
          sentSchema = turnOptions.outputSchema;
          return { events: events(JSON.stringify(VALID)) };
        },
      };
    }
  }
  // Disable heartbeat/timeout real timers in this integration test.
  const driver = createDriver({ CodexClass: FakeCodex, heartbeatMs: 0, onProgress: () => {} });
  const result = await driver.review({ kind: "review", prompt: "p", workingDirectory: "/repo" });
  // Default strictOutputSchema was wired in (the review strict schema has a closed category enum).
  assert.equal(
    sentSchema.properties.findings.items.properties.category.enum.includes("security"),
    true,
  );
  // Default validate was wired in.
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, VALID);
});
