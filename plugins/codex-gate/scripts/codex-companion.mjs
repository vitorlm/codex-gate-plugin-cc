import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "./lib/args.mjs";
import { authFileExists } from "./lib/auth.mjs";
import { createDriver } from "./lib/codex-driver.mjs";
import { changedFiles, diffFiles, isGitRepo } from "./lib/git.mjs";
import { cancelJob, completeJob, createJob, getJob, listJobs, pruneJobs } from "./lib/jobs.mjs";
import { resolveModel } from "./lib/models.mjs";
import { runReview } from "./lib/pipeline.mjs";
import { composePrompt } from "./lib/prompts.mjs";
import { checkQuota, rateLimitCooldown, recordRateLimit, recordReview } from "./lib/quota.mjs";
import { renderAdversarial, renderError, renderReview } from "./lib/render.mjs";
import { resolveScope } from "./lib/scope.mjs";
import { ensureDeps, PINNED_SPECS } from "./lib/sdk-install.mjs";
import { touched } from "./lib/session-tracker.mjs";
import { gateConfigFromEnv, runSetup } from "./lib/setup.mjs";
import { workspaceStateDir } from "./lib/state.mjs";
import { readJson, writeJsonAtomic } from "./lib/statelock.mjs";

const execFileAsync = promisify(execFile);

const SESSION_ID = process.env.CLAUDE_SESSION_ID ?? "manual";
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA ?? null;
const MAX_PER_DAY = Number(process.env.CODEX_MAX_REVIEWS_PER_DAY ?? 0);
const MAX_JOBS = Number(process.env.CODEX_MAX_JOBS ?? 20);

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
 * Build the review dependency bundle (scope/prompt/model/driver/quota) used by
 * both the foreground command and the background `task-worker`.
 * @returns {any}
 */
function makeReviewDeps() {
  const driver = createDriver();
  const trackerDir = DATA_DIR ? join(DATA_DIR, "sessions") : null;
  return {
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
}

/**
 * Resolve the per-workspace job-deps bundle (clock/id/kill defaults), or null when
 * no data dir is configured. `extra` lets tests inject a dir/clock/id/spawn/kill.
 * @param {Partial<import("./lib/jobs.mjs").JobDeps> & { dir?: string, sessionId?: string }} [extra]
 * @returns {(import("./lib/jobs.mjs").JobDeps & { sessionId: string }) | null}
 */
function makeJobDeps(extra = {}) {
  const dir = extra.dir ?? workspaceStateDir(process.cwd(), { baseDir: DATA_DIR });
  if (!dir) return null;
  return {
    dir,
    now: extra.now ?? Date.now,
    id: extra.id ?? (() => randomUUID().slice(0, 8)),
    kill: extra.kill,
    isAlive: extra.isAlive,
    sessionId: extra.sessionId ?? SESSION_ID,
  };
}

/** @param {any} deps @param {string} s */
function emit(deps, s) {
  (deps.write ?? ((/** @type {string} */ x) => process.stdout.write(x)))(s);
}

/**
 * Foreground review (scope resolution + Codex call), rendered to stdout.
 * @param {"review"|"adversarial"} kind
 * @param {string[]} rest
 */
async function reviewCommand(kind, rest) {
  const args = parseArgs(rest);

  if (args.background) {
    const jobDeps = makeJobDeps();
    if (!jobDeps) {
      process.stderr.write(
        `${renderError({ code: "CODEX_ERROR", message: "--background needs CLAUDE_PLUGIN_DATA", remediation: "Run inside a Claude Code session." })}\n`,
      );
      return 1;
    }
    return spawnBackgroundReview({ kind, argv: rest }, jobDeps);
  }

  const result = await runReview(
    { kind, args, cwd: process.cwd(), defaultMode: "manual" },
    makeReviewDeps(),
  );

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    process.stderr.write(`${renderError(result.error)}\n`);
    return 1;
  }
  process.stdout.write(`${renderResult(kind, result)}\n`);
  return 0;
}

/**
 * Render a completed review/adversarial result (shared by foreground + `result`).
 * @param {"review"|"adversarial"} kind
 * @param {{ payload: unknown, scope?: { coverageNote?: string } }} result
 * @returns {string}
 */
function renderResult(kind, result) {
  const payload = /** @type {any} */ (result.payload);
  return kind === "adversarial"
    ? renderAdversarial(payload)
    : renderReview(payload, { coverageNote: result.scope?.coverageNote });
}

/**
 * Create a job, spawn the detached `task-worker`, and print the jobId immediately
 * (non-blocking, §7.5). Prunes old jobs first.
 * @param {{ kind: "review"|"adversarial", argv: string[] }} spec
 * @param {any} deps job deps (+ optional `spawn`/`write`)
 * @returns {Promise<number>}
 */
export async function spawnBackgroundReview({ kind, argv }, deps) {
  await pruneJobs(deps, { maxJobs: MAX_JOBS });
  const job = await createJob({ kind, scope: scopeLabel(argv), sessionId: deps.sessionId }, deps);

  const spawnFn = deps.spawn ?? spawn;
  const node = process.execPath;
  const self = fileURLToPath(import.meta.url);
  const workerArgs = [self, "task-worker", job.id, kind, ...argv];
  const child = spawnFn(node, workerArgs, { detached: true, stdio: "ignore" });
  if (child?.pid) await completeOrPid(job.id, child.pid, deps);
  child?.unref?.();

  emit(deps, `Started background ${kind}. jobId: ${job.id}\n`);
  emit(
    deps,
    `Check with: status ${job.id}  •  fetch: result ${job.id}  •  stop: cancel ${job.id}\n`,
  );
  return 0;
}

/** Record the worker pid on the job once spawned. @param {string} id @param {number} pid @param {any} deps */
async function completeOrPid(id, pid, deps) {
  const { updateJob } = await import("./lib/jobs.mjs");
  await updateJob(id, { pid }, deps);
}

/** @param {string[]} argv @returns {string} */
function scopeLabel(argv) {
  if (argv.includes("--session")) return "session";
  const baseIdx = argv.indexOf("--base");
  if (baseIdx >= 0 && argv[baseIdx + 1]) return `base ${argv[baseIdx + 1]}`;
  if (argv.includes("--text")) return "text";
  const files = argv.filter((a) => !a.startsWith("--"));
  return files.length ? files.join(", ") : "default";
}

/**
 * Internal background executor (not user-facing): run the review synchronously
 * and write the result/error into the job record. Never throws to the top.
 * @param {string} jobId
 * @param {any} deps job deps
 * @param {{ runReview?: (i: any) => Promise<any>, reviewDeps?: any, argv?: string[], kind?: "review"|"adversarial" }} [opts]
 * @returns {Promise<number>}
 */
export async function runTaskWorker(jobId, deps, opts = {}) {
  try {
    const kind = opts.kind ?? "review";
    const args = parseArgs(opts.argv ?? []);
    const run = opts.runReview ?? runReview;
    const reviewDeps = opts.reviewDeps ?? makeReviewDeps();
    const result = await run({ kind, args, cwd: process.cwd(), defaultMode: "manual" }, reviewDeps);
    if (result.ok) {
      await completeJob(jobId, result.payload, deps);
      return 0;
    }
    await completeJob(jobId, null, deps, result.error);
    return 1;
  } catch (err) {
    await completeJob(jobId, null, deps, {
      code: "CODEX_ERROR",
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
    return 1;
  }
}

/**
 * `status [jobId]` — list all jobs, or show one. Reconciles orphaned workers.
 * @param {string|undefined} jobId @param {any} deps @returns {Promise<number>}
 */
export async function statusHandler(jobId, deps) {
  if (jobId) {
    const job = await getJob(jobId, deps);
    if (!job) {
      emit(deps, `⚠ job not found: ${jobId}\n`);
      return 1;
    }
    emit(deps, `${renderJobLine(job)}\n`);
    return 0;
  }
  const jobs = await listJobs(deps, { reconcile: true });
  if (jobs.length === 0) {
    emit(deps, "No background jobs.\n");
    return 0;
  }
  for (const job of jobs) emit(deps, `${renderJobLine(job)}\n`);
  return 0;
}

/** @param {import("./lib/jobs.mjs").Job} job @returns {string} */
function renderJobLine(job) {
  const when = new Date(job.updatedAt).toISOString();
  return `${job.id}  ${job.status.padEnd(9)}  ${job.kind}  (${job.scope})  ${when}`;
}

/**
 * `result <jobId>` — print a finished job's verdict, or its current state.
 * @param {string|undefined} jobId @param {any} deps @returns {Promise<number>}
 */
export async function resultHandler(jobId, deps) {
  if (!jobId) {
    emit(deps, "⚠ result requires a jobId\n");
    return 1;
  }
  const job = await getJob(jobId, deps);
  if (!job) {
    emit(deps, `⚠ job not found: ${jobId}\n`);
    return 1;
  }
  if (job.status === "running") {
    emit(deps, `Job ${job.id} is still running. Check again with: status ${job.id}\n`);
    return 0;
  }
  if (job.status === "cancelled") {
    emit(deps, `Job ${job.id} was cancelled.\n`);
    return 0;
  }
  if (job.status === "error") {
    emit(deps, `${renderError(/** @type {any} */ (job.error))}\n`);
    return 1;
  }
  emit(deps, `${renderResult(job.kind, { payload: job.result })}\n`);
  return 0;
}

/**
 * `cancel <jobId>` — terminate the worker pid and mark cancelled.
 * @param {string|undefined} jobId @param {any} deps @returns {Promise<number>}
 */
export async function cancelHandler(jobId, deps) {
  if (!jobId) {
    emit(deps, "⚠ cancel requires a jobId\n");
    return 1;
  }
  const job = await cancelJob(jobId, deps);
  if (!job) {
    emit(deps, `⚠ job not found: ${jobId}\n`);
    return 1;
  }
  emit(
    deps,
    `Job ${job.id} ${job.status === "cancelled" ? "cancelled" : `already ${job.status}`}.\n`,
  );
  return 0;
}

/**
 * `setup` — pre-install the pinned SDK + run a real login probe (auth vs throttled,
 * §6.3) + report the effective stop-gate config. The probe is a minimal read-only
 * Codex call; failures are classified, never run live in tests (`runSetup` is unit-
 * tested with injected deps). Degrades to a clear message + non-crashing exit when
 * `CLAUDE_PLUGIN_DATA` is unset (no place to install the SDK).
 * @returns {Promise<number>}
 */
export async function setupCommand() {
  const write = (/** @type {string} */ s) => process.stdout.write(s);
  if (!DATA_DIR) {
    write(
      `${renderError({ code: "CODEX_ERROR", message: "no data dir (CLAUDE_PLUGIN_DATA unset) — cannot install the SDK", remediation: "Run /codex-gate:setup inside a Claude Code session." })}\n`,
    );
    write(`${JSON.stringify(gateConfigFromEnv(), null, 0)}\n`);
    return 1;
  }
  const dataDir = DATA_DIR;
  return runSetup({
    probe: () =>
      createDriver().review({
        kind: "review",
        prompt: "Reply with an empty review. This is a connectivity probe.",
        workingDirectory: process.cwd(),
        skipGitRepoCheck: true,
        model: resolveModel(process.env.CODEX_GATE_MODEL ?? null),
      }),
    ensureSdk: () =>
      ensureDeps(dataDir, {
        install: async () => {
          await execFileAsync(
            "npm",
            ["install", "--prefix", dataDir, "--no-save", ...PINNED_SPECS],
            { timeout: 120_000 },
          );
        },
      }),
    readAuthFile: authFileExists,
    config: gateConfigFromEnv(),
    write,
  });
}

/** @param {string[]} argv */
async function main(argv) {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "review":
      return reviewCommand("review", rest);
    case "adversarial-review":
      return reviewCommand("adversarial", rest);
    case "status": {
      const deps = makeJobDeps();
      return deps ? statusHandler(rest[0], deps) : noState();
    }
    case "result": {
      const deps = makeJobDeps();
      return deps ? resultHandler(rest[0], deps) : noState();
    }
    case "cancel": {
      const deps = makeJobDeps();
      return deps ? cancelHandler(rest[0], deps) : noState();
    }
    case "task-worker": {
      const [jobId, kind, ...reviewArgv] = rest;
      const deps = makeJobDeps();
      if (!deps || !jobId) return 1;
      return runTaskWorker(jobId, deps, {
        kind: /** @type {any} */ (kind ?? "review"),
        argv: reviewArgv,
      });
    }
    case "setup":
      return setupCommand();
    default:
      process.stderr.write(
        "usage: codex-companion.mjs <review|adversarial-review|setup|status|result|cancel> [args]\n",
      );
      return 2;
  }
}

/** @returns {number} */
function noState() {
  process.stderr.write(
    `${renderError({ code: "CODEX_ERROR", message: "no state dir (CLAUDE_PLUGIN_DATA unset)", remediation: "Run inside a Claude Code session." })}\n`,
  );
  return 1;
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
