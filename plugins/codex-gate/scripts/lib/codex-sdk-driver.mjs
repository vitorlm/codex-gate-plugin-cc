/**
 * @typedef {{ code: string, message: string, remediation?: string }} ErrorEnvelope
 * @typedef {{ ok: true, payload: unknown, usage: object|null } | { ok: false, error: ErrorEnvelope }} ReviewResult
 */

/**
 * Force the ChatGPT subscription login: actively strip any inherited OpenAI/Codex
 * API key (SP-1 §6.3 — "not setting" is insufficient when the user's shell exports one).
 * Non-mutating.
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, string|undefined>}
 */
export function stripApiKeys(env) {
  const out = { ...env };
  delete out.OPENAI_API_KEY;
  delete out.CODEX_API_KEY;
  return out;
}

/**
 * Map a thrown SDK/transport error to a structured §8 envelope.
 * @param {unknown} err
 * @returns {ErrorEnvelope}
 */
export function classifyError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const low = message.toLowerCase();
  if (low.includes("429") || low.includes("rate limit") || low.includes("too many requests")) {
    return {
      code: "RATE_LIMITED",
      message,
      remediation: "Wait for the cooldown, then retry; consider lowering automated review volume.",
    };
  }
  if (low.includes("quota") || low.includes("usage limit")) {
    return {
      code: "RATE_LIMITED",
      message,
      remediation: "Subscription quota reached; wait or reduce automated reviews.",
    };
  }
  if (
    low.includes("401") ||
    low.includes("unauthorized") ||
    low.includes("login") ||
    low.includes("not authenticated")
  ) {
    return {
      code: "AUTH_REQUIRED",
      message,
      remediation: "Run `codex login` to authenticate your ChatGPT subscription.",
    };
  }
  if (
    low.includes("model") &&
    (low.includes("not found") || low.includes("unavailable") || low.includes("unknown"))
  ) {
    return {
      code: "MODEL_UNAVAILABLE",
      message,
      remediation: "Pick a supported model via --model or userConfig.reviewModel.",
    };
  }
  if (low.includes("timed out") || low.includes("timeout")) {
    return { code: "TIMEOUT", message };
  }
  return { code: "CODEX_ERROR", message };
}

/**
 * Create the SDK-backed Codex driver (sole transport). Dependencies are injected
 * so the orchestration is unit-testable without spawning a real Codex.
 * @param {{
 *   getCodex: () => any | Promise<any>,
 *   env?: Record<string, string|undefined>,
 *   validate: (kind: any, payload: unknown) => Promise<{ ok: boolean, value?: unknown, errors?: unknown }>,
 *   strictOutputSchema: (kind: any) => object,
 * }} deps
 */
export function createSdkDriver({ getCodex, env = process.env, validate, strictOutputSchema }) {
  return {
    /**
     * @param {{ kind: "review"|"adversarial", prompt: string, workingDirectory: string, skipGitRepoCheck?: boolean, model?: string }} req
     * @returns {Promise<ReviewResult>}
     */
    async review({ kind, prompt, workingDirectory, skipGitRepoCheck = false, model }) {
      let turn;
      try {
        const Codex = await getCodex(); // lazy: SDK lives in ${CLAUDE_PLUGIN_DATA} (§5.4)
        const codex = new Codex({ env: stripApiKeys(env) });
        const thread = codex.startThread({
          sandboxMode: "read-only",
          approvalPolicy: "never",
          skipGitRepoCheck,
          workingDirectory,
          model,
        });
        turn = await thread.run(prompt, { outputSchema: strictOutputSchema(kind) });
      } catch (err) {
        return { ok: false, error: classifyError(err) };
      }

      let parsed;
      try {
        parsed = JSON.parse(turn.finalResponse ?? "");
      } catch {
        return {
          ok: false,
          error: {
            code: "CODEX_ERROR",
            message: "Codex returned an unparseable (non-JSON) payload.",
          },
        };
      }

      const result = await validate(kind, parsed);
      if (!result.ok) {
        return {
          ok: false,
          error: {
            code: "SCHEMA_INVALID",
            message: "Codex payload failed schema validation after normalization.",
          },
        };
      }
      return { ok: true, payload: result.value, usage: turn.usage ?? null };
    },
  };
}
