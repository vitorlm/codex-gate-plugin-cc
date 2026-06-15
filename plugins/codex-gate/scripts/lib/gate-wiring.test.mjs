import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { freshState, loadState, saveState, stopHookOutput } from "./loop-state.mjs";
import { ensureSdk, sdkInstalled } from "./sdk-install.mjs";

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

test("sdkInstalled is false when absent, true once the SDK package.json exists", () => {
  assert.equal(sdkInstalled(dir), false);
  const pkgDir = join(dir, "node_modules", "@openai", "codex-sdk");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), "{}");
  assert.equal(sdkInstalled(dir), true);
});

test("ensureSdk skips install when present, installs once when absent", async () => {
  let installs = 0;
  const install = async () => {
    installs++;
  };
  const present = await ensureSdk(dir, { installed: () => true, install });
  assert.equal(present.installed, false);
  assert.equal(installs, 0);

  const absent = await ensureSdk(dir, { installed: () => false, install });
  assert.equal(absent.ok, true);
  assert.equal(absent.installed, true);
  assert.equal(installs, 1);
});

test("ensureSdk reports a structured error when install fails", async () => {
  const r = await ensureSdk(dir, {
    installed: () => false,
    install: async () => {
      throw new Error("npm exploded");
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "CODEX_ERROR");
  assert.match(r.error.remediation, /setup/i);
});
