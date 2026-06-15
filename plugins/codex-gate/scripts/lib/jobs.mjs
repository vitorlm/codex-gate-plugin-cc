import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, withLock, writeJsonAtomic } from "./statelock.mjs";

/**
 * Background job lifecycle over `statelock` (atomic writes + advisory lock, §4.4).
 * One record per file at `<dir>/jobs/<id>.json`; mutations serialize on a single
 * `<dir>/jobs.lock`. Clock + id generator + pid liveness are injected so tests are
 * deterministic and never spawn a real process.
 *
 * @typedef {{
 *   id: string,
 *   status: "running"|"done"|"error"|"cancelled",
 *   pid?: number,
 *   kind: "review"|"adversarial",
 *   scope: string,
 *   createdAt: number,
 *   updatedAt: number,
 *   sessionId: string,
 *   result?: unknown,
 *   error?: { code: string, message: string, remediation?: string },
 * }} Job
 *
 * @typedef {{
 *   dir: string,
 *   now?: () => number,
 *   id?: () => string,
 *   kill?: (pid: number, signal: string|number) => void,
 *   isAlive?: (pid: number) => boolean,
 * }} JobDeps
 */

/** @param {JobDeps} deps */
function jobsDir(deps) {
  return join(deps.dir, "jobs");
}

/** @param {JobDeps} deps @param {string} id */
function jobPath(deps, id) {
  return join(jobsDir(deps), `${id}.json`);
}

/** @param {JobDeps} deps */
function lockPath(deps) {
  return join(deps.dir, "jobs.lock");
}

/** @param {JobDeps} deps @returns {number} */
function clock(deps) {
  return (deps.now ?? Date.now)();
}

/** @param {number} pid @returns {boolean} */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/**
 * Create a running job record. `pid` is optional (set once the worker is spawned).
 * @param {{ kind: "review"|"adversarial", scope: string, sessionId: string, pid?: number }} spec
 * @param {JobDeps} deps
 * @returns {Promise<Job>}
 */
export async function createJob(spec, deps) {
  const id = (deps.id ?? (() => String(clock(deps))))();
  const ts = clock(deps);
  /** @type {Job} */
  const job = {
    id,
    status: "running",
    kind: spec.kind,
    scope: spec.scope,
    sessionId: spec.sessionId,
    createdAt: ts,
    updatedAt: ts,
  };
  if (spec.pid !== undefined) job.pid = spec.pid;
  return withLock(lockPath(deps), () => {
    mkdirSync(jobsDir(deps), { recursive: true });
    writeJsonAtomic(jobPath(deps, id), job);
    return job;
  });
}

/**
 * Read a single job (no lock needed — atomic writes prevent torn reads).
 * @param {string} id @param {JobDeps} deps @returns {Promise<Job|null>}
 */
export async function getJob(id, deps) {
  return readJson(jobPath(deps, id), null);
}

/**
 * Merge fields into a job and bump `updatedAt` (under the lock).
 * @param {string} id @param {Partial<Job>} patch @param {JobDeps} deps
 * @returns {Promise<Job|null>}
 */
export async function updateJob(id, patch, deps) {
  return withLock(lockPath(deps), () => {
    /** @type {Job|null} */
    const job = readJson(jobPath(deps, id), null);
    if (!job) return null;
    const next = { ...job, ...patch, updatedAt: clock(deps) };
    writeJsonAtomic(jobPath(deps, id), next);
    return next;
  });
}

/**
 * Terminal write: store a result (status `done`) or an error envelope (status `error`).
 * @param {string} id
 * @param {unknown} result
 * @param {JobDeps} deps
 * @param {{ code: string, message: string, remediation?: string }} [error]
 * @returns {Promise<Job|null>}
 */
export async function completeJob(id, result, deps, error) {
  const patch = error
    ? { status: /** @type {const} */ ("error"), error }
    : { status: /** @type {const} */ ("done"), result };
  return updateJob(id, patch, deps);
}

/**
 * Cancel a job: terminate a live worker pid (SIGTERM) and mark `cancelled`.
 * No-op (no kill) when the job is already finished or unknown.
 * @param {string} id @param {JobDeps} deps @returns {Promise<Job|null>}
 */
export async function cancelJob(id, deps) {
  return withLock(lockPath(deps), () => {
    /** @type {Job|null} */
    const job = readJson(jobPath(deps, id), null);
    if (!job) return null;
    if (job.status !== "running") return job; // already terminal — never kill
    if (job.pid) {
      try {
        (deps.kill ?? process.kill)(job.pid, "SIGTERM");
      } catch {
        /* worker already gone */
      }
    }
    const next = { ...job, status: /** @type {const} */ ("cancelled"), updatedAt: clock(deps) };
    writeJsonAtomic(jobPath(deps, id), next);
    return next;
  });
}

/**
 * Reconcile an orphaned/zombie worker: a `running` job whose pid is dead is flipped
 * to `error` (the worker died without writing a terminal record).
 * @param {string} id @param {JobDeps} deps @returns {Promise<Job|null>}
 */
export async function reconcileJob(id, deps) {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  return withLock(lockPath(deps), () => {
    /** @type {Job|null} */
    const job = readJson(jobPath(deps, id), null);
    if (!job) return null;
    if (job.status !== "running" || job.pid === undefined || isAlive(job.pid)) return job;
    const next = {
      ...job,
      status: /** @type {const} */ ("error"),
      error: { code: "CODEX_ERROR", message: "background worker died without a result" },
      updatedAt: clock(deps),
    };
    writeJsonAtomic(jobPath(deps, id), next);
    return next;
  });
}

/** @param {JobDeps} deps @returns {Job[]} */
function readAll(deps) {
  /** @type {Job[]} */
  const jobs = [];
  let names;
  try {
    names = readdirSync(jobsDir(deps));
  } catch {
    return jobs;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const job = readJson(join(jobsDir(deps), name), null);
    if (job) jobs.push(job);
  }
  return jobs;
}

/**
 * List jobs newest-first by `updatedAt`. Optionally filter by `sessionId` and
 * reconcile orphaned running jobs (dead pid → error).
 * @param {JobDeps} deps
 * @param {{ sessionId?: string, reconcile?: boolean }} [opts]
 * @returns {Promise<Job[]>}
 */
export async function listJobs(deps, opts = {}) {
  if (opts.reconcile) {
    for (const job of readAll(deps)) {
      if (job.status === "running") await reconcileJob(job.id, deps);
    }
  }
  let jobs = readAll(deps);
  if (opts.sessionId !== undefined) jobs = jobs.filter((j) => j.sessionId === opts.sessionId);
  jobs.sort((a, b) => b.updatedAt - a.updatedAt);
  return jobs;
}

/**
 * Cap stored jobs to `maxJobs`, dropping the oldest (by `updatedAt`).
 * @param {JobDeps} deps @param {{ maxJobs: number }} opts @returns {Promise<void>}
 */
export async function pruneJobs(deps, { maxJobs }) {
  await withLock(lockPath(deps), () => {
    const jobs = readAll(deps).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const job of jobs.slice(maxJobs)) {
      rmSync(jobPath(deps, job.id), { force: true });
    }
  });
}
