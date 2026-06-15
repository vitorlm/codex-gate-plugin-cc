import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadCodex } from "./sdk-load.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-sdkload-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Lay down a fake @openai/codex-sdk package under <dir>/node_modules. */
function fakeSdk(exportsField) {
  const pkgDir = join(dir, "node_modules", "@openai", "codex-sdk");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "dist-index.js"),
    "export class Codex { constructor() { this.tag = 'fake'; } }\n",
  );
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@openai/codex-sdk", type: "module", ...exportsField }),
  );
}

test("loadCodex resolves the Codex class from the data dir via the exports map", async () => {
  fakeSdk({ exports: { ".": { import: "./dist-index.js" } } });
  const Codex = await loadCodex(dir);
  assert.equal(typeof Codex, "function");
  assert.equal(new Codex().tag, "fake");
});

test("loadCodex falls back to package.json main when no exports map", async () => {
  fakeSdk({ main: "dist-index.js" });
  const Codex = await loadCodex(dir);
  assert.equal(new Codex().tag, "fake");
});

test("loadCodex falls back to the bare specifier when the data dir has no SDK (dev)", async () => {
  // empty data dir → falls back to import("@openai/codex-sdk") resolved from dev node_modules
  const Codex = await loadCodex(dir);
  assert.equal(typeof Codex, "function"); // the real SDK's Codex class in dev
});
