import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { record } from "./lib/session-tracker.mjs";

/**
 * Pure extraction of the touched file from a PostToolUse hook event.
 * Handles Write/Edit (`file_path`) and NotebookEdit (`notebook_path`).
 * @param {{ session_id?: string, tool_input?: { file_path?: string, notebook_path?: string } }} input
 * @returns {{ sessionId: string, filePath: string } | null}
 */
export function extractTouched(input) {
  const ti = input?.tool_input;
  const filePath = ti?.file_path ?? ti?.notebook_path;
  if (!filePath || !input.session_id) return null;
  return { sessionId: input.session_id, filePath };
}

async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/**
 * Minimal PostToolUse work (§4.3): append the touched path, never block the tool,
 * never throw. Bounded by the hook's own short timeout.
 */
async function main() {
  try {
    const input = JSON.parse(await readStdin());
    const touched = extractTouched(input);
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    if (touched && dataDir) {
      record(touched.sessionId, touched.filePath, { dir: join(dataDir, "sessions") });
    }
  } catch {
    // Swallow everything: a tracker failure must never interfere with the tool call.
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
