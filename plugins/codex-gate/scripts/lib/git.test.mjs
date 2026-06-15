import assert from "node:assert/strict";
import { test } from "node:test";
import { changedFiles, diffFiles, isGitRepo } from "./git.mjs";

/** Build a fake `run` that dispatches on the git subcommand. */
function fakeRun(table) {
  return (_cmd, args) => {
    const key = args.find((a) => ["rev-parse", "status", "diff"].includes(a));
    const entry = table[key];
    if (!entry) return { code: 1, stdout: "", stderr: "no stub" };
    return { code: 0, stdout: "", stderr: "", ...entry };
  };
}

test("isGitRepo is true when rev-parse reports inside-work-tree", () => {
  const run = fakeRun({ "rev-parse": { stdout: "true\n" } });
  assert.equal(isGitRepo("/repo", run), true);
});

test("isGitRepo is false when rev-parse fails (not a repo)", () => {
  const run = fakeRun({ "rev-parse": { code: 128, stdout: "", stderr: "fatal" } });
  assert.equal(isGitRepo("/x", run), false);
});

test("changedFiles parses porcelain output, taking the new name on renames", () => {
  const run = fakeRun({
    status: { stdout: " M src/a.js\n?? new.txt\nR  old.js -> src/b.js\n" },
  });
  assert.deepEqual(changedFiles("/repo", run), ["src/a.js", "new.txt", "src/b.js"]);
});

test("changedFiles returns [] on a clean tree", () => {
  const run = fakeRun({ status: { stdout: "" } });
  assert.deepEqual(changedFiles("/repo", run), []);
});

test("diffFiles lists files changed in base...HEAD (merge-base diff)", () => {
  let capturedArgs = null;
  const run = (_cmd, args) => {
    capturedArgs = args;
    return { code: 0, stdout: "src/a.js\nsrc/c.js\n", stderr: "" };
  };
  assert.deepEqual(diffFiles("main", "/repo", run), ["src/a.js", "src/c.js"]);
  assert.ok(capturedArgs.includes("main...HEAD"));
  assert.ok(capturedArgs.includes("--name-only"));
});
