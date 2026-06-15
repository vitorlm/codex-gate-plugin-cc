import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readJson, withLock, writeJsonAtomic } from "./statelock.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("writeJsonAtomic writes JSON that reads back, leaving no temp files", () => {
  const file = join(dir, "state.json");
  writeJsonAtomic(file, { a: 1, b: [2, 3] });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1, b: [2, 3] });
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes(".tmp")),
    [],
  );
});

test("readJson returns the fallback when the file is absent", () => {
  assert.deepEqual(readJson(join(dir, "missing.json"), { fallback: true }), { fallback: true });
});

test("withLock runs the function, returns its result, and releases the lock", async () => {
  const lock = join(dir, "x.lock");
  const result = await withLock(lock, () => 42);
  assert.equal(result, 42);
  assert.equal(existsSync(lock), false);
});

test("withLock breaks a stale lock held by a dead pid", async () => {
  const lock = join(dir, "x.lock");
  writeFileSync(lock, JSON.stringify({ pid: 999999, time: Date.now() }));
  const result = await withLock(lock, () => "acquired", { timeoutMs: 500 });
  assert.equal(result, "acquired");
});

test("withLock breaks a lock whose mtime/time is older than staleMs", async () => {
  const lock = join(dir, "x.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, time: 0 })); // epoch = very old
  const result = await withLock(lock, () => "acquired", { staleMs: 1000, timeoutMs: 500 });
  assert.equal(result, "acquired");
});

test("withLock times out when a fresh lock is held by a live process", async () => {
  const lock = join(dir, "x.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, time: Date.now() }));
  await assert.rejects(
    () => withLock(lock, () => "nope", { staleMs: 60000, timeoutMs: 150, retryMs: 20 }),
    /lock/i,
  );
});

test("concurrent withLock calls on the same lock are serialized (no interleave)", async () => {
  const lock = join(dir, "x.lock");
  const events = [];
  const job = (id) =>
    withLock(
      lock,
      async () => {
        events.push(`start-${id}`);
        await new Promise((r) => setTimeout(r, 20));
        events.push(`end-${id}`);
      },
      { retryMs: 5, timeoutMs: 2000 },
    );
  await Promise.all([job("a"), job("b")]);
  // Each critical section completes before the next starts.
  const starts = events.filter((e) => e.startsWith("start"));
  const ends = events.filter((e) => e.startsWith("end"));
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.equal(events[1].startsWith("end"), true); // start,end,start,end — not start,start
});
