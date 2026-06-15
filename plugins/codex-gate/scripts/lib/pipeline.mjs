/**
 * Foreground review pipeline orchestration (§7). Collaborators are injected so
 * the sequence — quota gate → scope → prompt → driver → accounting — is testable
 * without a real Codex, Git, or filesystem.
 *
 * @typedef {{ files: string[], session: boolean, base: string|null, text: string|null, model: string|null, focus: string|null }} ParsedArgs
 */

/**
 * @param {{ kind: "review"|"adversarial", args: ParsedArgs, cwd: string, defaultMode?: "stop-gate"|"manual" }} input
 * @param {{
 *   resolveScope: (i: any) => { ok: true, scope: any } | { ok: false, error: { code: string, message: string, remediation?: string } },
 *   composePrompt: (r: any) => string,
 *   resolveModel: (m: string|null) => string,
 *   review: (req: any) => Promise<{ ok: true, payload: unknown, usage: object|null } | { ok: false, error: { code: string, message: string, remediation?: string } }>,
 *   quota: { check: () => ({ ok: true } | { ok: false, error: { code: string, message: string, remediation?: string } }), onSuccess: () => void, onRateLimit: () => void },
 * }} deps
 * @returns {Promise<{ ok: true, payload: unknown, usage: object|null, scope: any } | { ok: false, error: { code: string, message: string, remediation?: string } }>}
 */
export async function runReview({ kind, args, cwd, defaultMode }, deps) {
  const { resolveScope, composePrompt, resolveModel, review, quota } = deps;

  // 1. Quota gate — refuse before doing any work (never a silent drop).
  const q = quota.check();
  if (!q.ok) return q;

  // 2. Resolve scope (Git-optional; §7.1).
  const scoped = resolveScope({
    files: args.files,
    text: args.text,
    session: args.session,
    base: args.base,
    defaultMode,
    cwd,
  });
  if (!scoped.ok) return scoped;
  const { scope } = scoped;

  // 3. Compose prompt + run the cross-model review.
  const prompt = composePrompt({ kind, scope, focus: args.focus });
  const result = await review({
    kind,
    prompt,
    workingDirectory: scope.root,
    skipGitRepoCheck: !scope.git,
    model: resolveModel(args.model),
  });

  // 4. Account for the outcome.
  if (result.ok) {
    quota.onSuccess();
    return { ok: true, payload: result.payload, usage: result.usage, scope };
  }
  if (result.error?.code === "RATE_LIMITED") quota.onRateLimit();
  return result;
}
