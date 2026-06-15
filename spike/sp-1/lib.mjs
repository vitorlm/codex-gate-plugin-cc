import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Ajv from "ajv";

export const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Build an env that forces the ChatGPT subscription auth path:
 * actively STRIP any inherited OpenAI API key. The spec says the companion
 * "never sets" API-key vars — but if the user already exports one (common),
 * not-setting is not enough; codex would prefer it. We must remove it.
 */
export function subscriptionEnv() {
  const env = { ...process.env };
  const stripped = [];
  for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY"]) {
    if (env[k]) {
      delete env[k];
      stripped.push(k);
    }
  }
  return { env, stripped };
}

export function loadSchema(name) {
  return JSON.parse(readFileSync(resolve(HERE, "schemas", name), "utf8"));
}

export function strictValidator(schema) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

export const REVIEW_PROMPT = [
  "You are a code reviewer. Read the file fixtures/cart.js in the working directory",
  "and review it for correctness, security, concurrency, and data-integrity defects.",
  "Respond ONLY with the structured output matching the provided schema.",
  "Use one finding per distinct defect. Set `category` to a short, stable, lowercase",
  "machine identifier for the defect class (e.g. correctness, security, concurrency).",
].join(" ");

export function classifyError(err) {
  const msg = String(err?.message ?? err ?? "");
  const low = msg.toLowerCase();
  if (low.includes("rate limit") || low.includes("429") || low.includes("too many"))
    return "RATE_LIMITED";
  if (low.includes("quota") || low.includes("usage limit")) return "QUOTA";
  if (low.includes("login") || low.includes("auth") || low.includes("401") || low.includes("unauthorized"))
    return "AUTH_REQUIRED";
  if (low.includes("model") && (low.includes("not found") || low.includes("unavailable")))
    return "MODEL_UNAVAILABLE";
  return "CODEX_ERROR";
}

/**
 * Tolerant normalization (spec §5.6/§9): OpenAI strict output forces every
 * optional field to be present-but-nullable. Strip null-valued keys so the
 * richer internal draft-07 schema (optional fields) validates cleanly.
 */
export function dropNulls(value) {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = dropNulls(v);
    }
    return out;
  }
  return value;
}

export function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    // Codex sometimes wraps JSON in a fenced block; try to salvage.
    const m = text && text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return { ok: true, value: JSON.parse(m[0]), salvaged: true };
      } catch {
        /* fall through */
      }
    }
    return { ok: false, error: String(e?.message ?? e) };
  }
}
