import assert from "node:assert/strict";
import { test } from "node:test";
import { gateConfigFromEnv, runSetup } from "./setup.mjs";

/** Collect writes into a string. */
function sink() {
  const out = [];
  return { write: (s) => out.push(s), text: () => out.join("") };
}

const okProbe = async () => ({ ok: true });
const authProbe = async () => {
  throw new Error("401 not authenticated");
};
const throttledProbe = async () => {
  throw new Error("429 rate limit");
};

// --- authed -----------------------------------------------------------------

test("runSetup authed + SDK present → reports OK, exit 0, no install", async () => {
  const s = sink();
  let installCalls = 0;
  const code = await runSetup({
    probe: okProbe,
    readAuthFile: () => true,
    ensureSdk: async () => {
      installCalls++;
      return { ok: true, installed: false };
    },
    config: gateConfigFromEnv({}),
    write: s.write,
  });
  assert.equal(code, 0);
  assert.match(s.text(), /authenticated|OK/i);
  assert.match(s.text(), /present/i);
  assert.equal(installCalls, 1); // ensureSdk is idempotent; "present" means no real npm work
});

// --- not authed -------------------------------------------------------------

test("runSetup not-authed → AUTH_REQUIRED remediation, non-zero exit", async () => {
  const s = sink();
  const code = await runSetup({
    probe: authProbe,
    readAuthFile: () => false,
    ensureSdk: async () => ({ ok: true, installed: false }),
    config: gateConfigFromEnv({}),
    write: s.write,
  });
  assert.equal(code, 1);
  assert.match(s.text(), /codex login/);
  assert.match(s.text(), /NOT authenticated/);
});

// --- throttled (load-bearing): NOT reported as not-logged-in ----------------

test("runSetup throttled → RATE_LIMITED, never says 'not logged in'", async () => {
  const s = sink();
  const code = await runSetup({
    probe: throttledProbe,
    readAuthFile: () => true,
    ensureSdk: async () => ({ ok: true, installed: false }),
    config: gateConfigFromEnv({}),
    write: s.write,
  });
  // throttled is still authenticated → not a hard auth failure
  assert.equal(code, 0);
  assert.match(s.text(), /RATE_LIMITED|throttled/i);
  assert.doesNotMatch(s.text(), /codex login/);
});

// --- SDK absent then installed ---------------------------------------------

test("runSetup pre-installs the SDK when absent and reports it", async () => {
  const s = sink();
  let installCalls = 0;
  const code = await runSetup({
    probe: okProbe,
    readAuthFile: () => true,
    ensureSdk: async () => {
      installCalls++;
      return { ok: true, installed: true };
    },
    config: gateConfigFromEnv({}),
    write: s.write,
  });
  assert.equal(code, 0);
  assert.equal(installCalls, 1);
  assert.match(s.text(), /installed/i);
});

test("runSetup reports an SDK install failure without crashing (non-zero exit)", async () => {
  const s = sink();
  const code = await runSetup({
    probe: okProbe,
    readAuthFile: () => true,
    ensureSdk: async () => ({
      ok: false,
      error: { code: "CODEX_ERROR", message: "npm offline", remediation: "check connectivity" },
    }),
    config: gateConfigFromEnv({}),
    write: s.write,
  });
  assert.equal(code, 1);
  assert.match(s.text(), /npm offline/);
});

// --- gate config surfacing --------------------------------------------------

test("runSetup surfaces the effective stop-gate config from env", async () => {
  const s = sink();
  await runSetup({
    probe: okProbe,
    readAuthFile: () => true,
    ensureSdk: async () => ({ ok: true, installed: false }),
    config: gateConfigFromEnv({ CODEX_GATE_STOP_REVIEW: "true", CODEX_MAX_REVIEWS_PER_DAY: "25" }),
    write: s.write,
  });
  const t = s.text();
  assert.match(t, /stop[- ]?gate/i);
  assert.match(t, /enabled|on/i);
  assert.match(t, /25/);
});

// --- gateConfigFromEnv mapping ----------------------------------------------

test("gateConfigFromEnv maps env knobs to a structured view (defaults off)", () => {
  const c = gateConfigFromEnv({});
  assert.equal(c.stopReviewGate, false);
  assert.equal(c.maxReviewsPerDay, 0);
  assert.equal(c.onUnavailable, "allow");
  assert.equal(c.reviewTimeoutMs, 300_000);
});

test("gateConfigFromEnv reads a custom review timeout from env", () => {
  assert.equal(gateConfigFromEnv({ CODEX_GATE_TIMEOUT_MS: "120000" }).reviewTimeoutMs, 120_000);
});

test("gateConfigFromEnv reads enabled gate + cap from env", () => {
  const c = gateConfigFromEnv({
    CODEX_GATE_STOP_REVIEW: "true",
    CODEX_MAX_REVIEWS_PER_DAY: "10",
    CODEX_GATE_ON_UNAVAILABLE: "block",
  });
  assert.equal(c.stopReviewGate, true);
  assert.equal(c.maxReviewsPerDay, 10);
  assert.equal(c.onUnavailable, "block");
});
