---
description: Cancel a running background Codex review job (terminates its worker).
argument-hint: "<jobId>"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Cancel a background Codex review job and terminate its worker process.

1. Run the companion:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel $ARGUMENTS
   ```

2. Relay its output verbatim — a confirmation that the job was cancelled, a note that it had already finished, or a `⚠ job not found` error. An already-finished job is not re-cancelled.
