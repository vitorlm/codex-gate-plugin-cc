# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Repository scaffold: marketplace manifest, plugin manifest (`userConfig`), dev tooling
  (Biome, `tsc` via JSDoc, `node:test`), Apache-2.0 license, committed `package-lock.json`
  pinning `@openai/codex-sdk@0.139.0`, `ajv@8.17.1`.
- **Output schemas + validator** (TDD): dual-shape schemas (`schemas/codex-output.*.strict.json`
  sent to Codex; `schemas/{review,adversarial}-output.schema.json` for internal validation) and
  `scripts/lib/review-schema.mjs` (`dropNulls`, tolerant `validate`, `strictOutputSchema`).
  12 tests cover normalization, unknown-key stripping, `SCHEMA_INVALID` contract, and the
  "verdict never inferred" rule.
- **Codex driver** (TDD): `scripts/lib/codex-sdk-driver.mjs` (sole transport) — `stripApiKeys`
  forces the subscription login, `createSdkDriver` runs Codex read-only / approvals-never with
  the strict `outputSchema`, parses + validates the payload, and maps failures to the §8 error
  envelope (`RATE_LIMITED`/`AUTH_REQUIRED`/`MODEL_UNAVAILABLE`/`TIMEOUT`/`SCHEMA_INVALID`/`CODEX_ERROR`);
  never emits a verdict on failure. `scripts/lib/codex-driver.mjs` is the thin seam wiring the real
  `Codex` + validator (overridable for tests). 12 tests via an injected fake Codex.
- **Scope resolution** (TDD): `scripts/lib/git.mjs` (injectable Git ops — repo detection,
  working-tree changes, merge-base diff), `scripts/lib/session-tracker.mjs` (per-session
  touched-files list), and `scripts/lib/scope.mjs` (§7.1 precedence: files > text > session >
  base > default, with **git-augmented gap detection** — Bash-edited files added to scope and a
  visible `coverageNote`, or a `tracker-only` warning outside Git). `scripts/session-tracker-hook.mjs`
  is the minimal `PostToolUse` hook (Write/Edit/NotebookEdit → append path; never blocks/throws),
  wired in `hooks/hooks.json` (3s timeout). 26 new tests.
- **Shared-state concurrency** (TDD): `scripts/lib/statelock.mjs` — `writeJsonAtomic` (temp+rename),
  `readJson` (safe fallback), and `withLock` (advisory lockfile with stale-lock breaking by dead
  pid / age, serialized critical sections). 7 tests incl. real-fs serialization + timeout.
- **Foreground review pipeline** (TDD): `/codex:review` and `/codex:adversarial-review` end to end.
  New libs `models.mjs` (alias resolution), `args.mjs` (flag parser), `quota.mjs` (daily cap +
  rate-limit backoff, §6.3), `render.mjs` (verdict/error presentation), `prompts.mjs` + the
  `prompts/{review,adversarial-review}.md` templates, and `pipeline.mjs` (`runReview`:
  quota gate → scope → prompt → driver → accounting). Wired in `codex-companion.mjs` (dispatcher)
  and the two command files. 40 new unit tests + dispatcher smoke tests (usage / NO_SCOPE / bad flag,
  none touching Codex).
- **SP-1 spike** (`spike/sp-1/`): validated `@openai/codex-sdk` on the ChatGPT subscription
  (no API key), structured `outputSchema`, token observability (`Turn.usage`), category-enum
  stability, and the OpenAI strict-schema subset. Findings folded into `docs/tech-spec.md`.

### Decided
- **OD-5:** `@openai/codex-sdk` is the sole transport (bundled, pinned binary). The
  `codex exec` fallback and version-compat layer are dropped.

[Unreleased]: https://github.com/vitorlm/codex-plugin-cc/commits/main
