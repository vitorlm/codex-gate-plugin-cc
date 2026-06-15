import assert from "node:assert/strict";
import { test } from "node:test";
import { runReview } from "./pipeline.mjs";

const SCOPE = { mode: "files", targets: ["a.js"], root: "/repo", git: true, coverage: "explicit" };
const PAYLOAD = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };

function baseDeps(over = {}) {
  const calls = { reviewArgs: null, composeArgs: null, onSuccess: 0, onRateLimit: 0 };
  const deps = {
    resolveScope: () => ({ ok: true, scope: SCOPE }),
    composePrompt: (a) => {
      calls.composeArgs = a;
      return "PROMPT";
    },
    resolveModel: (m) => m ?? "gpt-5.5",
    review: async (a) => {
      calls.reviewArgs = a;
      return { ok: true, payload: PAYLOAD, usage: { output_tokens: 5 } };
    },
    quota: {
      check: () => ({ ok: true }),
      onSuccess: () => {
        calls.onSuccess++;
      },
      onRateLimit: () => {
        calls.onRateLimit++;
      },
    },
    ...over,
  };
  return { deps, calls };
}

const argsOf = (o = {}) => ({
  files: [],
  session: false,
  base: null,
  text: null,
  model: null,
  focus: null,
  ...o,
});

test("a tripped quota guard short-circuits before any review", async () => {
  const { deps, calls } = baseDeps({
    quota: {
      check: () => ({ ok: false, error: { code: "QUOTA_GUARD", message: "cap" } }),
      onSuccess() {},
      onRateLimit() {},
    },
  });
  const r = await runReview(
    { kind: "review", args: argsOf({ files: ["a.js"] }), cwd: "/repo" },
    deps,
  );
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "QUOTA_GUARD");
  assert.equal(calls.reviewArgs, null);
});

test("a NO_SCOPE resolution is returned and no review runs", async () => {
  const { deps, calls } = baseDeps({
    resolveScope: () => ({ ok: false, error: { code: "NO_SCOPE", message: "x" } }),
  });
  const r = await runReview({ kind: "review", args: argsOf(), cwd: "/x" }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "NO_SCOPE");
  assert.equal(calls.reviewArgs, null);
});

test("happy path reviews with composed prompt, resolved model, and inverted skipGitRepoCheck", async () => {
  const { deps, calls } = baseDeps();
  const r = await runReview(
    { kind: "review", args: argsOf({ files: ["a.js"], model: "mini" }), cwd: "/repo" },
    deps,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, PAYLOAD);
  assert.equal(r.scope, SCOPE);
  assert.equal(calls.reviewArgs.prompt, "PROMPT");
  assert.equal(calls.reviewArgs.model, "mini");
  assert.equal(calls.reviewArgs.workingDirectory, "/repo");
  assert.equal(calls.reviewArgs.skipGitRepoCheck, false); // scope.git === true
  assert.equal(calls.onSuccess, 1);
});

test("a non-Git scope sets skipGitRepoCheck true", async () => {
  const { deps, calls } = baseDeps({
    resolveScope: () => ({ ok: true, scope: { ...SCOPE, git: false } }),
  });
  await runReview({ kind: "review", args: argsOf({ text: "x" }), cwd: "/x" }, deps);
  assert.equal(calls.reviewArgs.skipGitRepoCheck, true);
});

test("a RATE_LIMITED driver error is recorded for backoff", async () => {
  const { deps, calls } = baseDeps({
    review: async () => ({ ok: false, error: { code: "RATE_LIMITED", message: "429" } }),
  });
  const r = await runReview(
    { kind: "review", args: argsOf({ files: ["a.js"] }), cwd: "/repo" },
    deps,
  );
  assert.equal(r.ok, false);
  assert.equal(calls.onRateLimit, 1);
  assert.equal(calls.onSuccess, 0);
});

test("a non-rate-limit driver error is returned without backoff accounting", async () => {
  const { deps, calls } = baseDeps({
    review: async () => ({ ok: false, error: { code: "CODEX_ERROR", message: "boom" } }),
  });
  const r = await runReview(
    { kind: "review", args: argsOf({ files: ["a.js"] }), cwd: "/repo" },
    deps,
  );
  assert.equal(r.error.code, "CODEX_ERROR");
  assert.equal(calls.onRateLimit, 0);
});

test("adversarial kind forwards the focus to prompt composition", async () => {
  const { deps, calls } = baseDeps();
  await runReview(
    { kind: "adversarial", args: argsOf({ text: "design", focus: "the budget" }), cwd: "/x" },
    deps,
  );
  assert.equal(calls.composeArgs.kind, "adversarial");
  assert.equal(calls.composeArgs.focus, "the budget");
});
