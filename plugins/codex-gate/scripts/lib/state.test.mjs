import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceSlug, workspaceStateDir } from "./state.mjs";

test("workspaceSlug is a deterministic slug + short hash of the absolute path", () => {
  const a = workspaceSlug("/Users/me/git/My Project");
  const b = workspaceSlug("/Users/me/git/My Project");
  assert.equal(a, b); // deterministic
  assert.match(a, /^[a-z0-9-]+-[0-9a-f]{8}$/); // slug + 8-hex hash
});

test("workspaceSlug differs for different paths even with the same basename", () => {
  const a = workspaceSlug("/a/project");
  const b = workspaceSlug("/b/project");
  assert.notEqual(a, b); // hash disambiguates same basename
  assert.ok(a.startsWith("project-"));
  assert.ok(b.startsWith("project-"));
});

test("workspaceSlug sanitizes unsafe characters in the basename", () => {
  const slug = workspaceSlug("/Users/me/My Project (v2)!");
  assert.match(slug.split("-").slice(0, -1).join("-"), /^[a-z0-9-]+$/);
});

test("workspaceStateDir resolves under <base>/state/<slug>", () => {
  const dir = workspaceStateDir("/work/proj", { baseDir: "/data" });
  assert.ok(dir.startsWith("/data/state/proj-"));
});

test("workspaceStateDir uses CLAUDE_PLUGIN_DATA base by default", () => {
  const dir = workspaceStateDir("/work/proj", { baseDir: "/plugindata" });
  assert.equal(dir, `/plugindata/state/${workspaceSlug("/work/proj")}`);
});

test("workspaceStateDir returns null when no base dir is available", () => {
  assert.equal(workspaceStateDir("/work/proj", { baseDir: null }), null);
});
