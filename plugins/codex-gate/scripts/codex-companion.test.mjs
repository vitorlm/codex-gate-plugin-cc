import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  cancelHandler,
  resultHandler,
  runTaskWorker,
  spawnBackgroundReview,
  statusHandler,
} from "./codex-companion.mjs";
import { getJob } from "./lib/jobs.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-comp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(extra = {}) {
  let n = 1000;
  return {
    dir,
    now: () => n++,
    id: () => "JOB1",
    sessionId: "s1",
    ...extra,
  };
}

// --- spawnBackgroundReview -------------------------------------------------

test("spawnBackgroundReview creates a job, spawns detached, prints jobId, exits 0", async () => {
  const spawned = [];
  const out = [];
  const d = deps({
    spawn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { pid: 5151, unref() {} };
    },
    write: (s) => out.push(s),
  });
  const code = await spawnBackgroundReview({ kind: "review", argv: ["--session"] }, d);
  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  // detached + ignored stdio (background launch, §7.5)
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].opts.stdio, "ignore");
  // worker is invoked with the task-worker subcommand + jobId
  assert.ok(spawned[0].args.includes("task-worker"));
  assert.ok(spawned[0].args.includes("JOB1"));
  // jobId surfaced to the user
  assert.ok(out.join("").includes("JOB1"));

  const job = await getJob("JOB1", d);
  assert.equal(job.status, "running");
  assert.equal(job.pid, 5151);
  assert.equal(job.kind, "review");
});

// --- runTaskWorker ---------------------------------------------------------

test("runTaskWorker writes the verdict into the job record on success", async () => {
  const d = deps();
  // pre-create the running job (spawnBackgroundReview would have)
  const { createJob } = await import("./lib/jobs.mjs");
  await createJob({ kind: "review", scope: "session", sessionId: "s1", pid: 1 }, d);

  const code = await runTaskWorker("JOB1", d, {
    runReview: async () => ({ ok: true, payload: { verdict: "approve" }, usage: null, scope: {} }),
  });
  assert.equal(code, 0);
  const job = await getJob("JOB1", d);
  assert.equal(job.status, "done");
  assert.deepEqual(job.result, { verdict: "approve" });
});

test("runTaskWorker writes the error envelope into the job on failure", async () => {
  const d = deps();
  const { createJob } = await import("./lib/jobs.mjs");
  await createJob({ kind: "review", scope: "session", sessionId: "s1", pid: 1 }, d);

  const code = await runTaskWorker("JOB1", d, {
    runReview: async () => ({ ok: false, error: { code: "CODEX_ERROR", message: "boom" } }),
  });
  assert.equal(code, 1);
  const job = await getJob("JOB1", d);
  assert.equal(job.status, "error");
  assert.equal(job.error.code, "CODEX_ERROR");
});

test("runTaskWorker never throws to the top — a thrown review is recorded as error", async () => {
  const d = deps();
  const { createJob } = await import("./lib/jobs.mjs");
  await createJob({ kind: "review", scope: "session", sessionId: "s1", pid: 1 }, d);

  const code = await runTaskWorker("JOB1", d, {
    runReview: async () => {
      throw new Error("kaboom");
    },
  });
  assert.equal(code, 1);
  const job = await getJob("JOB1", d);
  assert.equal(job.status, "error");
  assert.match(job.error.message, /kaboom/);
});

// --- statusHandler ---------------------------------------------------------

test("statusHandler with no jobs prints an empty-list message, exits 0", async () => {
  const out = [];
  const code = await statusHandler(undefined, deps({ write: (s) => out.push(s) }));
  assert.equal(code, 0);
  assert.match(out.join(""), /no background jobs/i);
});

test("statusHandler lists jobs newest-first", async () => {
  const d = deps({ write() {} });
  const { createJob } = await import("./lib/jobs.mjs");
  await createJob({ kind: "review", scope: "session", sessionId: "s1" }, d);
  const out = [];
  d.write = (s) => out.push(s);
  const code = await statusHandler(undefined, d);
  assert.equal(code, 0);
  assert.match(out.join(""), /JOB1/);
});

test("statusHandler <jobId> shows a single job; unknown id → exit 1", async () => {
  const out = [];
  const code = await statusHandler("ghost", deps({ write: (s) => out.push(s) }));
  assert.equal(code, 1);
  assert.match(out.join(""), /not found/i);
});

// --- resultHandler ---------------------------------------------------------

test("resultHandler prints the stored verdict of a done job", async () => {
  const d = deps();
  const { createJob, completeJob } = await import("./lib/jobs.mjs");
  await createJob({ kind: "review", scope: "session", sessionId: "s1" }, d);
  await completeJob(
    "JOB1",
    { verdict: "approve", summary: "all good", findings: [], next_steps: [] },
    d,
  );
  const out = [];
  d.write = (s) => out.push(s);
  const code = await resultHandler("JOB1", d);
  assert.equal(code, 0);
  assert.match(out.join(""), /approve/);
});

test("resultHandler on a still-running job reports running, exit code 0", async () => {
  const d = deps();
  const { createJob } = await import("./lib/jobs.mjs");
  await createJob({ kind: "review", scope: "session", sessionId: "s1" }, d);
  const out = [];
  d.write = (s) => out.push(s);
  const code = await resultHandler("JOB1", d);
  assert.equal(code, 0);
  assert.match(out.join(""), /running/i);
});

test("resultHandler on an unknown id → exit 1, not found", async () => {
  const out = [];
  const code = await resultHandler("ghost", deps({ write: (s) => out.push(s) }));
  assert.equal(code, 1);
  assert.match(out.join(""), /not found/i);
});

// --- cancelHandler ---------------------------------------------------------

test("cancelHandler terminates a running job, exit 0", async () => {
  const killed = [];
  const d = deps({ kill: (pid, sig) => killed.push([pid, sig]) });
  const { createJob } = await import("./lib/jobs.mjs");
  await createJob({ kind: "review", scope: "session", sessionId: "s1", pid: 4242 }, d);
  const out = [];
  d.write = (s) => out.push(s);
  const code = await cancelHandler("JOB1", d);
  assert.equal(code, 0);
  assert.deepEqual(killed, [[4242, "SIGTERM"]]);
  const job = await getJob("JOB1", d);
  assert.equal(job.status, "cancelled");
});

test("cancelHandler on an unknown id → exit 1, not found", async () => {
  const out = [];
  const code = await cancelHandler("ghost", deps({ write: (s) => out.push(s), kill() {} }));
  assert.equal(code, 1);
  assert.match(out.join(""), /not found/i);
});
