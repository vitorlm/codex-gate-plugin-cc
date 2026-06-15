import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFinding, normalizeToClasses, runHarness } from "./run-v1.mjs";

test("classifyFinding: refines coarse category via stable text cues", () => {
  assert.equal(
    classifyFinding({ category: "security", title: "SQL injection via string interpolation" }),
    "security:sqli",
  );
  assert.equal(
    classifyFinding({ category: "security", detail: "MD5 is a broken hash for tokens" }),
    "security:weak-crypto",
  );
  assert.equal(
    classifyFinding({ category: "concurrency", title: "anything" }),
    "concurrency:race",
  );
  assert.equal(
    classifyFinding({ category: "correctness", title: "off-by-one reads past the end" }),
    "correctness:off-by-one",
  );
  // resource:leak has no Codex category — detected via text on the default branch.
  assert.equal(
    classifyFinding({ category: "other", detail: "setInterval timer is never cleared (leak)" }),
    "resource:leak",
  );
});

test("classifyFinding: returns null for unclassifiable findings (dropped, not FP)", () => {
  assert.equal(classifyFinding({ category: "security", title: "vague concern" }), null);
  assert.equal(classifyFinding({ category: "style", title: "naming" }), null);
});

test("normalizeToClasses: dedupes and sorts; accepts payload or array", () => {
  const payload = {
    findings: [
      { category: "security", title: "SQL injection" },
      { category: "security", title: "another SQL injection sink" },
      { category: "correctness", title: "off-by-one index" },
    ],
  };
  assert.deepEqual(normalizeToClasses(payload), ["correctness:off-by-one", "security:sqli"]);
  assert.deepEqual(normalizeToClasses([]), []);
  assert.deepEqual(normalizeToClasses(null), []);
});

test("runHarness: end-to-end with injected reviewers (no live backend)", async () => {
  // Two fixtures with explicit truth; reviewers return synthetic findings.
  const manifest = {
    fixtures: [
      { id: "f01", file: "f01.js", truthClasses: ["security:sqli", "correctness:off-by-one"] },
      { id: "f02", file: "f02.js", truthClasses: ["concurrency:race"] },
    ],
  };
  // Codex catches sqli on f01 that Claude misses → edge on 1 of 2 = 0.5 >= 0.30.
  const codexReviewer = async (fx) =>
    fx.id === "f01"
      ? {
          findings: [
            { category: "security", title: "SQL injection" },
            { category: "correctness", title: "off-by-one index" },
          ],
        }
      : { findings: [{ category: "concurrency", title: "race condition" }] };
  const claudeReviewer = async (fx) =>
    fx.id === "f01"
      ? { findings: [{ category: "correctness", title: "off-by-one index" }] }
      : { findings: [{ category: "concurrency", title: "race condition" }] };

  const verdict = await runHarness({
    manifest,
    codexReviewer,
    claudeReviewer,
    readSource: () => "// stub source",
  });

  assert.equal(verdict.fixtureCount, 2);
  assert.equal(verdict.fixturesWithCodexEdge, 1);
  assert.equal(verdict.fractionWithCodexEdge, 0.5);
  assert.equal(verdict.criterionMet, true);
  assert.equal(verdict.codexFpRate, 0);
  const f01 = verdict.perFixture.find((p) => p.id === "f01");
  assert.deepEqual(f01.codexEdgeClasses, ["security:sqli"]);
});

test("runHarness: uses real fixtures/manifest.json when no manifest injected", async () => {
  // Reviewers that find nothing → criterion fails, but proves the manifest +
  // fixture files load and flow through scoring without any live backend.
  const none = async () => ({ findings: [] });
  const verdict = await runHarness({ codexReviewer: none, claudeReviewer: none });
  assert.equal(verdict.fixtureCount, 9); // 8 defective + 1 control
  assert.equal(verdict.criterionMet, false);
  assert.equal(verdict.fixturesWithCodexEdge, 0);
});
