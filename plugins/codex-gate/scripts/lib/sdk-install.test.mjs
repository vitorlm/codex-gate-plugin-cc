import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { depsInstalled, ensureDeps } from "./sdk-install.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-deps-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** @param {string[]} pkgs relative node_modules subpaths to mark present */
function placePkgs(...pkgs) {
  for (const p of pkgs) {
    const pkgDir = join(dir, "node_modules", ...p.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), "{}");
  }
}

test("depsInstalled is false when neither dep is present", () => {
  assert.equal(depsInstalled(dir), false);
});

test("depsInstalled is false when only the SDK is present (ajv missing)", () => {
  placePkgs("@openai/codex-sdk");
  assert.equal(depsInstalled(dir), false);
});

test("depsInstalled is false when only ajv is present (SDK missing)", () => {
  placePkgs("ajv");
  assert.equal(depsInstalled(dir), false);
});

test("depsInstalled is true only when BOTH the SDK and ajv are present", () => {
  placePkgs("@openai/codex-sdk", "ajv");
  assert.equal(depsInstalled(dir), true);
});

test("ensureDeps skips install when both present, installs once when absent", async () => {
  let installs = 0;
  const install = async () => {
    installs++;
  };
  const present = await ensureDeps(dir, { installed: () => true, install });
  assert.equal(present.ok, true);
  assert.equal(present.installed, false);
  assert.equal(installs, 0);

  const absent = await ensureDeps(dir, { installed: () => false, install });
  assert.equal(absent.ok, true);
  assert.equal(absent.installed, true);
  assert.equal(installs, 1);
});

test("ensureDeps reports a structured error when install fails", async () => {
  const r = await ensureDeps(dir, {
    installed: () => false,
    install: async () => {
      throw new Error("npm exploded");
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "CODEX_ERROR");
  assert.match(r.error.remediation, /setup/i);
});
