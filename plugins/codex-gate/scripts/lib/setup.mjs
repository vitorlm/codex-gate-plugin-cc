import { probeAuth } from "./auth.mjs";
import { renderError } from "./render.mjs";

/**
 * @typedef {{
 *   stopReviewGate: boolean,
 *   onUnavailable: string,
 *   maxReviewsPerDay: number,
 *   maxIterations: number,
 *   severityThreshold: string,
 *   reviewModel: string|null,
 * }} GateConfig
 */

/**
 * Read the *effective* stop-gate / quota config from the env the hooks actually
 * consume. This is the honest single-source-of-truth: the user edits the values via
 * `plugin.json` `userConfig` (the `/plugin` settings UI), Claude Code exports them as
 * env to the hooks, and setup reports what those hooks will see — it does NOT persist
 * a parallel config of its own (which would silently diverge from userConfig).
 * @param {Record<string, string|undefined>} [env]
 * @returns {GateConfig}
 */
export function gateConfigFromEnv(env = process.env) {
  return {
    stopReviewGate: env.CODEX_GATE_STOP_REVIEW === "true",
    onUnavailable: env.CODEX_GATE_ON_UNAVAILABLE ?? "allow",
    maxReviewsPerDay: Number(env.CODEX_MAX_REVIEWS_PER_DAY ?? 0),
    maxIterations: Number(env.CODEX_GATE_MAX_ITER ?? 3),
    severityThreshold: env.CODEX_GATE_SEVERITY ?? "blocker",
    reviewModel: env.CODEX_GATE_MODEL ?? null,
  };
}

/** @param {GateConfig} c @returns {string} */
function renderGateConfig(c) {
  const lines = [
    "",
    "Stop review-gate (userConfig → env, edit via /plugin):",
    `  stop-gate:          ${c.stopReviewGate ? "enabled (on)" : "disabled (off)"}`,
    `  on-unavailable:     ${c.onUnavailable}`,
    `  maxReviewsPerDay:   ${c.maxReviewsPerDay === 0 ? "0 (no cap)" : c.maxReviewsPerDay}`,
    `  maxIterations:      ${c.maxIterations}`,
    `  severityThreshold:  ${c.severityThreshold}`,
  ];
  return lines.join("\n");
}

/**
 * `/codex-gate:setup` core: run the auth probe, ensure the pinned SDK is present
 * (pre-install when absent), and report the effective stop-gate config. All side
 * effects (`probe`, `ensureSdk`, `readAuthFile`, clock, output) are injected so this
 * is unit-tested without ever touching Codex/network/`~/.codex`.
 * @param {{
 *   probe: () => Promise<unknown>,
 *   ensureSdk: () => Promise<{ ok: true, installed: boolean } | { ok: false, error: { code: string, message: string, remediation?: string } }>,
 *   readAuthFile?: () => boolean,
 *   config: GateConfig,
 *   write: (s: string) => void,
 * }} deps
 * @returns {Promise<number>} exit code (0 ok / throttled; 1 needs user action)
 */
export async function runSetup({ probe, ensureSdk, readAuthFile, config, write }) {
  const out = (/** @type {string} */ s) => write(`${s}\n`);

  // 1. SDK presence + pre-install (explicit, per §5.4).
  const sdk = await ensureSdk();
  if (!sdk.ok) {
    out(renderError(sdk.error));
    out(renderGateConfig(config));
    return 1;
  }
  out(`Codex SDK: ${sdk.installed ? "installed (pinned) just now" : "present"}.`);

  // 2. Auth probe (authoritative auth-vs-throttled distinction, §6.3).
  const auth = await probeAuth({ probe, readAuthFile });
  let code = 0;
  switch (auth.state) {
    case "OK":
      out("Auth: authenticated — a probe call to Codex succeeded.");
      break;
    case "AUTH_REQUIRED":
      out("Auth: NOT authenticated.");
      out(`  → ${auth.remediation ?? "Run `codex login` to authenticate."}`);
      code = 1;
      break;
    case "RATE_LIMITED":
      // Load-bearing (§6.3): authenticated but throttled — never "not logged in".
      out("Auth: authenticated but RATE_LIMITED (throttled, not an auth problem).");
      out(`  → ${auth.remediation ?? "Wait for the cooldown, then retry."}`);
      break;
    default:
      out(`Auth: probe failed (${auth.state}): ${auth.message ?? "unknown error"}.`);
      if (auth.remediation) out(`  → ${auth.remediation}`);
      code = 1;
  }
  if (auth.authFilePresent === false && auth.state !== "AUTH_REQUIRED") {
    out("  (note: ~/.codex/auth.json not found, but the probe is authoritative.)");
  }

  // 3. Effective stop-gate config (the env the hooks read).
  out(renderGateConfig(config));
  return code;
}
