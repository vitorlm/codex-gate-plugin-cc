import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

let tmpCounter = 0;

/**
 * Atomically write JSON: write a temp sibling, then rename over the target
 * (rename is atomic on the same filesystem). Avoids torn reads from concurrent readers.
 * @param {string} filePath
 * @param {unknown} obj
 */
export function writeJsonAtomic(filePath, obj) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${tmpCounter++}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, filePath);
}

/**
 * Read + parse JSON, returning `fallback` if the file is absent or unparseable.
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {T|any}
 */
export function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

/** @param {number} pid @returns {boolean} */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** @param {string} lockPath @param {number} staleMs @returns {boolean} */
function isStale(lockPath, staleMs) {
  let info;
  try {
    info = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return true; // gone or corrupt → safe to break
  }
  if (info.pid && !isAlive(info.pid)) return true;
  if (Date.now() - (info.time ?? 0) > staleMs) return true;
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > staleMs) return true;
  } catch {
    return true;
  }
  return false;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding an advisory lockfile. Breaks a stale lock (dead holder
 * pid, or age beyond `staleMs`); otherwise retries until `timeoutMs`, then throws.
 * @template T
 * @param {string} lockPath
 * @param {() => T | Promise<T>} fn
 * @param {{ staleMs?: number, timeoutMs?: number, retryMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, fn, opts = {}) {
  const { staleMs = 10000, timeoutMs = 5000, retryMs = 50 } = opts;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx"); // exclusive create
      writeSync(fd, JSON.stringify({ pid: process.pid, time: Date.now() }));
      closeSync(fd);
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      if (isStale(lockPath, staleMs)) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already broken by someone else */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`could not acquire lock ${lockPath} within ${timeoutMs}ms`);
      }
      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* nothing to release */
    }
  }
}
