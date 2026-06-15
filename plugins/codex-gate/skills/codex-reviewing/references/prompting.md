# codex-reviewing — prompting & handling reference

Detail behind `SKILL.md`. Read this when a review needs careful scoping or when handling an error/coverage edge case.

## Choosing scope precisely

- **Per-story (orchestrator):** pass the exact files the story produced, or `--session` to let the tracker + Git augmentation decide. Prefer explicit paths when you know them — it is the most precise scope and needs no Git.
- **Whole change vs. a branch:** `--base main` reviews `main...HEAD` (merge-base diff). Requires Git.
- **A design doc or snippet (no repo):** `--text "<content>"`. This is the path for adversarial review of specs — Git is never required.
- **Don't widen scope.** Reviewing more than the change under question wastes subscription quota and dilutes the verdict. Pass the narrowest scope that covers the work.

## review vs adversarial-review

- `review` → correctness / security / concurrency / quality defects, line-anchored, `verdict ∈ {approve, request_changes, comment}`.
- `adversarial-review` → challenges assumptions, trade-offs, and failure modes of a *design*; `verdict ∈ {sound, request_changes, reconsider}`. Use `--focus` to aim it (e.g. `--focus "the retry/backoff design"`). A `sound` verdict means Codex ran and found no blocking challenge — it is never inferred from an empty or failed run.

## Why relay verbatim

The whole premise is an **independent, different-family** judge (Codex/GPT) reviewing what a Claude-family model produced. If you summarize, soften, or re-judge its findings, you reintroduce the generator's blind spots and destroy the value. Return the structured verdict whole.

## Failure handling (never falsely approve)

| Envelope | Meaning | What to do |
|---|---|---|
| `AUTH_REQUIRED` | Not logged in | Tell the user to run `codex login` (or `/codex-gate:setup`). |
| `RATE_LIMITED` | Throttled / backoff active | Surface it; do not retry in a loop. |
| `QUOTA_GUARD` | Daily cap hit (if configured) | Surface remediation; not an approval. |
| `MODEL_UNAVAILABLE` | Bad/again model id | Suggest a valid `--model`. |
| `TIMEOUT` / `CODEX_ERROR` | Run failed | Report as unreviewed; never approve. |
| `SCHEMA_INVALID` | Output failed validation after normalization | Treated as unavailable — not an approval. |
| `NO_SCOPE` | Nothing resolvable | Ask the caller for files / `--text` / `--base`. |

Every one of these is the **absence** of a review, not a passing review. The caller (orchestrator) should treat a hard error as "story not reviewed" and stop, rather than proceeding as if approved.

## Coverage notes

A result may carry a `⚠ Coverage:` annotation:
- `git-augmented` — Bash-edited files were detected via Git and added to scope (good).
- `tracker-only (Bash edits not detectable)` — outside Git, only Write/Edit/NotebookEdit were tracked; coverage may be incomplete. Keep this visible so partial coverage is never read as full.
