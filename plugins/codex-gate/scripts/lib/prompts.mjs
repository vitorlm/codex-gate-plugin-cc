import { readFileSync } from "node:fs";

const PROMPT_DIR = new URL("../../prompts/", import.meta.url);
const FILE = { review: "review.md", adversarial: "adversarial-review.md" };

/**
 * @param {"review"|"adversarial"} kind
 * @returns {string}
 */
export function loadTemplate(kind) {
  return readFileSync(new URL(FILE[kind], PROMPT_DIR), "utf8");
}

/**
 * Describe what to review for the prompt. Codex reads files itself (read-only
 * sandbox), so file scopes are listed by path; text scopes are inlined.
 * @param {{ mode: string, targets: string[], text?: string, coverageNote?: string }} scope
 * @returns {string}
 */
export function scopeSection(scope) {
  let body;
  if (scope.mode === "text") {
    body = `Review the following content:\n\n\`\`\`\n${scope.text ?? ""}\n\`\`\``;
  } else {
    const list = scope.targets.map((t) => `- ${t}`).join("\n");
    body = `Review these files in the working directory:\n${list}`;
  }
  if (scope.coverageNote) body += `\n\n⚠ Coverage note: ${scope.coverageNote}`;
  return body;
}

/**
 * Compose the full prompt: instruction template + scope section (+ adversarial focus).
 * @param {{ kind: "review"|"adversarial", scope: Parameters<typeof scopeSection>[0], focus?: string|null, template?: string }} req
 * @returns {string}
 */
export function composePrompt({ kind, scope, focus, template }) {
  const body = template ?? loadTemplate(kind);
  const parts = [body, scopeSection(scope)];
  if (kind === "adversarial" && focus) {
    parts.push(`Focus your challenge specifically on: ${focus}`);
  }
  return parts.join("\n\n");
}
