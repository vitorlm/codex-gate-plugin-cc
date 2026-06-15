---
description: Probe Codex login (authed vs throttled), pre-install the SDK, and review the stop-gate config.
argument-hint: ""
allowed-tools: Bash(node:*), AskUserQuestion
---

Verify the plugin is ready and help the user tune the stop review-gate.

1. Run the companion `setup` (pre-installs the pinned Codex SDK if absent, runs a real login probe, and prints the effective stop-gate config):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup
   ```

2. Relay its output verbatim, then interpret the auth line for the user:
   - **authenticated** — ready to review.
   - **NOT authenticated** (`AUTH_REQUIRED`) — tell the user to run `codex login` in their terminal. Do **not** run it yourself.
   - **RATE_LIMITED** — the user **is** logged in but currently throttled. Do **not** tell them to log in again; advise waiting for the cooldown or lowering automated review volume.
   - any other `⚠ <CODE>` — relay the error and its remediation.

3. The stop review-gate and quota knobs are **`userConfig`** fields in `plugin.json` (`stopReviewGate`, `stopGateOnUnavailable`, `maxReviewsPerDay`, `maxIterations`, `severityThreshold`). They are edited via Claude Code's `/plugin` settings UI; Claude Code exports them to the `Stop` hook as env, which is exactly what the `setup` output reflects. This command does **not** persist a parallel config — it reports the live, effective values so there is one source of truth.

4. Use **AskUserQuestion** to confirm intent (you are guiding, not silently changing settings):
   - Whether to enable the converging stop review-gate (`stopReviewGate`). Note: with the gate on, a Codex review runs when a turn ends — bounded by `maxIterations`, fails open + visible on Codex unavailability.
   - Whether to set a daily automated-review cap (`maxReviewsPerDay`; `0` = no cap, the default). A cap is the only proactive quota/ToS guard.

   After the user chooses, tell them to apply the choice in the `/plugin` settings UI for `codex-gate` (these are `userConfig` fields; the plugin cannot write them on the user's behalf). Re-run `/codex-gate:setup` to confirm the new effective config.
