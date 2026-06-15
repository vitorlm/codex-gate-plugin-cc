import assert from "node:assert/strict";
import { test } from "node:test";
import { composePrompt, loadTemplate, scopeSection } from "./prompts.mjs";

test("scopeSection lists target files for file/diff scopes", () => {
  const s = scopeSection({ mode: "files", targets: ["src/a.js", "src/b.js"] });
  assert.match(s, /src\/a\.js/);
  assert.match(s, /src\/b\.js/);
});

test("scopeSection fences pasted text for text scope", () => {
  const s = scopeSection({ mode: "text", text: "const x = 1", targets: [] });
  assert.match(s, /const x = 1/);
  assert.match(s, /```/);
});

test("scopeSection surfaces a coverage warning when present", () => {
  const s = scopeSection({
    mode: "session",
    targets: ["a.js"],
    coverageNote: "tracker-only (Bash edits not detectable)",
  });
  assert.match(s, /tracker-only/);
});

test("composePrompt joins the template with the scope section", () => {
  const out = composePrompt({
    kind: "review",
    scope: { mode: "files", targets: ["a.js"] },
    template: "TEMPLATE_BODY",
  });
  assert.match(out, /TEMPLATE_BODY/);
  assert.match(out, /a\.js/);
});

test("composePrompt appends an adversarial focus directive", () => {
  const out = composePrompt({
    kind: "adversarial",
    scope: { mode: "text", text: "design", targets: [] },
    focus: "the token budget",
    template: "T",
  });
  assert.match(out, /focus/i);
  assert.match(out, /the token budget/);
});

test("loadTemplate reads the real review template", () => {
  const t = loadTemplate("review");
  assert.match(t, /reviewer/i);
  assert.ok(t.length > 50);
});

test("loadTemplate reads the real adversarial template", () => {
  const t = loadTemplate("adversarial");
  assert.match(t, /challenge/i);
});
