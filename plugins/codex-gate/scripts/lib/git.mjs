import { spawnSync } from "node:child_process";

/**
 * Default command runner. Injected in tests so Git ops stay unit-testable.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
export function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * @param {string} cwd
 * @param {typeof defaultRun} [run]
 * @returns {boolean}
 */
export function isGitRepo(cwd, run = defaultRun) {
  const { code, stdout } = run("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  return code === 0 && stdout.trim() === "true";
}

/**
 * Files with working-tree changes (modified, staged, or untracked). Repo-relative.
 * @param {string} cwd
 * @param {typeof defaultRun} [run]
 * @returns {string[]}
 */
export function changedFiles(cwd, run = defaultRun) {
  const { stdout } = run("git", ["-C", cwd, "status", "--porcelain"]);
  /** @type {string[]} */
  const files = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const rest = line.slice(3); // strip the 2-char status + space
    const arrow = rest.indexOf(" -> ");
    files.push(arrow >= 0 ? rest.slice(arrow + 4) : rest);
  }
  return files;
}

/**
 * Files changed between merge-base(base, HEAD) and HEAD (three-dot diff). Repo-relative.
 * @param {string} base
 * @param {string} cwd
 * @param {typeof defaultRun} [run]
 * @returns {string[]}
 */
export function diffFiles(base, cwd, run = defaultRun) {
  const { stdout } = run("git", ["-C", cwd, "diff", "--name-only", `${base}...HEAD`]);
  return stdout.split("\n").filter((l) => l.trim());
}
