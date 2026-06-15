import { createSdkDriver } from "./codex-sdk-driver.mjs";
import { strictOutputSchema, validate as validateSchema } from "./review-schema.mjs";
import { loadCodex } from "./sdk-load.mjs";

/**
 * Thin seam over the single SDK implementation (no fallback transport — OD-5).
 * The `Codex` class is loaded **lazily and dynamically** from the data dir where
 * the SDK is installed (§5.4) — never a static bare import, which would not
 * resolve in a distributed install. A `CodexClass` override (tests) short-circuits
 * the load; `dataDir` defaults to `${CLAUDE_PLUGIN_DATA}`.
 * @param {{ CodexClass?: any, dataDir?: string|null, env?: Record<string, string|undefined>, getCodex?: () => any }} [overrides]
 */
export function createDriver(overrides = {}) {
  const { CodexClass, dataDir, ...rest } = overrides;
  const dir = dataDir ?? process.env.CLAUDE_PLUGIN_DATA ?? null;
  const getCodex =
    overrides.getCodex ?? (CodexClass ? async () => CodexClass : () => loadCodex(dir));
  const validate = (/** @type {any} */ kind, /** @type {unknown} */ payload) =>
    validateSchema(kind, payload, { dataDir: dir });
  return createSdkDriver({ getCodex, validate, strictOutputSchema, ...rest });
}
