import assert from "node:assert/strict";
import { test } from "node:test";
import { probeAuth } from "./auth.mjs";

// A probe that resolves means an authenticated call went through.
test("probeAuth → OK when the injected probe resolves", async () => {
  const r = await probeAuth({ probe: async () => ({ ok: true }) });
  assert.equal(r.state, "OK");
  assert.equal(r.authFilePresent, undefined); // no fs check injected → unknown
});

// A 401/login throw classifies as not-authenticated.
test("probeAuth → AUTH_REQUIRED when the probe throws an auth error", async () => {
  const r = await probeAuth({
    probe: async () => {
      throw new Error("401 Unauthorized: not authenticated");
    },
  });
  assert.equal(r.state, "AUTH_REQUIRED");
  assert.match(r.remediation, /codex login/);
});

// Load-bearing distinction (§6.3): a throttled probe is AUTHENTICATED, not "not logged in".
test("probeAuth → RATE_LIMITED on a 429, never reported as not-authenticated", async () => {
  const r = await probeAuth({
    probe: async () => {
      throw new Error("429 Too Many Requests");
    },
  });
  assert.equal(r.state, "RATE_LIMITED");
  assert.doesNotMatch(r.remediation ?? "", /codex login/);
});

// Any other transport failure maps through classifyError, never to OK.
test("probeAuth → CODEX_ERROR on an unclassified throw", async () => {
  const r = await probeAuth({
    probe: async () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal(r.state, "CODEX_ERROR");
});

// The fs pre-check is a cheap hint only — it is surfaced but does NOT decide the state.
test("probeAuth surfaces authFilePresent hint but the probe remains authoritative", async () => {
  // file absent yet the probe still succeeds (e.g. env-token path) → OK wins over the hint
  const r = await probeAuth({
    probe: async () => ({ ok: true }),
    readAuthFile: () => false,
  });
  assert.equal(r.state, "OK");
  assert.equal(r.authFilePresent, false);
});

test("probeAuth reports authFilePresent=true when the auth file reader returns truthy", async () => {
  const r = await probeAuth({
    probe: async () => {
      throw new Error("429 rate limit");
    },
    readAuthFile: () => true,
  });
  assert.equal(r.state, "RATE_LIMITED");
  assert.equal(r.authFilePresent, true);
});

// A reader that throws must not crash the probe (fs hint is best-effort).
test("probeAuth tolerates a throwing auth-file reader (hint best-effort)", async () => {
  const r = await probeAuth({
    probe: async () => ({ ok: true }),
    readAuthFile: () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(r.state, "OK");
  assert.equal(r.authFilePresent, undefined);
});

// The real probe is the driver, which returns a structured {ok:false,error} envelope
// rather than throwing — probeAuth must re-use it directly, not re-classify.
test("probeAuth reuses a driver-style {ok:false,error} envelope without re-classifying", async () => {
  const r = await probeAuth({
    probe: async () => ({
      ok: false,
      error: { code: "AUTH_REQUIRED", message: "401", remediation: "run `codex login`" },
    }),
  });
  assert.equal(r.state, "AUTH_REQUIRED");
  assert.equal(r.remediation, "run `codex login`");
});

test("probeAuth treats a driver {ok:true} result as OK", async () => {
  const r = await probeAuth({ probe: async () => ({ ok: true, payload: {} }) });
  assert.equal(r.state, "OK");
});

// authFilePresent default reader (no injection) returns a boolean against the real path,
// but we never let it run live in tests — covered by injecting readAuthFile above.
