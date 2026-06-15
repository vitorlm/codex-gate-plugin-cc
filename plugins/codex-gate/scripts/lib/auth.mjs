import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyError } from "./codex-sdk-driver.mjs";

/**
 * @typedef {"OK"|"AUTH_REQUIRED"|"RATE_LIMITED"|"MODEL_UNAVAILABLE"|"TIMEOUT"|"CODEX_ERROR"} AuthState
 * @typedef {{ state: AuthState, message?: string, remediation?: string, authFilePresent?: boolean }} AuthProbeResult
 */

/**
 * Cheap, non-authoritative presence check of the cached `codex login` credential
 * (`~/.codex/auth.json`). A *hint* only — gemini's anti-pattern (§3) was deciding
 * auth state from this file; here the probe error classification is authoritative
 * and this is surfaced merely as context. Injectable for tests.
 * @returns {boolean}
 */
export function authFileExists() {
  return existsSync(join(homedir(), ".codex", "auth.json"));
}

/**
 * Classify the Codex auth state by running a minimal injected `probe`. The load-bearing
 * distinction (§6.3): a throttled probe is `RATE_LIMITED` (authenticated-but-throttled)
 * and MUST NOT be reported as "not logged in" — only a 401/login error yields
 * `AUTH_REQUIRED`. The probe may either (a) resolve with the driver's own structured
 * `{ ok:false, error }` envelope (re-used directly, not re-classified), (b) resolve
 * otherwise → `OK`, or (c) throw → mapped through `classifyError` (§8). The fs pre-check
 * is a best-effort hint and never decides the state.
 * @param {{
 *   probe: () => Promise<unknown>,
 *   readAuthFile?: () => boolean,
 * }} deps
 * @returns {Promise<AuthProbeResult>}
 */
export async function probeAuth({ probe, readAuthFile }) {
  let authFilePresent;
  if (readAuthFile) {
    try {
      authFilePresent = readAuthFile();
    } catch {
      authFilePresent = undefined; // hint is best-effort; never fail the probe on it
    }
  }

  try {
    const result = /** @type {any} */ (await probe());
    if (result && result.ok === false && result.error) {
      const e = result.error;
      return { state: e.code, message: e.message, remediation: e.remediation, authFilePresent };
    }
    return { state: "OK", authFilePresent };
  } catch (err) {
    const envelope = classifyError(err);
    return {
      state: /** @type {AuthState} */ (envelope.code),
      message: envelope.message,
      remediation: envelope.remediation,
      authFilePresent,
    };
  }
}
