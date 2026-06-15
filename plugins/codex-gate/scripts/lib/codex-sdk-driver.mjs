/**
 * @typedef {{ code: string, message: string, remediation?: string }} ErrorEnvelope
 * @typedef {{ ok: true, payload: unknown, usage: object|null } | { ok: false, error: ErrorEnvelope }} ReviewResult
 */

/** Default review-turn ceiling: a hung turn becomes a clean TIMEOUT instead of a zombie shell. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Default gap between liveness heartbeats while Codex works silently (0 disables). */
const DEFAULT_HEARTBEAT_MS = 15_000;

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

/** @param {string} s @param {number} max */
function truncate(s, max) {
  const str = String(s ?? "");
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/** @param {string} s */
function firstLine(s) {
  const [head = ""] = String(s ?? "").split("\n");
  return truncate(head.trim(), 120);
}

/**
 * Render a single ThreadItem to a human progress line, or null when it is noise.
 * Started commands are surfaced *before* the agent waits on them (liveness);
 * other items surface on completion. The final agent_message (the JSON payload)
 * and intermediate `item.updated` churn are deliberately silent.
 * @param {any} item
 * @param {"started"|"completed"} phase
 * @returns {string|null}
 */
function formatItem(item, phase) {
  if (!item) return null;
  switch (item.type) {
    case "command_execution":
      if (phase === "started") return `  $ ${truncate(item.command, 120)}`;
      return item.exit_code && item.exit_code !== 0
        ? `  ⚠ comando saiu com código ${item.exit_code}`
        : null;
    case "reasoning":
      return phase === "completed" && item.text ? `  💭 ${firstLine(item.text)}` : null;
    case "web_search":
      return phase === "completed" ? `  🔎 buscou: ${truncate(item.query, 100)}` : null;
    case "todo_list": {
      if (phase !== "completed") return null;
      const done = (item.items ?? []).filter((/** @type {any} */ t) => t.completed).length;
      return `  ☑ plano: ${done}/${item.items?.length ?? 0} passos`;
    }
    case "file_change":
      return phase === "completed" ? `  ✎ alterou ${item.changes?.length ?? 0} arquivo(s)` : null;
    case "error":
      return `  ⚠ ${truncate(item.message, 160)}`;
    default:
      return null; // agent_message (final JSON) and anything unmodeled
  }
}

/**
 * Render a streamed ThreadEvent to a human progress line, or null when it is noise.
 * Pure (event in / string|null out) so it is trivially unit-testable.
 * @param {any} ev
 * @returns {string|null}
 */
export function formatEvent(ev) {
  switch (ev?.type) {
    case "turn.started":
      return "▶ Codex iniciou a análise";
    case "item.started":
      return formatItem(ev.item, "started");
    case "item.completed":
      return formatItem(ev.item, "completed");
    case "turn.completed": {
      const u = ev.usage;
      return u
        ? `✓ Codex concluiu — tokens in/out/reason: ${u.input_tokens}/${u.output_tokens}/${u.reasoning_output_tokens}`
        : "✓ Codex concluiu";
    }
    case "turn.failed":
      return `✗ Codex falhou: ${ev.error?.message ?? "erro desconhecido"}`;
    case "error":
      return `✗ erro do stream: ${ev.message ?? "desconhecido"}`;
    default:
      return null; // thread.started, item.updated
  }
}

/** Short label for the heartbeat's "last action", or null. @param {any} ev */
function lastActionLabel(ev) {
  if (ev?.type === "item.started" && ev.item?.type === "command_execution") {
    return `rodando ${truncate(ev.item.command, 60)}`;
  }
  if (ev?.type === "item.completed") {
    const i = ev.item;
    if (i?.type === "reasoning") return "raciocinando";
    if (i?.type === "web_search") return `busca "${truncate(i.query, 40)}"`;
    if (i?.type === "command_execution") return "comando concluído";
  }
  return null;
}

/**
 * Drain a Codex event stream, reconstructing the equivalent `Turn` (items,
 * finalResponse, usage) and forwarding every event to `emit`. A `turn.failed`
 * or stream `error` event is raised as a throw so the caller's catch maps it
 * to an envelope — it is never silently treated as a completed turn.
 * @param {AsyncIterable<any>} events
 * @param {(ev: any) => void} emit
 * @returns {Promise<{ items: any[], finalResponse: string, usage: object|null }>}
 */
export async function consumeEvents(events, emit) {
  const items = [];
  let finalResponse = "";
  let usage = null;
  for await (const ev of events) {
    emit(ev);
    if (ev.type === "item.completed") {
      items.push(ev.item);
      if (ev.item?.type === "agent_message") finalResponse = ev.item.text ?? "";
    } else if (ev.type === "turn.completed") {
      usage = ev.usage ?? null;
    } else if (ev.type === "turn.failed") {
      throw new Error(ev.error?.message ?? "Codex turn failed");
    } else if (ev.type === "error") {
      throw new Error(ev.message ?? "Codex stream error");
    }
  }
  return { items, finalResponse, usage };
}

/** Default progress sink: stderr, so structured stdout (JSON/rendered verdict) stays clean. */
function defaultProgress(/** @type {string} */ line) {
  process.stderr.write(`${line}\n`);
}

const defaultTimers = {
  setTimeout: (/** @type {() => void} */ cb, /** @type {number} */ ms) => setTimeout(cb, ms),
  clearTimeout: (/** @type {any} */ id) => clearTimeout(id),
  setInterval: (/** @type {() => void} */ cb, /** @type {number} */ ms) => setInterval(cb, ms),
  clearInterval: (/** @type {any} */ id) => clearInterval(id),
};

/**
 * Create the SDK-backed Codex driver (sole transport). Dependencies are injected
 * so the orchestration is unit-testable without spawning a real Codex.
 * @param {{
 *   getCodex: () => any | Promise<any>,
 *   env?: Record<string, string|undefined>,
 *   validate: (kind: any, payload: unknown) => Promise<{ ok: boolean, value?: unknown, errors?: unknown }>,
 *   strictOutputSchema: (kind: any) => object,
 *   onProgress?: (line: string) => void,
 *   timeoutMs?: number,
 *   heartbeatMs?: number,
 *   timers?: typeof defaultTimers,
 * }} deps
 */
export function createSdkDriver({
  getCodex,
  env = process.env,
  validate,
  strictOutputSchema,
  onProgress = defaultProgress,
  timeoutMs = Number(process.env.CODEX_GATE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  heartbeatMs = process.env.CODEX_GATE_HEARTBEAT_MS !== undefined
    ? Number(process.env.CODEX_GATE_HEARTBEAT_MS)
    : DEFAULT_HEARTBEAT_MS,
  timers = defaultTimers,
}) {
  return {
    /**
     * @param {{ kind: "review"|"adversarial", prompt: string, workingDirectory: string, skipGitRepoCheck?: boolean, model?: string }} req
     * @returns {Promise<ReviewResult>}
     */
    async review({ kind, prompt, workingDirectory, skipGitRepoCheck = false, model }) {
      let turn;
      const controller = new AbortController();
      let timedOut = false;
      let lastAction = "iniciando";
      const startedAt = Date.now();

      const timeoutId = timers.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const heartbeatId =
        heartbeatMs > 0
          ? timers.setInterval(() => {
              const secs = Math.round((Date.now() - startedAt) / 1000);
              onProgress(`⏳ Codex trabalhando há ${secs}s — último: ${lastAction}`);
            }, heartbeatMs)
          : null;

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
        const { events } = await thread.runStreamed(prompt, {
          outputSchema: strictOutputSchema(kind),
          signal: controller.signal,
        });
        turn = await consumeEvents(events, (ev) => {
          const line = formatEvent(ev);
          if (line) onProgress(line);
          const label = lastActionLabel(ev);
          if (label) lastAction = label;
        });
      } catch (err) {
        if (timedOut) {
          return {
            ok: false,
            error: {
              code: "TIMEOUT",
              message: `Codex review timed out after ${timeoutMs}ms.`,
              remediation:
                "Raise CODEX_GATE_TIMEOUT_MS or narrow the review scope (fewer files / a tighter --base).",
            },
          };
        }
        return { ok: false, error: classifyError(err) };
      } finally {
        timers.clearTimeout(timeoutId);
        if (heartbeatId !== null) timers.clearInterval(heartbeatId);
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
