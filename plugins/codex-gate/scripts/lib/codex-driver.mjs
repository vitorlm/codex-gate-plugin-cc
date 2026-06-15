import { Codex } from "@openai/codex-sdk";
import { createSdkDriver } from "./codex-sdk-driver.mjs";
import { strictOutputSchema, validate } from "./review-schema.mjs";

/**
 * Thin seam over the single SDK implementation (no fallback transport — OD-5).
 * Wires the real `Codex`, validator, and strict schemas by default; any of these
 * can be overridden (used by tests). Retained as a one-file swap point for a
 * hypothetical future transport.
 * @param {Partial<Parameters<typeof createSdkDriver>[0]>} [overrides]
 */
export function createDriver(overrides = {}) {
  return createSdkDriver({
    CodexClass: Codex,
    validate,
    strictOutputSchema,
    ...overrides,
  });
}
