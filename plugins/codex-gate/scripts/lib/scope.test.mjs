import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveScope } from "./scope.mjs";

function deps({ isRepo = false, changed = [], diff = [], tracked = [] } = {}) {
  return {
    sessionId: "s1",
    git: {
      isGitRepo: () => isRepo,
      changedFiles: () => changed,
      diffFiles: () => diff,
    },
    tracker: { touched: () => tracked },
  };
}

test("explicit files take precedence and use no Git", () => {
  const r = resolveScope({ files: ["a.js", "b.js"], cwd: "/repo" }, deps({ isRepo: true }));
  assert.equal(r.ok, true);
  assert.equal(r.scope.mode, "files");
  assert.equal(r.scope.git, false);
  assert.equal(r.scope.coverage, "explicit");
  assert.deepEqual(r.scope.targets, ["a.js", "b.js"]);
});

test("pasted text is reviewed as-is, no Git", () => {
  const r = resolveScope({ text: "some diff", cwd: "/repo" }, deps({ isRepo: true }));
  assert.equal(r.scope.mode, "text");
  assert.equal(r.scope.coverage, "text");
  assert.equal(r.scope.text, "some diff");
});

test("session in a Git repo augments tracker with Bash-edited files (git-augmented + note)", () => {
  const r = resolveScope(
    { session: true, cwd: "/repo" },
    deps({ isRepo: true, tracked: ["a.js"], changed: ["a.js", "gen.js"] }),
  );
  assert.equal(r.scope.mode, "session");
  assert.equal(r.scope.git, true);
  assert.equal(r.scope.coverage, "git-augmented");
  assert.deepEqual(r.scope.targets, ["a.js", "gen.js"]);
  assert.match(r.scope.coverageNote, /gen\.js/);
});

test("session in a Git repo with no Bash-only changes has no augmentation note", () => {
  const r = resolveScope(
    { session: true, cwd: "/repo" },
    deps({ isRepo: true, tracked: ["a.js"], changed: ["a.js"] }),
  );
  assert.equal(r.scope.coverage, "git-augmented");
  assert.equal(r.scope.coverageNote, undefined);
});

test("session outside a Git repo is tracker-only with a visible warning", () => {
  const r = resolveScope({ session: true, cwd: "/x" }, deps({ isRepo: false, tracked: ["a.js"] }));
  assert.equal(r.scope.coverage, "tracker-only");
  assert.match(r.scope.coverageNote, /Bash edits not detectable/i);
  assert.deepEqual(r.scope.targets, ["a.js"]);
});

test("--base resolves to the merge-base diff (requires Git)", () => {
  const r = resolveScope(
    { base: "main", cwd: "/repo" },
    deps({ isRepo: true, diff: ["a.js", "c.js"] }),
  );
  assert.equal(r.scope.mode, "base");
  assert.equal(r.scope.coverage, "diff");
  assert.deepEqual(r.scope.targets, ["a.js", "c.js"]);
});

test("--base outside a Git repo is a NO_SCOPE error", () => {
  const r = resolveScope({ base: "main", cwd: "/x" }, deps({ isRepo: false }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "NO_SCOPE");
});

test("default stop-gate resolves like session", () => {
  const r = resolveScope(
    { defaultMode: "stop-gate", cwd: "/x" },
    deps({ isRepo: false, tracked: ["a.js"] }),
  );
  assert.equal(r.scope.mode, "session");
  assert.deepEqual(r.scope.targets, ["a.js"]);
});

test("default manual inside Git uses the working-tree diff", () => {
  const r = resolveScope(
    { defaultMode: "manual", cwd: "/repo" },
    deps({ isRepo: true, changed: ["a.js"] }),
  );
  assert.equal(r.scope.mode, "diff");
  assert.equal(r.scope.coverage, "diff");
  assert.deepEqual(r.scope.targets, ["a.js"]);
});

test("default manual outside Git is a NO_SCOPE error with remediation", () => {
  const r = resolveScope({ defaultMode: "manual", cwd: "/x" }, deps({ isRepo: false }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "NO_SCOPE");
  assert.ok(r.error.remediation);
});

test("no inputs and no default is a NO_SCOPE error", () => {
  const r = resolveScope({ cwd: "/x" }, deps({ isRepo: false }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "NO_SCOPE");
});
