/**
 * V-1 scoring logic (pure, deterministic — no I/O, no clock, no randomness).
 *
 * The V-1 thesis (tech-spec §0): on seeded-defect fixtures, does the Codex
 * CROSS-MODEL reviewer find true-positive defect CLASSES that a Claude
 * SAME-MODEL reviewer misses? Success criterion: Codex shows that edge
 * (>=1 distinct TP class Claude missed) on >=30% of fixtures, at an
 * acceptable false-positive rate.
 *
 * Everything here operates on defect CLASS sets (strings like
 * "security:sqli"). Turning model findings into classes is the harness's job
 * (run-v1.mjs); this module is the verdict math and is the part that gates
 * the 1.0 claim, so it is unit-tested.
 *
 * A "class" is an opaque string; comparison is exact set membership. Callers
 * normalize/canonicalize (lowercase, alias) BEFORE handing classes here so the
 * scoring stays trivially deterministic.
 *
 * @typedef {Object} FixtureResult
 * @property {string} id                fixture id
 * @property {string[]} truthClasses    seeded ground-truth classes (may be empty = control)
 * @property {string[]} codexClasses    classes the Codex reviewer reported
 * @property {string[]} claudeClasses   classes the Claude reviewer reported
 *
 * @typedef {Object} PerFixtureScore
 * @property {string} id
 * @property {string[]} truth
 * @property {string[]} codexTruePositives
 * @property {string[]} claudeTruePositives
 * @property {string[]} codexEdgeClasses   TP classes Codex caught that Claude missed
 * @property {boolean} codexHasEdge        codexEdgeClasses.length > 0
 * @property {string[]} claudeEdgeClasses  TP classes Claude caught that Codex missed
 * @property {string[]} codexFalsePositives classes Codex reported not in truth
 * @property {string[]} claudeFalsePositives classes Claude reported not in truth
 *
 * @typedef {Object} Verdict
 * @property {boolean} criterionMet
 * @property {number} fixtureCount
 * @property {number} fixturesWithCodexEdge
 * @property {number} fractionWithCodexEdge
 * @property {number} threshold
 * @property {number} codexFpRate         FPs per fixture (mean)
 * @property {number} claudeFpRate
 * @property {number} codexTotalFalsePositives
 * @property {number} claudeTotalFalsePositives
 * @property {number} fpRateLimit
 * @property {boolean} fpRateAcceptable
 * @property {PerFixtureScore[]} perFixture
 */

/** Stable de-duplicated set as a sorted array (determinism for snapshots). */
function uniqSorted(xs) {
  return [...new Set(xs)].sort();
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {string[]} members of `a` that are also in `b`, sorted+unique
 */
function intersect(a, b) {
  const set = new Set(b);
  return uniqSorted(a.filter((x) => set.has(x)));
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {string[]} members of `a` that are NOT in `b`, sorted+unique
 */
function difference(a, b) {
  const set = new Set(b);
  return uniqSorted(a.filter((x) => !set.has(x)));
}

/**
 * Score a single fixture.
 * @param {FixtureResult} fixture
 * @returns {PerFixtureScore}
 */
export function scoreFixture(fixture) {
  const truth = uniqSorted(fixture.truthClasses ?? []);
  const codex = uniqSorted(fixture.codexClasses ?? []);
  const claude = uniqSorted(fixture.claudeClasses ?? []);

  const codexTruePositives = intersect(codex, truth);
  const claudeTruePositives = intersect(claude, truth);

  // The load-bearing quantity: TRUE-POSITIVE classes Codex caught and Claude
  // did NOT. Restricting to TPs is deliberate — a class both miss, or a class
  // Codex hallucinates (not in truth), must never count as a cross-model edge.
  const codexEdgeClasses = difference(codexTruePositives, claudeTruePositives);
  const claudeEdgeClasses = difference(claudeTruePositives, codexTruePositives);

  // False positives: reported classes absent from truth. On the control
  // fixture (truth = []), every reported class is an FP.
  const codexFalsePositives = difference(codex, truth);
  const claudeFalsePositives = difference(claude, truth);

  return {
    id: fixture.id,
    truth,
    codexTruePositives,
    claudeTruePositives,
    codexEdgeClasses,
    codexHasEdge: codexEdgeClasses.length > 0,
    claudeEdgeClasses,
    codexFalsePositives,
    claudeFalsePositives,
  };
}

/**
 * Aggregate per-fixture scores into the V-1 verdict.
 *
 * @param {FixtureResult[]} fixtures
 * @param {{ threshold?: number, fpRateLimit?: number }} [opts]
 *   threshold   — minimum fraction of fixtures that must show a Codex edge
 *                 (default 0.30 = the §0 ">=30%" criterion).
 *   fpRateLimit — maximum acceptable Codex FP rate (mean FPs/fixture) for the
 *                 "acceptable false-positive rate" clause (default 0.5).
 * @returns {Verdict}
 */
export function scoreAll(fixtures, opts = {}) {
  const threshold = opts.threshold ?? 0.3;
  const fpRateLimit = opts.fpRateLimit ?? 0.5;

  const perFixture = (fixtures ?? []).map(scoreFixture);
  const fixtureCount = perFixture.length;

  const fixturesWithCodexEdge = perFixture.filter((p) => p.codexHasEdge).length;
  const fractionWithCodexEdge = fixtureCount === 0 ? 0 : fixturesWithCodexEdge / fixtureCount;

  const codexTotalFalsePositives = perFixture.reduce((n, p) => n + p.codexFalsePositives.length, 0);
  const claudeTotalFalsePositives = perFixture.reduce(
    (n, p) => n + p.claudeFalsePositives.length,
    0,
  );
  const codexFpRate = fixtureCount === 0 ? 0 : codexTotalFalsePositives / fixtureCount;
  const claudeFpRate = fixtureCount === 0 ? 0 : claudeTotalFalsePositives / fixtureCount;

  const fpRateAcceptable = codexFpRate <= fpRateLimit;
  // Criterion (§0): the cross-model EDGE must clear the threshold AND the FP
  // rate must stay acceptable. An empty fixture set never "passes".
  const criterionMet = fixtureCount > 0 && fractionWithCodexEdge >= threshold && fpRateAcceptable;

  return {
    criterionMet,
    fixtureCount,
    fixturesWithCodexEdge,
    fractionWithCodexEdge,
    threshold,
    codexFpRate,
    claudeFpRate,
    codexTotalFalsePositives,
    claudeTotalFalsePositives,
    fpRateLimit,
    fpRateAcceptable,
    perFixture,
  };
}
