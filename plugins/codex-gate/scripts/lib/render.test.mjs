import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAdversarial, renderError, renderReview } from "./render.mjs";

const REVIEW = {
  verdict: "request_changes",
  summary: "One blocker.",
  findings: [
    {
      category: "security",
      severity: "blocker",
      file: "cart.js",
      line_start: 14,
      title: "SQL injection",
      detail: "User id interpolated into SQL.",
      suggestion: "Use a parameterized query.",
    },
  ],
  next_steps: ["Parameterize the query."],
};

test("renderReview surfaces verdict, summary, and finding details", () => {
  const out = renderReview(REVIEW);
  assert.match(out, /request_changes/i);
  assert.match(out, /One blocker\./);
  assert.match(out, /blocker/i);
  assert.match(out, /security/);
  assert.match(out, /cart\.js/);
  assert.match(out, /SQL injection/);
  assert.match(out, /Parameterize the query\./);
});

test("renderReview shows a clean message when there are no findings", () => {
  const out = renderReview({
    verdict: "approve",
    summary: "All good.",
    findings: [],
    next_steps: [],
  });
  assert.match(out, /approve/i);
  assert.match(out, /no findings/i);
});

test("renderReview appends a coverage warning when provided", () => {
  const out = renderReview(REVIEW, { coverageNote: "tracker-only (Bash edits not detectable)" });
  assert.match(out, /tracker-only/);
});

test("renderAdversarial surfaces verdict and challenge details", () => {
  const out = renderAdversarial({
    verdict: "reconsider",
    summary: "Risky assumption.",
    challenges: [
      {
        severity: "major",
        title: "Token budget too low",
        target: "TOKEN_BUDGET",
        argument: "One review already costs ~94k tokens.",
        failure_mode: "Budget trips before the iteration cap.",
        recommendation: "Raise to ~400k.",
      },
    ],
    next_steps: [],
  });
  assert.match(out, /reconsider/i);
  assert.match(out, /Token budget too low/);
  assert.match(out, /One review already costs/);
});

test("renderError formats code, message, and remediation visibly", () => {
  const out = renderError({
    code: "RATE_LIMITED",
    message: "429 from Codex",
    remediation: "Wait and retry.",
  });
  assert.match(out, /RATE_LIMITED/);
  assert.match(out, /429 from Codex/);
  assert.match(out, /Wait and retry\./);
});
