import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDriver } from "./lib/codex-driver.mjs";
import { changedFiles, diffFiles, isGitRepo } from "./lib/git.mjs";
import { loadState, postReview, preReview, saveState, stopHookOutput } from "./lib/loop-state.mjs";
import { resolveModel } from "./lib/models.mjs";
import { composePrompt } from "./lib/prompts.mjs";
import { resolveScope } from "./lib/scope.mjs";
import { ensureDeps, PINNED_SPECS } from "./lib/sdk-install.mjs";
import { touched } from "./lib/session-tracker.mjs";

const execFileAsync = promisify(execFile);

const env = process.env;
const DATA_DIR = env.CLAUDE_PLUGIN_DATA ?? null;
const CONFIG = {
  enabled: env.CODEX_GATE_STOP_REVIEW === "true",
  maxIterations: Number(env.CODEX_GATE_MAX_ITER ?? 3),
  threshold: env.CODEX_GATE_SEVERITY ?? "blocker",
  tokenBudget: Number(env.CODEX_GATE_TOKEN_BUDGET ?? 400_000),
  onUnavailable: env.CODEX_GATE_ON_UNAVAILABLE ?? "allow", // "allow" | "block"
  streakLimit: Number(env.CODEX_GATE_STREAK_LIMIT ?? 3),
  model: resolveModel(env.CODEX_GATE_MODEL ?? null),
};

async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/** Emit the Stop-hook decision object (empty = silently allow) and exit 0. @param {Record<string, unknown>} obj */
function emit(obj) {
  if (obj && Object.keys(obj).length > 0) process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exit(0);
}

async function main() {
  const input = JSON.parse((await readStdin()) || "{}");

  // Opt-in only, and only meaningful with a data dir.
  if (!CONFIG.enabled || !DATA_DIR) return emit({});

  const sessionId = input.session_id ?? "manual";
  const cwd = input.cwd ?? process.cwd();
  const sessionsDir = join(DATA_DIR, "sessions");
  const state = loadState(sessionId, DATA_DIR);

  // Resolve session scope (git-augmented) and a cheap diff hash for no-op detection.
  const scoped = resolveScope(
    { defaultMode: "stop-gate", cwd },
    {
      sessionId,
      git: { isGitRepo, changedFiles, diffFiles },
      tracker: { touched: (sid) => touched(sid, { dir: sessionsDir }) },
    },
  );
  const realScope = scoped.ok
    ? scoped.scope
    : { mode: "session", targets: [], root: cwd, git: false, coverage: "tracker-only" };
  const targets = realScope.targets ?? [];
  const diffHash = createHash("sha256")
    .update([...targets].sort().join("\n"))
    .digest("hex");
  const gateScope = { empty: targets.length === 0, diffHash };

  const pre = preReview(state, {
    hookActive: !!input.stop_hook_active,
    scope: gateScope,
    config: CONFIG,
  });
  if (pre.action !== "review") {
    saveState(sessionId, DATA_DIR, pre.state);
    return emit(stopHookOutput(pre.action === "open" ? "open" : "allow", pre.reason ?? ""));
  }

  // Ensure the pinned runtime deps (SDK + ajv) exist (lazy, first review).
  const deps = await ensureDeps(DATA_DIR, {
    install: async () => {
      await execFileAsync("npm", ["install", "--prefix", DATA_DIR, "--no-save", ...PINNED_SPECS], {
        timeout: 120_000,
      });
    },
  });
  if (!deps.ok) return handleUnavailable(sessionId, state, deps.error);

  const prompt = composePrompt({ kind: "review", scope: realScope });
  const result = await createDriver().review({
    kind: "review",
    prompt,
    workingDirectory: realScope.root,
    skipGitRepoCheck: !realScope.git,
    model: CONFIG.model,
  });

  if (!result.ok) return handleUnavailable(sessionId, pre.state, result.error);

  const post = postReview(pre.state, {
    findings: /** @type {any} */ (result.payload)?.findings ?? [],
    usage: result.usage,
    scope: gateScope,
    config: CONFIG,
  });
  saveState(sessionId, DATA_DIR, { ...post.state, notReviewedStreak: 0 });
  return emit(stopHookOutput(post.decision, post.reason));
}

/**
 * §8 / OD-1: Codex unavailable → never block uselessly by default; warn visibly, escalate on a streak.
 * @param {string} sessionId @param {import("./lib/loop-state.mjs").LoopState} state @param {{ code: string, message: string }} error
 */
function handleUnavailable(sessionId, state, error) {
  const dir = /** @type {string} */ (DATA_DIR);
  const streak = (state.notReviewedStreak ?? 0) + 1;
  saveState(sessionId, dir, { ...state, notReviewedStreak: streak });

  if (CONFIG.onUnavailable === "block") {
    return emit({
      decision: "block",
      reason: `Codex unavailable (${error.code}): ${error.message}`,
    });
  }
  let msg = `⚠ TURN NOT REVIEWED: ${error.code} — ${error.message}`;
  if (streak >= CONFIG.streakLimit) {
    msg += `\n   (${streak} consecutive unreviewed turns — run /codex-gate:setup, raise quota, or disable the gate.)`;
  }
  return emit({ systemMessage: msg });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => emit({})); // fail open: never block the turn on an unexpected error
}

export { main };
