import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { cancelJob, createJob, getJob, listJobs } from "./lib/jobs.mjs";
import { terminateSessionJobs } from "./session-lifecycle-hook.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-life-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(extra = {}) {
  let n = 1000;
  return { dir, now: () => n++, ...extra };
}

test("terminateSessionJobs cancels only this session's running jobs", async () => {
  const killed = [];
  const d = deps({ kill: (pid, sig) => killed.push([pid, sig]) });

  await createJob(
    { kind: "review", scope: "session", sessionId: "ending", pid: 111 },
    { ...d, id: () => "a" },
  );
  await createJob(
    { kind: "review", scope: "session", sessionId: "other", pid: 222 },
    { ...d, id: () => "b" },
  );

  await terminateSessionJobs("ending", d);

  assert.equal((await getJob("a", d)).status, "cancelled");
  assert.equal((await getJob("b", d)).status, "running"); // other session untouched
  assert.deepEqual(killed, [[111, "SIGTERM"]]);
});

test("terminateSessionJobs leaves already-finished jobs alone", async () => {
  const killed = [];
  const d = deps({ kill: (pid, sig) => killed.push([pid, sig]) });
  await createJob(
    { kind: "review", scope: "session", sessionId: "ending", pid: 333 },
    { ...d, id: () => "c" },
  );
  await cancelJob("c", d);
  killed.length = 0;

  await terminateSessionJobs("ending", d);
  assert.deepEqual(killed, []); // already cancelled — not killed again
});

test("terminateSessionJobs is a no-op when the session has no jobs", async () => {
  const d = deps({ kill() {} });
  await terminateSessionJobs("nobody", d);
  assert.deepEqual(await listJobs(d), []);
});
