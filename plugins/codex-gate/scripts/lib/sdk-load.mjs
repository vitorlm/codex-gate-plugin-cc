import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Load a package's ESM entry from `${dataDir}/node_modules/<pkgName>`. Runtime
 * deps are installed lazily into `${CLAUDE_PLUGIN_DATA}` (§5.4), which is NOT on
 * this file's module-resolution path — so we resolve the entry from the package's
 * `package.json` and dynamic-`import()` it by absolute file URL. Falls back to the
 * bare specifier for dev (the dep resolves from the repo's node_modules).
 * @param {string|null} dataDir
 * @param {string} pkgName
 * @returns {Promise<any>} the imported module namespace
 */
export async function loadDep(dataDir, pkgName) {
  if (dataDir) {
    const pkgDir = join(dataDir, "node_modules", ...pkgName.split("/"));
    const pkgJson = join(pkgDir, "package.json");
    if (existsSync(pkgJson)) {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      const rel = pkg?.exports?.["."]?.import ?? pkg?.module ?? pkg?.main ?? "index.js";
      const entry = pathToFileURL(join(pkgDir, rel)).href;
      return import(entry);
    }
  }
  return import(pkgName); // dev fallback (bare specifier)
}

/**
 * Load the `Codex` class from `@openai/codex-sdk` (lazily, from the data dir).
 * @param {string|null} [dataDir]
 * @returns {Promise<any>} the Codex class
 */
export async function loadCodex(dataDir) {
  const m = await loadDep(dataDir ?? null, "@openai/codex-sdk");
  return m.Codex;
}

/**
 * Load the `Ajv` class from `ajv` (lazily, from the data dir). ajv@8 is CJS, so
 * the named `Ajv` export may be absent under some interops — fall back to default.
 * @param {string|null} [dataDir]
 * @returns {Promise<any>} the Ajv class
 */
export async function loadAjv(dataDir) {
  const m = await loadDep(dataDir ?? null, "ajv");
  return m.Ajv ?? m.default;
}
