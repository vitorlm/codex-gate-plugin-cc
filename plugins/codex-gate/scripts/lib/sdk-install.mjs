import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Whether the pinned `@openai/codex-sdk` is already installed under the plugin
 * data dir (a cheap stat — safe inside the 5s SessionStart hook; §5.4).
 * @param {string} dataDir
 * @returns {boolean}
 */
export function sdkInstalled(dataDir) {
  return existsSync(join(dataDir, "node_modules", "@openai", "codex-sdk", "package.json"));
}

/**
 * Lazily + idempotently ensure the SDK is installed (on first review, NOT in the
 * SessionStart hook — an npm install cannot reliably finish in 5s; §5.4). The
 * `install` side-effect is injected so the decision logic stays unit-testable.
 * @param {string} dataDir
 * @param {{ installed?: () => boolean, install: () => Promise<void> }} deps
 * @returns {Promise<{ ok: true, installed: boolean } | { ok: false, error: { code: string, message: string, remediation: string } }>}
 */
export async function ensureSdk(dataDir, { installed = () => sdkInstalled(dataDir), install }) {
  if (installed()) return { ok: true, installed: false };
  try {
    await install();
    return { ok: true, installed: true };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "CODEX_ERROR",
        message: `Failed to install @openai/codex-sdk: ${err instanceof Error ? err.message : String(err)}`,
        remediation:
          "Run /codex-gate:setup to pre-install the Codex SDK, or check npm connectivity.",
      },
    };
  }
}
