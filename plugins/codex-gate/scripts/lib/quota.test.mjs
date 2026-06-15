import assert from "node:assert/strict";
import { test } from "node:test";
import { checkQuota, rateLimitCooldown, recordRateLimit, recordReview } from "./quota.mjs";

const DAY = 86_400_000;

test("checkQuota with maxPerDay=0 never trips (cap off)", () => {
  const state = { day: "1970-01-01", count: 999 };
  assert.equal(checkQuota(state, { maxPerDay: 0, now: 0 }).ok, true);
});

test("checkQuota trips QUOTA_GUARD once today's count reaches the cap", () => {
  const state = { day: "1970-01-01", count: 2 };
  const r = checkQuota(state, { maxPerDay: 2, now: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "QUOTA_GUARD");
  assert.ok(r.error.remediation);
});

test("checkQuota ignores a count from a previous day (daily reset)", () => {
  const state = { day: "1970-01-01", count: 5 };
  assert.equal(checkQuota(state, { maxPerDay: 2, now: DAY }).ok, true); // next day
});

test("recordReview increments same-day and rolls over on a new day", () => {
  const s0 = { day: "1970-01-01", count: 1 };
  const s1 = recordReview(s0, { now: 0 });
  assert.deepEqual(s1, { day: "1970-01-01", count: 2 });
  const s2 = recordReview(s1, { now: DAY });
  assert.deepEqual(s2, { day: "1970-01-02", count: 1 });
});

test("rateLimitCooldown is inactive below the hit threshold", () => {
  let state = { rateLimitHits: [] };
  state = recordRateLimit(state, { now: 1000 });
  state = recordRateLimit(state, { now: 2000 });
  const r = rateLimitCooldown(state, {
    now: 2500,
    threshold: 3,
    windowMs: 10000,
    cooldownMs: 5000,
  });
  assert.equal(r.active, false);
});

test("rateLimitCooldown activates at/above threshold within the window and reports until", () => {
  let state = { rateLimitHits: [] };
  for (const t of [1000, 2000, 3000]) state = recordRateLimit(state, { now: t });
  const r = rateLimitCooldown(state, {
    now: 3500,
    threshold: 3,
    windowMs: 10000,
    cooldownMs: 5000,
  });
  assert.equal(r.active, true);
  assert.equal(r.until, 3000 + 5000); // last hit + cooldown
});

test("rateLimitCooldown expires after the cooldown elapses", () => {
  let state = { rateLimitHits: [] };
  for (const t of [1000, 2000, 3000]) state = recordRateLimit(state, { now: t });
  const r = rateLimitCooldown(state, {
    now: 3000 + 5000 + 1,
    threshold: 3,
    windowMs: 100000,
    cooldownMs: 5000,
  });
  assert.equal(r.active, false);
});

test("hits older than the window do not count toward the threshold", () => {
  let state = { rateLimitHits: [] };
  state = recordRateLimit(state, { now: 1000 }); // old
  state = recordRateLimit(state, { now: 2000 }); // old
  state = recordRateLimit(state, { now: 50000 }); // recent
  const r = rateLimitCooldown(state, {
    now: 50500,
    threshold: 3,
    windowMs: 10000,
    cooldownMs: 5000,
  });
  assert.equal(r.active, false); // only 1 hit within the 10s window
});
