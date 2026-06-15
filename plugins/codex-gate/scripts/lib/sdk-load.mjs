import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Load the `Codex` class from `@openai/codex-sdk`. The SDK is installed lazily
 * into `${CLAUDE_PLUGIN_DATA}/node_modules` (§5.4), which is NOT on this file's
 * module-resolution path — so we resolve and dynamic-`import()` it by absolute
 * file URL. Falls back to the bare specifier for dev (SDK in the repo's node_modules).
 * @param {string|null} [dataDir]
 * @returns {Promise<any>} the Codex class
 */
export async function loadCodex(dataDir) {
  if (dataDir) {
    const pkgDir = join(dataDir, "node_modules", "@openai", "codex-sdk");
    const pkgJson = join(pkgDir, "package.json");
    if (existsSync(pkgJson)) {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      const rel = pkg?.exports?.["."]?.import ?? pkg?.module ?? pkg?.main ?? "dist/index.js";
      const entry = pathToFileURL(join(pkgDir, rel)).href;
      const mod = await import(entry);
      return mod.Codex;
    }
  }
  const mod = await import("@openai/codex-sdk"); // dev fallback (bare specifier)
  return mod.Codex;
}
