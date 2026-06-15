/**
 * Human-readable rendering of the structured verdict and error envelope.
 * Kept pure (string in/out) so it is trivially testable and reusable by the
 * commands and the subagent.
 */

/** @type {Record<string, string>} */
const SEVERITY_ICON = { blocker: "⛔", major: "🔴", minor: "🟡", info: "ℹ️" };

/** @param {string} sev */
function sev(sev) {
  return `${SEVERITY_ICON[sev] ?? ""} ${sev}`.trim();
}

/**
 * @param {{ verdict: string, summary: string, findings: any[], next_steps?: string[] }} payload
 * @param {{ coverageNote?: string }} [opts]
 * @returns {string}
 */
export function renderReview(payload, opts = {}) {
  const lines = [`Verdict: ${payload.verdict}`, "", payload.summary, ""];

  if (!payload.findings || payload.findings.length === 0) {
    lines.push("No findings.");
  } else {
    lines.push(`Findings (${payload.findings.length}):`);
    for (const f of payload.findings) {
      const loc = f.line_start ? `${f.file}:${f.line_start}` : f.file;
      lines.push(`- [${sev(f.severity)}] (${f.category}) ${f.title} — ${loc}`);
      if (f.detail) lines.push(`    ${f.detail}`);
      if (f.suggestion) lines.push(`    ↳ ${f.suggestion}`);
    }
  }

  appendNextSteps(lines, payload.next_steps);
  if (opts.coverageNote) lines.push("", `⚠ Coverage: ${opts.coverageNote}`);
  return lines.join("\n");
}

/**
 * @param {{ verdict: string, summary: string, challenges: any[], next_steps?: string[] }} payload
 * @returns {string}
 */
export function renderAdversarial(payload) {
  const lines = [`Verdict: ${payload.verdict}`, "", payload.summary, ""];

  if (!payload.challenges || payload.challenges.length === 0) {
    lines.push("No challenges raised.");
  } else {
    lines.push(`Challenges (${payload.challenges.length}):`);
    for (const c of payload.challenges) {
      const target = c.target ? ` @ ${c.target}` : "";
      lines.push(`- [${sev(c.severity)}] ${c.title}${target}`);
      if (c.argument) lines.push(`    ${c.argument}`);
      if (c.failure_mode) lines.push(`    ⚠ ${c.failure_mode}`);
      if (c.recommendation) lines.push(`    ↳ ${c.recommendation}`);
    }
  }

  appendNextSteps(lines, payload.next_steps);
  return lines.join("\n");
}

/**
 * @param {{ code: string, message: string, remediation?: string }} envelope
 * @returns {string}
 */
export function renderError(envelope) {
  let out = `⚠ ${envelope.code}: ${envelope.message}`;
  if (envelope.remediation) out += `\n  → ${envelope.remediation}`;
  return out;
}

/** @param {string[]} lines @param {string[]|undefined} steps */
function appendNextSteps(lines, steps) {
  if (steps && steps.length > 0) {
    lines.push("", "Next steps:");
    for (const s of steps) lines.push(`- ${s}`);
  }
}
