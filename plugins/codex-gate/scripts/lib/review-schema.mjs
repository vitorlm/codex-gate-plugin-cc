import { readFileSync } from "node:fs";
import { loadAjv } from "./sdk-load.mjs";

const SCHEMA_DIR = new URL("../../schemas/", import.meta.url);

/** @param {string} name */
function load(name) {
  return JSON.parse(readFileSync(new URL(name, SCHEMA_DIR), "utf8"));
}

const INTERNAL = {
  review: load("review-output.schema.json"),
  adversarial: load("adversarial-output.schema.json"),
};

const STRICT = {
  review: load("codex-output.review.strict.json"),
  adversarial: load("codex-output.adversarial.strict.json"),
};

/**
 * Recursively remove null-valued object keys (non-mutating). The OpenAI strict
 * outputSchema forces optional fields to be present-but-nullable; stripping the
 * nulls lets the richer internal draft-07 schema (genuine optionals) validate.
 * @param {unknown} value
 * @returns {unknown}
 */
export function dropNulls(value) {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = dropNulls(v);
    }
    return out;
  }
  return value;
}

/**
 * Compiled validators, memoized per data dir. ajv is loaded lazily and
 * dynamically (§5.6) — it lives in `${CLAUDE_PLUGIN_DATA}/node_modules` in a
 * distributed install, not on this file's static resolution path.
 * @type {Map<string, Promise<{ review: (v: unknown) => boolean, adversarial: (v: unknown) => boolean }>>}
 */
const validatorsByDir = new Map();

/**
 * @param {string|null} dataDir
 * @returns {Promise<{ review: (v: unknown) => boolean, adversarial: (v: unknown) => boolean }>}
 */
function getValidators(dataDir) {
  const key = dataDir ?? "";
  let compiled = validatorsByDir.get(key);
  if (!compiled) {
    compiled = (async () => {
      const Ajv = await loadAjv(dataDir);
      // Tolerant normalization: strip unknown keys (additionalProperties:false)
      // and coerce obvious type deviations, instead of hard-failing on verbosity.
      const ajv = new Ajv({ allErrors: true, removeAdditional: true, coerceTypes: true });
      return {
        review: ajv.compile(INTERNAL.review),
        adversarial: ajv.compile(INTERNAL.adversarial),
      };
    })();
    validatorsByDir.set(key, compiled);
  }
  return compiled;
}

/**
 * Normalize then validate a Codex payload against the internal draft-07 schema.
 * ajv is loaded lazily from `opts.dataDir` (the data dir where it is installed;
 * null → dev bare-specifier fallback).
 * @param {"review"|"adversarial"} kind
 * @param {unknown} payload
 * @param {{ dataDir?: string|null }} [opts]
 * @returns {Promise<{ok: true, value: unknown} | {ok: false, code: "SCHEMA_INVALID", errors: unknown}>}
 */
export async function validate(kind, payload, opts = {}) {
  if (kind !== "review" && kind !== "adversarial") {
    throw new Error(`unknown schema kind: ${kind}`);
  }
  const dataDir = opts.dataDir ?? process.env.CLAUDE_PLUGIN_DATA ?? null;
  const validators = await getValidators(dataDir);
  const fn = validators[kind];
  const value = dropNulls(payload);
  if (!fn(value))
    return { ok: false, code: "SCHEMA_INVALID", errors: /** @type {any} */ (fn).errors };
  return { ok: true, value };
}

/**
 * The OpenAI-strict schema to send to Codex as `outputSchema` for this kind.
 * @param {"review"|"adversarial"} kind
 * @returns {object}
 */
export function strictOutputSchema(kind) {
  const schema = STRICT[kind];
  if (!schema) throw new Error(`unknown schema kind: ${kind}`);
  return schema;
}
