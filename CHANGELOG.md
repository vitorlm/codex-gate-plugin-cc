# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-06-15

### Added
- **Live review visibility (streaming).** The Codex driver now consumes the turn via the SDK's
  `runStreamed()` instead of the opaque blocking `run()`, and emits a human-readable progress line
  per `ThreadEvent` (commands Codex runs, reasoning, web searches, plan/todo updates, completion +
  token usage) plus a periodic **heartbeat** while it works silently. Output goes to **stderr**, so
  a backgrounded shell (`2>&1`) shows what Codex is doing in real time — and it costs **zero** Claude
  tokens (process output, not model context). The structured `outputSchema` verdict is unchanged
  (reconstructed from the final `agent_message`).
- **Review timeout (no more zombie shells).** A single review turn is now bounded by an
  `AbortSignal` armed with `CODEX_GATE_TIMEOUT_MS` (default `300000` / 5 min, configurable via
  `userConfig.reviewTimeoutMs`). A hung turn returns a clean `TIMEOUT` envelope with remediation
  instead of running indefinitely. `gateConfigFromEnv`/`/codex-gate:setup` now report the effective
  `reviewTimeout`.

### Changed
- `scripts/lib/codex-sdk-driver.mjs`: switched to `runStreamed`; added pure, exported `formatEvent`
  and `consumeEvents` helpers; injectable `onProgress`/`timers`/`timeoutMs`/`heartbeatMs` keep the
  orchestration deterministically unit-testable. A `turn.failed`/stream `error` event is now raised
  and mapped to an envelope rather than silently treated as a completed turn.

## [0.1.1] - 2026-06-15

### Fixed
- **Distributed-install crash (dependency resolution).** `scripts/lib/review-schema.mjs` used a
  static `import { Ajv } from "ajv"`, but the lazy installer only placed `@openai/codex-sdk` into
  `${CLAUDE_PLUGIN_DATA}/node_modules`. In a distributed (non-dev) install `ajv` was unresolvable,
  so the companion crashed at module load with `ERR_MODULE_NOT_FOUND` (the `/codex-gate:setup`
  probe failed for exactly this reason). Fix: `ajv` is now installed lazily into
  `${CLAUDE_PLUGIN_DATA}` **alongside the SDK** and loaded via dynamic `import()` from the data dir
  (with a dev bare-specifier fallback), the same treatment `sdk-load.mjs` already gave the SDK.

### Changed
- `scripts/lib/sdk-load.mjs`: factored a generic `loadDep(dataDir, pkgName)`; added
  `loadAjv(dataDir)` (`loadCodex` now delegates to it).
- `scripts/lib/review-schema.mjs`: `validate` is now `async validate(kind, payload, { dataDir })`
  and loads ajv lazily; compiled validators are memoized per `dataDir`. `dropNulls` and
  `strictOutputSchema` stay synchronous; the return contract is unchanged.
- `scripts/lib/sdk-install.mjs`: `sdkInstalled`/`ensureSdk` generalized to
  `depsInstalled`/`ensureDeps`, which check/install **both** pinned deps
  (`@openai/codex-sdk@0.139.0` and `ajv@8.17.1`, exported as `PINNED_SPECS`).
- Async ripple: `codex-sdk-driver.mjs` awaits the injected `validate`; `codex-driver.mjs` binds
  `validate` to the driver's `dataDir`; install call sites in `codex-companion.mjs` and
  `stop-review-gate-hook.mjs`, plus the SessionStart presence flag in
  `session-lifecycle-hook.mjs`, now reference both deps.

## [0.1.0] - 2026-06-15

Initial pre-release. Build steps 2–13 complete (192 tests green; `claude plugin validate --strict` passes). The V-1 cross-model validation harness is built; its live run and the 1.0 gate decision remain a manual, quota-gated activity.

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
- **Stop-gate circuit breaker** (TDD, §7.4): `loop-state.mjs` — `fingerprint` (category+normalized
  message, location-independent), host-derived `gatingSeverity` (model severity ignored), set-based
  `madeProgress`, and the `preReview`/`postReview` state machine (reentrancy/empty/unchanged allows,
  iteration + token-budget trips, new-findings-only blocking, oscillation→contested, no-progress→open).
  `stop-review-gate-hook.mjs` (opt-in `Stop` hook, fail-open + visible, OD-1 unavailable handling),
  `session-lifecycle-hook.mjs` (SessionStart flag + SessionEnd cleanup), `sdk-install.mjs` (lazy pinned
  SDK install on first review), and `sdk-load.mjs` (**dynamic `import()` of the SDK from the data dir
  by file URL**, with dev fallback — so the driver resolves the lazily-installed SDK in a distributed
  install; no static bare import). Wired SessionStart/Stop/SessionEnd in `hooks.json`. 26 new tests +
  hook smoke tests (disabled / reentrancy / lifecycle, none touching Codex).
- **Renamed `codex` → `codex-gate`** (plugin, namespace `/codex-gate:`, marketplace `vitorlm-codex-gate`,
  dir `plugins/codex-gate/`) to avoid total collision with OpenAI's official `codex` plugin.
- **Reviewer subagent + skill:** `agents/codex-reviewer.md` (isolated-context, model-invocable, thin
  one-call forwarder that returns Codex's verdict verbatim) and the internal `skills/codex-reviewing`
  (SKILL.md + references/prompting.md) describing companion flags and the "never falsely approve" handling.
- **Foreground review pipeline** (TDD): `/codex-gate:review` and `/codex-gate:adversarial-review` end to end.
  New libs `models.mjs` (alias resolution), `args.mjs` (flag parser), `quota.mjs` (daily cap +
  rate-limit backoff, §6.3), `render.mjs` (verdict/error presentation), `prompts.mjs` + the
  `prompts/{review,adversarial-review}.md` templates, and `pipeline.mjs` (`runReview`:
  quota gate → scope → prompt → driver → accounting). Wired in `codex-companion.mjs` (dispatcher)
  and the two command files. 40 new unit tests + dispatcher smoke tests (usage / NO_SCOPE / bad flag,
  none touching Codex).
- **Background jobs** (TDD, OD-6, §7.5): `scripts/lib/state.mjs` (deterministic per-workspace
  state dir `${CLAUDE_PLUGIN_DATA}/state/<slug>-<hash>`) and `scripts/lib/jobs.mjs` (job lifecycle
  over `statelock` — `createJob`/`getJob`/`listJobs`/`updateJob`/`completeJob`/`cancelJob`/`pruneJobs`
  plus `reconcileJob` for dead-pid orphan/zombie-worker recovery; injected clock + id + pid-liveness).
  `review --background` creates a job, spawns `task-worker` **detached** (`{ detached: true,
  stdio: "ignore" }` + `unref`), and prints the `jobId` immediately. New `task-worker` (internal),
  `status [jobId]`, `result <jobId>`, `cancel <jobId>` subcommands + the `status`/`result`/`cancel`
  command files. `SessionEnd` now terminates the ending session's running jobs. 35 new tests
  (state, jobs lifecycle/prune/cancel/orphan-reconcile, companion handlers, session cleanup), none
  touching Codex (spawn/clock/id/runReview all injected).
- **`/codex-gate:setup` login probe + config** (TDD, §5.6/§6.3): `scripts/lib/auth.mjs`
  (`probeAuth` classifies the auth state via an **injected** minimal Codex call — `OK` /
  `AUTH_REQUIRED` / `RATE_LIMITED`, reusing `classifyError`; the load-bearing §6.3 distinction
  that a throttled probe is *authenticated*, never "not logged in"; `authFileExists` is a cheap,
  non-authoritative `~/.codex/auth.json` hint). `scripts/lib/setup.mjs` (`runSetup` with injected
  `probe`/`ensureSdk`/`readAuthFile` — pre-installs the pinned SDK, reports SDK presence + auth
  state, and surfaces the effective stop-gate config; `gateConfigFromEnv` reads the same env the
  `Stop` hook consumes). Wired the `setup` subcommand in `codex-companion.mjs` (replaces the stub;
  degrades to a clear non-crashing message when `CLAUDE_PLUGIN_DATA` is unset) and added
  `commands/setup.md` (model-invocable; `Bash(node:*)`, `AskUserQuestion`). The stop-gate/quota
  knobs stay a single source of truth — `userConfig` (edited via `/plugin`) → env → hook; setup
  *reports* the live values and uses `AskUserQuestion` to guide intent rather than persisting a
  parallel config. 17 new tests (auth + setup), none touching Codex/network/`~/.codex`.
- **SP-1 spike** (`spike/sp-1/`): validated `@openai/codex-sdk` on the ChatGPT subscription
  (no API key), structured `outputSchema`, token observability (`Turn.usage`), category-enum
  stability, and the OpenAI strict-schema subset. Findings folded into `docs/tech-spec.md`.
- **V-1 validation harness** (`spike/v-1/`, research/spike — not shipped code): cross-model
  (Codex) vs same-model (Claude) reviewer comparison on 8 seeded-defect fixtures + 1 defect-free
  control, with a defect-**class** taxonomy as labelled truth (`fixtures/manifest.json`). Pure,
  deterministic scoring (`score.mjs`): per-fixture Codex/Claude true positives, the distinct
  TP classes Codex catches that Claude misses (the cross-model "edge"), and false positives;
  aggregated into the §0 verdict (`criterionMet` = edge on ≥30% of fixtures **and** acceptable
  Codex FP rate). Both review-producing calls are injected (`codexReviewer`/`claudeReviewer`)
  so the harness runs with real backends only by a human — the build/tests never call Codex or
  the Anthropic API. 17 tests (scoring math + class-normalization + runner glue, all synthetic).
  The live run and the 1.0 gate decision remain a manual, quota-gated activity (`spike/v-1/README.md`).

### Decided
- **OD-5:** `@openai/codex-sdk` is the sole transport (bundled, pinned binary). The
  `codex exec` fallback and version-compat layer are dropped.

[Unreleased]: https://github.com/vitorlm/codex-gate-plugin-cc/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/vitorlm/codex-gate-plugin-cc/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/vitorlm/codex-gate-plugin-cc/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/vitorlm/codex-gate-plugin-cc/releases/tag/v0.1.0
