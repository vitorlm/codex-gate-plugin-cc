/**
 * V-1 harness runner (research/spike — NOT shipped plugin code).
 *
 * Validates the §0 cross-model thesis: on seeded-defect fixtures, does the
 * Codex CROSS-MODEL reviewer find true-positive defect classes a Claude
 * SAME-MODEL reviewer misses, on >=30% of fixtures, at an acceptable FP rate?
 *
 * The two review-producing calls are INJECTED (`codexReviewer`,
 * `claudeReviewer`). This module never calls a real backend on its own:
 *  - The real Codex side is wired in makeRealCodexReviewer() but is only
 *    constructed when you opt in via CLI/flags; it is NOT exercised by tests.
 *  - The real Claude same-model side has no default; you must supply it
 *    (Anthropic API or a Claude subagent) — see README.
 *
 * Pure scoring lives in score.mjs (unit-tested). This file is the I/O + glue:
 * load fixtures → run both reviewers → normalize findings to defect CLASSES →
 * scoreAll → write report. Determinism: no Math.random; any clock is injected.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreAll } from "./score.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "fixtures");

/**
 * @typedef {{ category?: string, title?: string, detail?: string }} Finding
 * @typedef {{ id: string, file: string, truthClasses: string[] }} FixtureSpec
 */

/** Load the fixture manifest. @returns {{ fixtures: FixtureSpec[], classTaxonomy: string[] }} */
export function loadManifest(dir = FIXTURE_DIR) {
  return JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
}

/**
 * Map a single reviewer finding to a canonical defect CLASS ("namespace:slug"),
 * or null if it cannot be confidently classified (then it is dropped, not
 * counted as a false positive of an unrelated class).
 *
 * Codex returns a coarse `category` enum (correctness/security/concurrency/…)
 * plus a free-text title/detail. The V-1 truth is finer-grained
 * ("security:sqli"), so we refine the category using stable keyword cues in the
 * title/detail. This keyword map is deliberate and auditable — it is the only
 * place fixture-specific knowledge lives, and it is applied identically to BOTH
 * reviewers so neither side is advantaged.
 *
 * @param {Finding} finding
 * @returns {string|null}
 */
export function classifyFinding(finding) {
  const category = String(finding.category ?? "").toLowerCase().trim();
  const text = `${finding.title ?? ""} ${finding.detail ?? ""}`.toLowerCase();
  const has = (...needles) => needles.some((n) => text.includes(n));

  switch (category) {
    case "security":
      if (has("sql", "injection")) return "security:sqli";
      if (has("timing", "constant-time", "constant time")) return "security:timing";
      if (has("md5", "sha1", "weak", "broken hash", "insecure hash")) return "security:weak-crypto";
      if (has("path travers", "traversal", "../", "directory travers"))
        return "security:path-traversal";
      return null;
    case "correctness":
      if (has("off-by-one", "off by one", "<=", "reads past", "out of bounds", "index"))
        return "correctness:off-by-one";
      if (has("float", "rounding", "decimal", "money", "currency"))
        return "correctness:float-money";
      if (has("mutat", "shared default", "mutating")) return "correctness:mutation";
      if (has("infinite", "never decrement", "loop", "logic")) return "correctness:logic";
      return null;
    case "concurrency":
      return "concurrency:race";
    case "data-integrity":
      if (has("validat", "nan", "negative", "unchecked", "sanitiz"))
        return "data-integrity:unvalidated";
      return "data-integrity:unvalidated";
    case "performance":
      if (has("n+1", "n + 1", "n plus one", "per row", "per-row", "loop", "round-trip"))
        return "performance:n-plus-one";
      return null;
    case "error-handling":
      return "error-handling:unhandled";
    case "api-misuse":
      if (has("shallow", "spread", "nested")) return "api-misuse:shallow-copy";
      return null;
    default:
      // resource:leak has no dedicated Codex category; detect via text on any.
      if (has("leak", "not cleared", "setinterval", "uncleared", "resource"))
        return "resource:leak";
      return null;
  }
}

/**
 * Normalize a reviewer's payload (or array of findings) to a sorted unique set
 * of canonical defect classes.
 * @param {{ findings?: Finding[] } | Finding[] | null | undefined} review
 * @returns {string[]}
 */
export function normalizeToClasses(review) {
  const findings = Array.isArray(review) ? review : (review?.findings ?? []);
  const classes = new Set();
  for (const f of findings) {
    const c = classifyFinding(f);
    if (c) classes.add(c);
  }
  return [...classes].sort();
}

/**
 * Run the harness against injected reviewers and produce the V-1 verdict.
 *
 * @param {{
 *   codexReviewer: (fixture: { id: string, file: string, path: string, source: string }) => Promise<{ findings?: Finding[] } | Finding[]>,
 *   claudeReviewer: (fixture: { id: string, file: string, path: string, source: string }) => Promise<{ findings?: Finding[] } | Finding[]>,
 *   manifest?: { fixtures: FixtureSpec[] },
 *   fixtureDir?: string,
 *   threshold?: number,
 *   fpRateLimit?: number,
 *   readSource?: (path: string) => string,
 * }} deps
 */
export async function runHarness(deps) {
  const fixtureDir = deps.fixtureDir ?? FIXTURE_DIR;
  const manifest = deps.manifest ?? loadManifest(fixtureDir);
  const readSource = deps.readSource ?? ((p) => readFileSync(p, "utf8"));

  const results = [];
  for (const spec of manifest.fixtures) {
    const path = resolve(fixtureDir, spec.file);
    const fixture = { id: spec.id, file: spec.file, path, source: readSource(path) };

    const codexReview = await deps.codexReviewer(fixture);
    const claudeReview = await deps.claudeReviewer(fixture);

    results.push({
      id: spec.id,
      truthClasses: spec.truthClasses,
      codexClasses: normalizeToClasses(codexReview),
      claudeClasses: normalizeToClasses(claudeReview),
    });
  }

  const verdict = scoreAll(results, {
    threshold: deps.threshold,
    fpRateLimit: deps.fpRateLimit,
  });
  return verdict;
}

/* -------------------------------------------------------------------------- *
 * REAL backends — constructed only on explicit opt-in. Do NOT call during    *
 * the build/tests. No network here unless a human runs the live harness.     *
 * -------------------------------------------------------------------------- */

/**
 * Real Codex cross-model reviewer, wired to the shipped plugin driver
 * (read-only sandbox, subscription auth, no API key). Returns a function that,
 * given a fixture, asks Codex to review the file and yields its findings.
 *
 * NOTE: importing/constructing this does not call Codex; only invoking the
 * returned function does. The live harness (a human activity) is the only
 * caller. Requires `codex login` (ChatGPT subscription) — see README.
 */
export async function makeRealCodexReviewer({ dataDir } = {}) {
  const { createDriver } = await import(
    "../../plugins/codex-gate/scripts/lib/codex-driver.mjs"
  );
  const driver = createDriver({ dataDir: dataDir ?? null });
  return async (fixture) => {
    const prompt = [
      `You are a code reviewer. Read the file ${fixture.file} in the working directory`,
      "and review it for correctness, security, concurrency, performance,",
      "data-integrity, error-handling, and api-misuse defects.",
      "Respond ONLY with the structured output matching the provided schema.",
      "One finding per distinct defect; set `category` to the stable enum value.",
    ].join(" ");
    const res = await driver.review({
      kind: "review",
      prompt,
      workingDirectory: dirname(fixture.path),
      skipGitRepoCheck: true,
      model: null,
    });
    if (!res.ok) throw new Error(`codex review failed: ${res.error?.code}`);
    return res.payload;
  };
}

/**
 * Real Claude SAME-MODEL reviewer — INTENTIONALLY NOT IMPLEMENTED here.
 * Supply your own via injection: either an Anthropic API call (a Claude model
 * reviewing the same fixture with an equivalent prompt) or a Claude subagent.
 * The output must be `{ findings: [{ category, title, detail }] }` so the same
 * `classifyFinding` map applies to both sides. See README for the contract.
 */
export function makeRealClaudeReviewer() {
  throw new Error(
    "claudeReviewer must be injected (Anthropic API or Claude subagent). See spike/v-1/README.md.",
  );
}

// Direct execution guard: the harness must never run live by accident.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.error(
    [
      "V-1 harness is library code. It does not run live from the CLI by default.",
      "It requires INJECTED reviewers (real Codex + a Claude same-model backend).",
      "See spike/v-1/README.md for the live-run protocol (human/quota-gated).",
    ].join("\n"),
  );
  process.exitCode = 2;
}
