/**
 * Quota guard (§6.3): a daily review cap (OFF by default) plus an always-on
 * rate-limit backoff. Pure functions over a plain state object + injected `now`,
 * so persistence (statelock/state) and the clock stay out of the logic.
 *
 * @typedef {{ day?: string, count?: number, rateLimitHits?: number[] }} QuotaState
 */

/** @param {number} now @returns {string} UTC day key */
function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * @param {QuotaState} state
 * @param {{ maxPerDay: number, now: number }} opts
 * @returns {{ ok: true } | { ok: false, error: { code: "QUOTA_GUARD", message: string, remediation: string } }}
 */
export function checkQuota(state, { maxPerDay, now }) {
  if (!maxPerDay || maxPerDay <= 0) return { ok: true };
  const today = dayKey(now);
  const count = state.day === today ? (state.count ?? 0) : 0;
  if (count >= maxPerDay) {
    return {
      ok: false,
      error: {
        code: "QUOTA_GUARD",
        message: `Daily review cap reached (${count}/${maxPerDay}).`,
        remediation:
          "Raise userConfig.maxReviewsPerDay (0 disables the cap) or wait until tomorrow.",
      },
    };
  }
  return { ok: true };
}

/**
 * @param {QuotaState} state
 * @param {{ now: number }} opts
 * @returns {QuotaState}
 */
export function recordReview(state, { now }) {
  const today = dayKey(now);
  if (state.day === today) return { ...state, count: (state.count ?? 0) + 1 };
  return { ...state, day: today, count: 1 };
}

/**
 * @param {QuotaState} state
 * @param {{ now: number }} opts
 * @returns {QuotaState}
 */
export function recordRateLimit(state, { now }) {
  return { ...state, rateLimitHits: [...(state.rateLimitHits ?? []), now] };
}

/**
 * Whether automated calls should be short-circuited: >= `threshold` rate-limit
 * hits within `windowMs`, and still within `cooldownMs` of the latest hit.
 * @param {QuotaState} state
 * @param {{ now: number, windowMs?: number, threshold?: number, cooldownMs?: number }} opts
 * @returns {{ active: boolean, until?: number, message?: string }}
 */
export function rateLimitCooldown(
  state,
  { now, windowMs = 600_000, threshold = 3, cooldownMs = 300_000 },
) {
  const recent = (state.rateLimitHits ?? []).filter((t) => now - t <= windowMs);
  if (recent.length < threshold) return { active: false };
  const until = Math.max(...recent) + cooldownMs;
  if (now >= until) return { active: false };
  return {
    active: true,
    until,
    message: `Rate-limited ${recent.length}x recently; backing off automated reviews until cooldown ends.`,
  };
}
