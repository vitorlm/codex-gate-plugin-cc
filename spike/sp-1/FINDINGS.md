# SP-1 Findings — `@openai/codex-sdk` on ChatGPT subscription

**Date:** 2026-06-14 · **Verdict: PASS (with two design-shaping constraints).**
Harness: `spike/sp-1/` (`run-sdk.mjs`, fixture `fixtures/cart.js`, schemas in `schemas/`).
Evidence: `report-sdk.json`, `full-sdk.log`. SDK pinned `@openai/codex-sdk@0.139.0` (bundles `@openai/codex@0.139.0` — its own codex binary, independent of the system CLI 0.134.0).

## Environment
- `~/.codex/auth.json`: `OPENAI_API_KEY` empty, `tokens.{access_token,account_id}` present ⇒ ChatGPT OAuth subscription login.
- **The shell exported a real `OPENAI_API_KEY`** (`sk-proj-…`). Left in place, codex would prefer the API key over the subscription.

## The five SP-1 questions

| # | Question | Result |
|---|---|---|
| Q1 | SDK runs on subscription (no API key) + honors `outputSchema` | **PASS** |
| Q2 | Stable category/rule id per finding (drives §7.4 fingerprinting) | **PARTIAL** — category stabilizable via enum; per-finding identity is not stable |
| Q3 | Token usage observable | **PASS** — native `Turn.usage` |
| Q4 | Strict `additionalProperties:false` schema viable | **PASS, but only in OpenAI's strict subset** (see below) |

### Q1 — Subscription + structured output: PASS
SDK reached the model and returned schema-conformant JSON on the subscription login.
**Design correction (load-bearing):** §6.3 says the companion "never sets API-key env vars" — that is **insufficient**. If the user already exports `OPENAI_API_KEY` (common; this machine does), the SDK/CLI uses it. The driver must **actively strip** `OPENAI_API_KEY`/`CODEX_API_KEY` from the env it passes to Codex. Implemented as `subscriptionEnv()` in `lib.mjs`; passed via `new Codex({ env })`.

### Q4 — Strict schema: PASS only in OpenAI's strict subset
First run with the spec's §9.1 schema was **rejected** by the backend:
```
400 invalid_json_schema: 'required' must include every key in properties. Missing 'line_start'.
```
OpenAI Structured Outputs require: every property listed in `required`, `additionalProperties:false`, optional fields modeled as nullable (`"type": ["integer","null"]`), and **no `minimum`/`maximum`/`format`** (unsupported keywords rejected).
**⇒ Two schema shapes are required (this is a spec change to §9):**
- `codex-output.*.strict.json` — the OpenAI-strict shape sent as `outputSchema` (all-required, nullable optionals, no numeric bounds).
- `review-output.schema.json` (draft-07, optionals genuinely optional) — internal ajv validation, run **after** `dropNulls()` normalization.

This is direct empirical justification for the §5.6/§9 "tolerant normalization first" decision: the strict outputSchema forces optionals to come back as `null`, and normalization strips them before the richer internal validator runs. All 4 runs validated `true` after normalization.

### Q3 — Token observability: PASS, with a budget consequence
`Turn.usage` exposes `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`.
Per review of the 18-line fixture: **input ≈ 94k (cached ≈ 48k), output ≈ 650–800, reasoning 0.**
**⇒ §7.4 `TOKEN_BUDGET` default (~150k/loop) is too tight:** one review already bills ~94k input, so the budget trips after ~1 review — well before `MAX_ITERATIONS=3`. Either raise the default to ~300–450k (to actually permit 3 iterations) or document that the token trip, not the iteration cap, is the effective ceiling. The ~94k is largely fixed Codex overhead (system prompt + tool schemas), not fixture size — it won't shrink with smaller diffs.

### Q2 — Category/finding stability: PARTIAL (shapes the §7.4 default)
3 free-string runs + 1 enum run on the same fixture:
- **Category vocabulary is stable** when prompted for a "short lowercase machine id": every run used `correctness`, `security`, `concurrency`, `data-integrity`. The enum-constrained variant validated `true` (schema-forcing a category enum works).
- **The finding *set* churns:** 5 / 4 / 5 findings across runs; the severe ones (SQLi, off-by-one, race) are present every time, but secondary `data-integrity` findings appear/disappear, and **titles reword run-to-run** ("Loop reads past the end" vs "Discount calculation reads past the end of the items array").
- **⇒** `category` is a stable fingerprint *component*; `normalize(message)` is **not** stable. A `category+norm(msg)` fingerprint is only moderately stable. Recommendation: make the **category enum the default** (not a §7.4 degradation fallback), keep oscillation/no-progress trips but expect message-level noise, and treat the **iteration + token caps as the only hard termination guarantee** (which the spec already does).

### Bonus finding — model severity is unstable ⇒ §7.4 vindicated
The model's self-rated `severity` for the **same** defect flipped across runs (concurrency race: `major`, `major`, `blocker`). This is direct evidence for the §7.4 decision to **gate on host-derived severity by category**, treating the model `severity` field as advisory only.

### Bonus finding — read-only sandbox works as designed
`Turn.items` for a run were `[agent_message, command_execution, agent_message]`: Codex spawned a shell command to read the fixture itself under `sandboxMode:"read-only"` and still produced structured output. The "hand Codex the working dir, let it read" driver model is confirmed; no write capability was needed or granted.

## Decisions resolved
- **OD-5 → SDK primary, CONFIRMED. No exec fallback** (owner decision, 2026-06-14). The SDK bundles a pinned codex binary, so version churn is offloaded to OpenAI as intended. Consequence: `codex-exec-driver.mjs` and `codex-compat.mjs` (§4.2/§5.6) can be dropped from the build — the exec-path complexity is no longer carried.

## Net spec impacts (for §9, §7.4, §6.3, §3/§5.6)
1. §9: define **separate strict outputSchema files** + keep draft-07 internal schemas; normalization (`dropNulls`) is mandatory, not optional.
2. §6.3 / driver: **actively strip** inherited API-key env vars (don't just avoid setting them).
3. §7.4: raise `TOKEN_BUDGET` (~300–450k) or redefine it as the primary ceiling; make the **category enum the default**, not a fallback; keep host-severity gating (now empirically justified).
4. §3 / §5.6: drop the exec driver + compat layer (no fallback).
