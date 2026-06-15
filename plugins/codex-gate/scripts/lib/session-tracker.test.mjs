import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { clear, record, touched } from "./session-tracker.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-tracker-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("record then touched returns the recorded path", () => {
  record("s1", "src/a.js", { dir });
  assert.deepEqual(touched("s1", { dir }), ["src/a.js"]);
});

test("touched accumulates multiple paths and de-duplicates", () => {
  record("s1", "src/a.js", { dir });
  record("s1", "src/b.js", { dir });
  record("s1", "src/a.js", { dir }); // duplicate
  assert.deepEqual(touched("s1", { dir }), ["src/a.js", "src/b.js"]);
});

test("touched returns [] for a session that recorded nothing", () => {
  assert.deepEqual(touched("unknown", { dir }), []);
});

test("sessions are isolated from each other", () => {
  record("s1", "a.js", { dir });
  record("s2", "b.js", { dir });
  assert.deepEqual(touched("s1", { dir }), ["a.js"]);
  assert.deepEqual(touched("s2", { dir }), ["b.js"]);
});

test("clear removes a session's touched list", () => {
  record("s1", "a.js", { dir });
  clear("s1", { dir });
  assert.deepEqual(touched("s1", { dir }), []);
});
