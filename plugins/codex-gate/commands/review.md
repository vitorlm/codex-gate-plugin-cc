---
description: Cross-model code review of the given scope via Codex (read-only).
argument-hint: "[files...] | --session | --base <ref> | --text <code> [--model mini|<id>] [--json]"
allowed-tools: Bash(node:*), Bash(git:*), Read, Glob, Grep, AskUserQuestion
disable-model-invocation: true
---

Run a Codex cross-model code review over the requested scope and present the verdict.

1. Run the companion (it resolves scope, calls Codex read-only, and validates the structured output):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review $ARGUMENTS
   ```

2. Relay its output verbatim — it is already the rendered verdict (or a structured `⚠ <CODE>` error with remediation). Do **not** summarize findings away or re-judge them; this is an independent reviewer's verdict.
3. If the companion prints a `NO_SCOPE` error, ask the user how to scope the review (explicit files, `--session`, `--base <ref>`, or `--text`).
