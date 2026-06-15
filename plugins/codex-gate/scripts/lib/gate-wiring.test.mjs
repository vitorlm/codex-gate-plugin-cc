import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { freshState, loadState, saveState, stopHookOutput } from "./loop-state.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-gate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("saveState/loadState round-trips per session; missing → fresh", () => {
  assert.deepEqual(loadState("s1", dir), freshState()); // missing → fresh
  const st = { ...freshState(), iteration: 2, tokensSpent: 5000 };
  saveState("s1", dir, st);
  assert.deepEqual(loadState("s1", dir), st);
  assert.deepEqual(loadState("other", dir), freshState()); // isolation
});

test("stopHookOutput: block carries decision+reason; open warns but allows; allow is empty", () => {
  assert.deepEqual(stopHookOutput("block", "blockers"), { decision: "block", reason: "blockers" });
  const open = stopHookOutput("open", "no progress");
  assert.equal(open.decision, undefined); // stop is allowed
  assert.match(open.systemMessage, /no progress/);
  assert.deepEqual(stopHookOutput("allow", "x"), {});
});
