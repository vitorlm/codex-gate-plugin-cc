import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-session touched-files list, newline-delimited at `<dir>/<sessionId>.touched`.
 * The PostToolUse hook calls `record` (append-only, minimal work); scope resolution
 * reads via `touched`; SessionEnd calls `clear`.
 */

/** @param {string} dir @param {string} sessionId */
function listPath(dir, sessionId) {
  return join(dir, `${sessionId}.touched`);
}

/**
 * Append a touched file path (no parsing, no dedup — kept minimal for the hook).
 * @param {string} sessionId
 * @param {string} filePath
 * @param {{ dir: string }} opts
 */
export function record(sessionId, filePath, { dir }) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(listPath(dir, sessionId), `${filePath}\n`);
}

/**
 * Read the de-duplicated list of files this session touched (order preserved).
 * @param {string} sessionId
 * @param {{ dir: string }} opts
 * @returns {string[]}
 */
export function touched(sessionId, { dir }) {
  let raw;
  try {
    raw = readFileSync(listPath(dir, sessionId), "utf8");
  } catch {
    return [];
  }
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const line of raw.split("\n")) {
    const p = line.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Remove a session's touched list (SessionEnd cleanup).
 * @param {string} sessionId
 * @param {{ dir: string }} opts
 */
export function clear(sessionId, { dir }) {
  rmSync(listPath(dir, sessionId), { force: true });
}
