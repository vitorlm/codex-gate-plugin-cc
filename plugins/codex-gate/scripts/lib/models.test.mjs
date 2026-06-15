import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODEL, resolveModel } from "./models.mjs";

test("resolveModel with no input returns the default", () => {
  assert.equal(resolveModel(), DEFAULT_MODEL);
  assert.equal(resolveModel(null), DEFAULT_MODEL);
  assert.equal(resolveModel(""), DEFAULT_MODEL);
});

test("resolveModel expands the 'mini' alias", () => {
  assert.equal(resolveModel("mini"), "gpt-5.4-mini");
});

test("resolveModel expands the 'default' alias", () => {
  assert.equal(resolveModel("default"), DEFAULT_MODEL);
});

test("resolveModel passes through an explicit model id", () => {
  assert.equal(resolveModel("gpt-5.5"), "gpt-5.5");
  assert.equal(resolveModel("o4-mini"), "o4-mini");
});
