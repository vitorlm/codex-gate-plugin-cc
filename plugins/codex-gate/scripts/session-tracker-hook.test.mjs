import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTouched } from "./session-tracker-hook.mjs";

test("extracts file_path from a Write tool event", () => {
  const input = { session_id: "s1", tool_name: "Write", tool_input: { file_path: "/repo/a.js" } };
  assert.deepEqual(extractTouched(input), { sessionId: "s1", filePath: "/repo/a.js" });
});

test("extracts file_path from an Edit tool event", () => {
  const input = { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "/repo/b.js" } };
  assert.deepEqual(extractTouched(input), { sessionId: "s1", filePath: "/repo/b.js" });
});

test("extracts notebook_path from a NotebookEdit event", () => {
  const input = {
    session_id: "s1",
    tool_name: "NotebookEdit",
    tool_input: { notebook_path: "/repo/n.ipynb" },
  };
  assert.deepEqual(extractTouched(input), { sessionId: "s1", filePath: "/repo/n.ipynb" });
});

test("returns null when the event carries no file path", () => {
  assert.equal(
    extractTouched({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }),
    null,
  );
});

test("returns null when tool_input is missing", () => {
  assert.equal(extractTouched({ session_id: "s1", tool_name: "Write" }), null);
});
