import { createHash } from "node:crypto";
import { basename, join } from "node:path";

/**
 * Per-workspace persisted state directory helper (§7.5). Pure/deterministic:
 * resolves `${base}/state/<workspace-slug>-<hash>` from a workspace path so jobs
 * from different workspaces never collide, even with the same basename. The base
 * dir is injectable for tests; runtime default is `${CLAUDE_PLUGIN_DATA}`.
 */

/**
 * Deterministic slug for a workspace: sanitized basename + 8-hex of the absolute
 * path (disambiguates identical basenames in different directories).
 * @param {string} workspacePath
 * @returns {string}
 */
export function workspaceSlug(workspacePath) {
  const slug =
    basename(workspacePath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(workspacePath).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

/**
 * Resolve the per-workspace state directory, or null when no base dir is set.
 * @param {string} workspacePath
 * @param {{ baseDir?: string|null }} [opts]
 * @returns {string|null}
 */
export function workspaceStateDir(workspacePath, opts = {}) {
  const baseDir = "baseDir" in opts ? opts.baseDir : (process.env.CLAUDE_PLUGIN_DATA ?? null);
  if (!baseDir) return null;
  return join(baseDir, "state", workspaceSlug(workspacePath));
}
