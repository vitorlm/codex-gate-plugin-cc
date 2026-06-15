import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cancelJob, listJobs } from "./lib/jobs.mjs";
import { depsInstalled } from "./lib/sdk-install.mjs";
import { clear } from "./lib/session-tracker.mjs";
import { workspaceStateDir } from "./lib/state.mjs";
import { readJson, writeJsonAtomic } from "./lib/statelock.mjs";

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA ?? null;

/**
 * Cancel (and kill the worker pid of) every running background job started by the
 * ending session — orphan prevention on SessionEnd (§7.5). Never throws.
 * @param {string} sessionId
 * @param {import("./lib/jobs.mjs").JobDeps} deps
 */
export async function terminateSessionJobs(sessionId, deps) {
  const jobs = await listJobs(deps, { sessionId });
  for (const job of jobs) {
    if (job.status === "running") await cancelJob(job.id, deps);
  }
}

async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/**
 * SessionStart: record session id + data path + runtime-deps presence flag (a stat
 * only — never an npm install; §5.4). SessionEnd: clean up this session's state.
 */
/** @param {string} event */
async function main(event) {
  try {
    const input = JSON.parse((await readStdin()) || "{}");
    const sessionId = input.session_id;
    if (!DATA_DIR || !sessionId) return;
    const sessionsDir = join(DATA_DIR, "sessions");
    const marker = join(sessionsDir, `${sessionId}.session.json`);

    if (event === "SessionStart") {
      const prev = readJson(marker, {});
      writeJsonAtomic(marker, {
        ...prev,
        sessionId,
        dataPath: DATA_DIR,
        depsInstalled: depsInstalled(DATA_DIR),
      });
    } else if (event === "SessionEnd") {
      clear(sessionId, { dir: sessionsDir }); // touched-files list
      rmSync(join(DATA_DIR, `loop-${sessionId}.json`), { force: true });
      rmSync(marker, { force: true });
      const stateDir = workspaceStateDir(process.cwd(), { baseDir: DATA_DIR });
      if (stateDir) await terminateSessionJobs(sessionId, { dir: stateDir, now: Date.now });
    }
  } catch {
    // Lifecycle bookkeeping must never disrupt the session.
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? "");
}

export { main };
