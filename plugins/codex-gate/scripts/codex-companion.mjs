import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import { createDriver } from "./lib/codex-driver.mjs";
import { changedFiles, diffFiles, isGitRepo } from "./lib/git.mjs";
import { resolveModel } from "./lib/models.mjs";
import { runReview } from "./lib/pipeline.mjs";
import { composePrompt } from "./lib/prompts.mjs";
import { checkQuota, rateLimitCooldown, recordRateLimit, recordReview } from "./lib/quota.mjs";
import { renderAdversarial, renderError, renderReview } from "./lib/render.mjs";
import { resolveScope } from "./lib/scope.mjs";
import { touched } from "./lib/session-tracker.mjs";
import { readJson, writeJsonAtomic } from "./lib/statelock.mjs";

const SESSION_ID = process.env.CLAUDE_SESSION_ID ?? "manual";
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA ?? null;
const MAX_PER_DAY = Number(process.env.CODEX_MAX_REVIEWS_PER_DAY ?? 0);

/**
 * Quota façade backed by an atomic JSON file (full locking deferred to state.mjs, §10).
 * @returns {{ check: () => ({ ok: true } | { ok: false, error: { code: string, message: string, remediation?: string } }), onSuccess: () => void, onRateLimit: () => void }}
 */
function makeQuota() {
  if (!DATA_DIR) {
    return { check: () => ({ ok: true }), onSuccess() {}, onRateLimit() {} };
  }
  const file = join(DATA_DIR, "quota.json");
  const load = () => readJson(file, { day: "", count: 0, rateLimitHits: [] });
  return {
    check() {
      const now = Date.now();
      const st = load();
      const q = checkQuota(st, { maxPerDay: MAX_PER_DAY, now });
      if (!q.ok) return q;
      const cd = rateLimitCooldown(st, { now });
      if (cd.active) {
        return {
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: cd.message ?? "Backing off after repeated rate limits.",
            remediation: "Wait for the backoff cooldown to end.",
          },
        };
      }
      return { ok: true };
    },
    onSuccess() {
      writeJsonAtomic(file, recordReview(load(), { now: Date.now() }));
    },
    onRateLimit() {
      writeJsonAtomic(file, recordRateLimit(load(), { now: Date.now() }));
    },
  };
}

/**
 * @param {"review"|"adversarial"} kind
 * @param {string[]} rest
 */
async function reviewCommand(kind, rest) {
  const args = parseArgs(rest);
  const cwd = process.cwd();
  const driver = createDriver();
  const trackerDir = DATA_DIR ? join(DATA_DIR, "sessions") : null;

  const deps = {
    resolveScope: (/** @type {any} */ input) =>
      resolveScope(input, {
        sessionId: SESSION_ID,
        git: { isGitRepo, changedFiles, diffFiles },
        tracker: {
          touched: (/** @type {string} */ sid) =>
            trackerDir ? touched(sid, { dir: trackerDir }) : [],
        },
      }),
    composePrompt,
    resolveModel,
    review: (/** @type {any} */ req) => driver.review(req),
    quota: makeQuota(),
  };

  const result = await runReview({ kind, args, cwd, defaultMode: "manual" }, deps);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  if (!result.ok) {
    process.stderr.write(`${renderError(result.error)}\n`);
    return 1;
  }
  const payload = /** @type {any} */ (result.payload);
  const text =
    kind === "adversarial"
      ? renderAdversarial(payload)
      : renderReview(payload, { coverageNote: result.scope?.coverageNote });
  process.stdout.write(`${text}\n`);
  return 0;
}

/** @param {string[]} argv */
async function main(argv) {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "review":
      return reviewCommand("review", rest);
    case "adversarial-review":
      return reviewCommand("adversarial", rest);
    case "setup":
    case "status":
    case "result":
    case "cancel":
    case "task-worker":
      process.stderr.write(`subcommand '${subcommand}' is not implemented yet\n`);
      return 2;
    default:
      process.stderr.write(
        `usage: codex-companion.mjs <review|adversarial-review|setup|status|result|cancel> [args]\n`,
      );
      return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(
        `${renderError({ code: "CODEX_ERROR", message: String(err?.message ?? err) })}\n`,
      );
      process.exit(1);
    },
  );
}

export { main, reviewCommand };
