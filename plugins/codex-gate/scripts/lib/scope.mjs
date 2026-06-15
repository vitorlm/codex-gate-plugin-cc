/**
 * Session-first, Git-optional scope resolution with a *visible* coverage gap
 * (spec §7.1). Git collaborators and the session tracker are injected so the
 * decision logic is unit-testable.
 *
 * @typedef {{
 *   mode: "files"|"text"|"session"|"base"|"diff",
 *   targets: string[],
 *   text?: string,
 *   root: string,
 *   git: boolean,
 *   coverage: "explicit"|"text"|"git-augmented"|"tracker-only"|"diff",
 *   coverageNote?: string,
 * }} Scope
 * @typedef {{ ok: true, scope: Scope } | { ok: false, error: { code: string, message: string, remediation?: string } }} ScopeResult
 */

const NO_SCOPE = {
  code: "NO_SCOPE",
  message: "No reviewable scope could be resolved.",
  remediation:
    "Pass explicit file paths, --text, --session, or --base <ref>; or run inside a Git repo with working-tree changes.",
};

/**
 * @param {{ files?: string[], text?: string, session?: boolean, base?: string, defaultMode?: "stop-gate"|"manual", cwd: string }} input
 * @param {{ sessionId: string, git: { isGitRepo: (cwd: string) => boolean, changedFiles: (cwd: string) => string[], diffFiles: (base: string, cwd: string) => string[] }, tracker: { touched: (sessionId: string) => string[] } }} deps
 * @returns {ScopeResult}
 */
export function resolveScope(input, deps) {
  const { cwd } = input;

  if (input.files && input.files.length > 0) {
    return ok({ mode: "files", targets: input.files, root: cwd, git: false, coverage: "explicit" });
  }

  if (input.text != null) {
    return ok({
      mode: "text",
      targets: [],
      text: input.text,
      root: cwd,
      git: false,
      coverage: "text",
    });
  }

  if (input.session) {
    return ok(resolveSession(cwd, deps));
  }

  if (input.base != null) {
    if (!deps.git.isGitRepo(cwd)) {
      return fail({
        ...NO_SCOPE,
        message: "--base requires a Git repository, but none was found.",
        remediation: "Run inside a Git repo, or use explicit files / --text instead.",
      });
    }
    return ok({
      mode: "base",
      targets: deps.git.diffFiles(input.base, cwd),
      root: cwd,
      git: true,
      coverage: "diff",
    });
  }

  if (input.defaultMode === "stop-gate") {
    return ok(resolveSession(cwd, deps));
  }

  if (input.defaultMode === "manual" && deps.git.isGitRepo(cwd)) {
    return ok({
      mode: "diff",
      targets: deps.git.changedFiles(cwd),
      root: cwd,
      git: true,
      coverage: "diff",
    });
  }

  return fail(NO_SCOPE);
}

/**
 * @param {string} cwd
 * @param {Parameters<typeof resolveScope>[1]} deps
 * @returns {Scope}
 */
function resolveSession(cwd, deps) {
  const tracked = deps.tracker.touched(deps.sessionId);

  if (!deps.git.isGitRepo(cwd)) {
    return {
      mode: "session",
      targets: tracked,
      root: cwd,
      git: false,
      coverage: "tracker-only",
      coverageNote: "tracker-only (Bash edits not detectable)",
    };
  }

  const changed = deps.git.changedFiles(cwd);
  const trackedSet = new Set(tracked);
  const bashOnly = changed.filter((f) => !trackedSet.has(f));
  const targets = [...tracked, ...bashOnly];

  /** @type {Scope} */
  const scope = { mode: "session", targets, root: cwd, git: true, coverage: "git-augmented" };
  if (bashOnly.length > 0) {
    scope.coverageNote = `Added ${bashOnly.length} file(s) changed outside Write/Edit (likely Bash): ${bashOnly.join(", ")}`;
  }
  return scope;
}

/** @param {Scope} scope @returns {ScopeResult} */
function ok(scope) {
  return { ok: true, scope };
}

/** @param {{ code: string, message: string, remediation?: string }} error @returns {ScopeResult} */
function fail(error) {
  return { ok: false, error };
}
