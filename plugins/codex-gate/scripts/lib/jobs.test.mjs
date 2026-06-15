import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  cancelJob,
  completeJob,
  createJob,
  getJob,
  listJobs,
  pruneJobs,
  reconcileJob,
  updateJob,
} from "./jobs.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-jobs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A deterministic clock + id generator so tests never depend on Date.now. */
function fakeDeps(t = 1000, id = "job-1") {
  let now = t;
  return {
    dir,
    now: () => now,
    id: () => id,
    tick: (ms) => {
      now += ms;
    },
    setId: (v) => {
      id = v;
    },
    get _id() {
      return id;
    },
  };
}

test("createJob persists a running record with injected id + timestamps", async () => {
  const d = fakeDeps(5000, "abc");
  const job = await createJob({ kind: "review", scope: "session", sessionId: "s1", pid: 4242 }, d);
  assert.equal(job.id, "abc");
  assert.equal(job.status, "running");
  assert.equal(job.kind, "review");
  assert.equal(job.scope, "session");
  assert.equal(job.sessionId, "s1");
  assert.equal(job.pid, 4242);
  assert.equal(job.createdAt, 5000);
  assert.equal(job.updatedAt, 5000);

  const fetched = await getJob("abc", d);
  assert.deepEqual(fetched, job);
});

test("getJob returns null for an unknown id", async () => {
  assert.equal(await getJob("nope", fakeDeps()), null);
});

test("completeJob stores the result and flips status to done", async () => {
  const d = fakeDeps(1000, "j");
  await createJob({ kind: "review", scope: "session", sessionId: "s1" }, d);
  d.tick(50);
  const done = await completeJob("j", { verdict: "approve", summary: "ok" }, d);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result, { verdict: "approve", summary: "ok" });
  assert.equal(done.updatedAt, 1050);
  assert.equal(done.createdAt, 1000);
});

test("completeJob with an error envelope flips status to error", async () => {
  const d = fakeDeps(1000, "j");
  await createJob({ kind: "review", scope: "session", sessionId: "s1" }, d);
  const errored = await completeJob("j", null, d, { code: "CODEX_ERROR", message: "boom" });
  assert.equal(errored.status, "error");
  assert.deepEqual(errored.error, { code: "CODEX_ERROR", message: "boom" });
  assert.equal(errored.result, undefined);
});

test("updateJob merges fields and bumps updatedAt", async () => {
  const d = fakeDeps(1000, "j");
  await createJob({ kind: "review", scope: "session", sessionId: "s1" }, d);
  d.tick(10);
  const updated = await updateJob("j", { pid: 9999 }, d);
  assert.equal(updated.pid, 9999);
  assert.equal(updated.updatedAt, 1010);
});

test("listJobs returns newest-first by updatedAt", async () => {
  const d = fakeDeps(1000, "a");
  await createJob({ kind: "review", scope: "session", sessionId: "s1" }, d);
  d.tick(100);
  d.setId("b");
  await createJob({ kind: "review", scope: "session", sessionId: "s1" }, d);
  const jobs = await listJobs(d);
  assert.deepEqual(
    jobs.map((j) => j.id),
    ["b", "a"],
  );
});

test("listJobs can filter by sessionId", async () => {
  const d = fakeDeps(1000, "a");
  await createJob({ kind: "review", scope: "session", sessionId: "s1" }, d);
  d.setId("b");
  await createJob({ kind: "review", scope: "session", sessionId: "s2" }, d);
  const s1 = await listJobs(d, { sessionId: "s1" });
  assert.deepEqual(
    s1.map((j) => j.id),
    ["a"],
  );
});

test("cancelJob kills a live worker pid and marks cancelled", async () => {
  const d = fakeDeps(1000, "j");
  const killed = [];
  d.kill = (pid, sig) => killed.push([pid, sig]);
  await createJob({ kind: "review", scope: "session", sessionId: "s1", pid: 7777 }, d);
  const cancelled = await cancelJob("j", d);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(killed, [[7777, "SIGTERM"]]);
});

test("cancelJob on a finished job is a no-op (does not kill)", async () => {
  const d = fakeDeps(1000, "j");
  const killed = [];
  d.kill = (pid, sig) => killed.push([pid, sig]);
  await createJob({ kind: "review", scope: "session", sessionId: "s1", pid: 7777 }, d);
  await completeJob("j", { verdict: "approve" }, d);
  const result = await cancelJob("j", d);
  assert.equal(result.status, "done");
  assert.deepEqual(killed, []); // already done — never killed
});

test("cancelJob returns null for an unknown id", async () => {
  assert.equal(await cancelJob("nope", fakeDeps()), null);
});

test("pruneJobs caps to maxJobs, dropping oldest by updatedAt", async () => {
  const d = fakeDeps(1000, "a");
  for (const id of ["a", "b", "c", "d"]) {
    d.setId(id);
    await createJob({ kind: "review", scope: "session", sessionId: "s1" }, d);
    d.tick(10);
  }
  await pruneJobs(d, { maxJobs: 2 });
  const remaining = await listJobs(d);
  assert.deepEqual(
    remaining.map((j) => j.id),
    ["d", "c"],
  ); // newest two kept
});

test("reconcileJob flips a running job with a dead pid to error", async () => {
  const d = fakeDeps(1000, "j");
  d.isAlive = () => false; // simulate dead/zombie worker
  await createJob({ kind: "review", scope: "session", sessionId: "s1", pid: 999999 }, d);
  const reconciled = await reconcileJob("j", d);
  assert.equal(reconciled.status, "error");
  assert.equal(reconciled.error.code, "CODEX_ERROR");
  assert.match(reconciled.error.message, /worker/i);
});

test("reconcileJob leaves a running job with a live pid untouched", async () => {
  const d = fakeDeps(1000, "j");
  d.isAlive = () => true;
  await createJob({ kind: "review", scope: "session", sessionId: "s1", pid: 4242 }, d);
  const reconciled = await reconcileJob("j", d);
  assert.equal(reconciled.status, "running");
});

test("listJobs reconciles orphaned running jobs (dead pid) to error", async () => {
  const d = fakeDeps(1000, "j");
  d.isAlive = () => false;
  await createJob({ kind: "review", scope: "session", sessionId: "s1", pid: 999999 }, d);
  const jobs = await listJobs(d, { reconcile: true });
  assert.equal(jobs[0].status, "error");
});
