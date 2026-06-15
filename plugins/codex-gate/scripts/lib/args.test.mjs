import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.mjs";

test("positional args become files; flags default off", () => {
  const a = parseArgs(["src/a.js", "src/b.js"]);
  assert.deepEqual(a.files, ["src/a.js", "src/b.js"]);
  assert.equal(a.session, false);
  assert.equal(a.base, null);
  assert.equal(a.json, false);
  assert.equal(a.background, false);
});

test("--session sets the session flag", () => {
  assert.equal(parseArgs(["--session"]).session, true);
});

test("--base consumes the next token as the ref", () => {
  assert.equal(parseArgs(["--base", "main"]).base, "main");
});

test("--model and --focus consume their values", () => {
  const a = parseArgs(["--model", "mini", "--focus", "concurrency"]);
  assert.equal(a.model, "mini");
  assert.equal(a.focus, "concurrency");
});

test("--text consumes the next token as inline text", () => {
  assert.equal(parseArgs(["--text", "review this snippet"]).text, "review this snippet");
});

test("--background and --json are booleans", () => {
  const a = parseArgs(["--background", "--json"]);
  assert.equal(a.background, true);
  assert.equal(a.json, true);
});

test("mixed flags and positionals parse together", () => {
  const a = parseArgs(["--session", "--model", "mini", "--json", "extra.js"]);
  assert.equal(a.session, true);
  assert.equal(a.model, "mini");
  assert.equal(a.json, true);
  assert.deepEqual(a.files, ["extra.js"]);
});

test("an unknown flag throws", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown flag/i);
});

test("a value-flag missing its value throws", () => {
  assert.throws(() => parseArgs(["--base"]), /requires a value/i);
});
