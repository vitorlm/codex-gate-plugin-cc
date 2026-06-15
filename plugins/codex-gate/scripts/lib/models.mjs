export const DEFAULT_MODEL = "gpt-5.5";

/** Short aliases resolved to canonical model ids. @type {Record<string, string>} */
const ALIASES = {
  default: DEFAULT_MODEL,
  mini: "gpt-5.4-mini",
};

/**
 * Resolve a model alias / explicit id to a canonical model id.
 * @param {string|null} [input]
 * @returns {string}
 */
export function resolveModel(input) {
  if (!input) return DEFAULT_MODEL;
  return ALIASES[input] ?? input;
}
