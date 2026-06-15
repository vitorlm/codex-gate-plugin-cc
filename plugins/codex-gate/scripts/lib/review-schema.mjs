import { readFileSync } from "node:fs";
import { Ajv } from "ajv";

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

// Tolerant normalization: strip unknown keys (additionalProperties:false) and
// coerce obvious type deviations, instead of hard-failing on model verbosity.
const ajv = new Ajv({ allErrors: true, removeAdditional: true, coerceTypes: true });
const validators = {
  review: ajv.compile(INTERNAL.review),
  adversarial: ajv.compile(INTERNAL.adversarial),
};

/**
 * Normalize then validate a Codex payload against the internal draft-07 schema.
 * @param {"review"|"adversarial"} kind
 * @param {unknown} payload
 * @returns {{ok: true, value: unknown} | {ok: false, code: "SCHEMA_INVALID", errors: unknown}}
 */
export function validate(kind, payload) {
  const fn = validators[kind];
  if (!fn) throw new Error(`unknown schema kind: ${kind}`);
  const value = dropNulls(payload);
  if (!fn(value)) return { ok: false, code: "SCHEMA_INVALID", errors: fn.errors };
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
