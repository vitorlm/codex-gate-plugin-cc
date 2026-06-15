# Tech Spec — Codex Code Review Plugin for Claude Code

| | |
|---|---|
| **Status** | **SP-1 PASSED (2026-06-14)** — SP-1 deltas integrated (§3/§5.6/§6.3/§7.4/§9). **Build steps 2–13 done — ready to publish (0.1.0)** (… + reviewer subagent + stop-gate circuit breaker §7.4 + background jobs §7.5 + `/codex-gate:setup` login probe §6.3 + **V-1 harness built — scoring tested, live run pending/human-gated** + validate/docs/publish-prep done, §15 item 13); **192 tests green**, `claude plugin validate --strict` passes for both the plugin and the marketplace manifest. Publish = human `git push`. Build refinements folded back into §5.6/§6.1/§7.1/§11/§12. Evidence: `spike/sp-1/FINDINGS.md`, `spike/v-1/README.md`. |
| **Date** | 2026-06-14 |
| **Owner** | Vitor Mendonça |
| **Plugin name** | `codex-gate` (namespace `/codex-gate:*`) |
| **Distribution** | Self-owned marketplace repo `github.com/vitorlm/codex-gate-plugin-cc` (local working dir: `~/git-pessoal/codex-plugin-cc`) |
| **Codex transport** | `@openai/codex-sdk` (**SP-1 confirmed on subscription; sole transport — no exec fallback**, owner decision 2026-06-14), behind a `codex-driver` abstraction |

---

## 0. Why this exists (value thesis)

**Generate code with one LLM (Claude), review it with a different-family LLM (Codex / GPT).** A model is a weaker judge of its own output: it shares the generator's blind spots, training biases, and a confirmation bias toward what it just produced. An independent model from a different family is *expected* to catch some error classes the generator misses in itself.

This is the load-bearing justification for all the cost this plugin carries (external CLI, subscription auth, version churn, rate limits, ToS exposure). It is also **why a Claude subagent reviewer is not a substitute** — it would inherit the generator's blind spots. If cross-model review stops being the goal, the simpler answer is a Claude subagent and this plugin should not exist.

**This advantage is a hypothesis, not an established fact (must be validated).** Claude and GPT are both transformer LLMs trained on heavily overlapping internet corpora; *shared* blind spots are real (both can miss the same subtle concurrency bug, both can hallucinate the same plausible-but-wrong API). The cross-family premise buys *partial* independence, not orthogonality. Before relying on it at scale we will measure it:

- **V-1 (validation, post-SP-1, pre-1.0):** on a fixed fixture set of seeded-defect diffs, compare Codex cross-model review against a Claude same-model subagent reviewer. Success criterion: Codex finds ≥1 distinct true-positive class the Claude reviewer misses, on ≥30% of fixtures, at acceptable false-positive rate. If this fails, the thesis — and the plugin — is not justified and we revert to a Claude subagent.

Every design trade-off below is evaluated against this thesis *and* its validation.

---

## 1. Overview

A Claude Code plugin that delegates **code review** and **adversarial review** to the OpenAI **Codex CLI**, using the user's **ChatGPT subscription** (cached `codex login`) — never the OpenAI API key.

It mirrors the proven architecture of the `abiswas97-gemini` plugin (thin command/agent/hook markdown over a single Node "companion" that drives the external tool and parses structured output), but corrects that plugin's known weaknesses and adapts the transport to Codex, which has **no native ACP**. Codex is driven one-shot per review through a `codex-driver` abstraction (SDK-backed, **sole transport — no exec fallback**; SP-1) with schema-forced structured output.

Primary consumers:
1. An **orchestrator** in a Claude Code session (e.g. `epic-orchestrator`) that reviews after each implementation story, via a dedicated **subagent** (isolated context).
2. A **stop-gate** `Stop` hook with a bounded review→fix loop (circuit breaker, §7.4).
3. Manual user commands for ad-hoc review.

---

## 2. Goals / Non-goals

### Goals
- Cross-model review (§0): delegate review/adversarial-review to Codex via the ChatGPT subscription — **subject to V-1 validating the premise**.
- Invokable automatically from within a session by an orchestrator, in **isolated context** (subagent), returning only the verdict.
- A `Stop` review-gate that **provably terminates** (bounded loop, §7.4) — termination is guaranteed; *quality* convergence is not claimed (see §7.4).
- **Scope = code the session actually produced** (§7.1), tracked via `PostToolUse`, with explicit, *visible* handling of changes the tracker cannot see (Bash-driven edits) — never a silent miss.
- **Work without a Git repository:** review arbitrary files, dirs, or pasted text. Git enables diff-based scoping but is **never required** — especially for adversarial review of design docs. (Avoids the gemini plugin's hard Git dependency, which fails even on a standalone markdown file.)
- Read-only **for the Codex subprocess** by construction: the reviewer (Codex) never modifies the working tree. (Trust-boundary scope is clarified in §10 — this does *not* mean the whole plugin is read-only.)
- Single-source-of-truth structured output, with **distinct schemas for review vs adversarial** (§9).
- **Fail visibly, never falsely approve** (§8) — including silent-scope-miss and schema-validation failures.
- Resilient to Codex CLI version churn (SDK with its own pinned, bundled codex binary — no exec-stream parsing on our side).

### Non-goals
- No "review + auto-fix" mode (read-only only). A future `workspace-write` opt-in is out of scope.
- No OpenAI API-key / `CODEX_API_KEY` auth path (subscription only) for v0.1; an API-key path for high-volume/ToS-safe use is an explicit future OD (§6.3).
- No MCP server (avoids always-on token cost; §4.3).
- No ACP transport (Codex lacks native ACP; third-party bridges rejected as fragile).
- No interactive `/review` slash-command reuse (not reachable headlessly; review is driven via prompt + schema).

---

## 3. Transport decision (SDK sole transport — SP-1 confirmed)

The biggest technical risk was that the **Codex exec `--json` stream is an internal, unversioned format** that has churned across CLI releases (0.107→0.137). Three candidate transports were re-evaluated for **stability** (not aesthetics); **SP-1 resolved the decision** (`spike/sp-1/FINDINGS.md`):

| Transport | Stability | Cost | Verdict |
|---|---|---|---|
| **`@openai/codex-sdk`** | OpenAI-maintained; absorbs JSONL churn; **bundles its own pinned codex binary** (`@openai/codex`), independent of the system CLI | npm dep in `${CLAUDE_PLUGIN_DATA}`, **version-pinned + lockfile** | **Sole transport (SP-1 confirmed on subscription)** |
| `codex exec --json` | Internal, unversioned; we own the churn | zero deps | **Dropped** (was fallback; OD-5 owner decision 2026-06-14 — no fallback) |
| `codex mcp-server` | Stable-ish but generic tools, not review-shaped; always-on token cost | high | Rejected |

**Decision (resolved):** the SDK is the **sole** transport. SP-1 proved it runs on the cached ChatGPT subscription login (no API key) and honors `outputSchema`. Because the SDK bundles a pinned codex binary, version churn is offloaded to OpenAI and the exec-path complexity (a second driver + a version-compat layer) buys nothing — so it is **not carried**. The `codex-driver` abstraction (§5.6) is retained as a thin seam (single implementation) so a future transport swap stays a one-file change, but there is no runtime fallback.

> **SP-1 results (was a blocking spike; now closed — full report `spike/sp-1/FINDINGS.md`):**
> - **SDK on subscription + `outputSchema`: PASS.** Correction folded into §6.3: the driver must **actively strip** inherited `OPENAI_API_KEY`/`CODEX_API_KEY` (merely "not setting" them is insufficient when the user's shell exports one).
> - **Strict schema: PASS only in OpenAI's strict subset** — every property must be `required`, optionals modeled as nullable, no `minimum`/`maximum`/`format`. Drove the §9 **dual-schema** design (strict outputSchema + draft-07 internal validation after normalization).
> - **Token usage: observable** via `Turn.usage` (`input/cached_input/output/reasoning`). ~94k input (~48k cached) + ~700 output per review — drove the §7.4 `TOKEN_BUDGET` revision.
> - **Category id: stabilizable via a schema-forced enum**, but the per-finding *set/titles* churn run-to-run — drove the §7.4 "category enum is the default" decision. Model-emitted `severity` was unstable across runs, empirically confirming host-derived gating (§7.4).

Inherited corrections from the gemini analysis. Some are genuine design decisions; some are basic hygiene we simply will not repeat — listed for completeness, **not** claimed as architectural merit:

| Gemini finding | This design | Type |
|---|---|---|
| Broad trust boundary (auto-approved `fs/write`) | read-only sandbox for the Codex subprocess (§10) | design |
| Triplicated review-output validation | schema-forced output + single `review-schema.mjs` validator | design |
| Tight coupling to a fast-moving CLI | `codex-driver` seam + SDK with its **own pinned bundled binary** (no exec/compat layer) to offload churn entirely to OpenAI | design |
| Heuristic auth detection (file parsing) | `/codex-gate:setup` real login probe (distinguishes not-authed from throttled) | design |
| Hard Git dependency | Git-optional scope (§7.1) | design |
| Inconsistent timeouts + dead code | aligned timeouts; no dead code | hygiene |
| Sparse manifest | rich `plugin.json` | hygiene |
| Unclear bump discipline | SemVer + CHANGELOG, bumped per release | hygiene |

---

## 4. Architecture

### 4.1 High-level flow

```
Claude Code session
  ├─ orchestrator ──(Task)──► agents/codex-reviewer (isolated ctx, tools: Bash)
  ├─ user ──(/codex-gate:review | /codex-gate:adversarial-review)──┐
  │                                                       ▼
  │                                   node codex-companion.mjs <subcommand>
  └─ Stop hook ──► stop-review-gate-hook.mjs ──────────────┤
        (reads loop-state + session-touched files)         │
                                                           ▼
                    ┌───────────────┬───────────────┬───────────────┐
                    ▼               ▼               ▼               ▼
                 scope.mjs     codex-driver    review-schema   loop-state.mjs
              (session/diff/   (SDK only,      (validate, 2    (circuit-breaker
               files/text)      read-only)      schemas)        state, fingerprints)
                                    │
                                    ▼
                    Codex (subscription login, read-only sandbox,
                           outputSchema = review|adversarial schema)
```

### 4.2 Repository layout

```
codex-gate/
├── .claude-plugin/
│   └── marketplace.json
├── README.md   LICENSE (Apache-2.0, OD-4)   CHANGELOG.md
├── docs/tech-spec.md
├── package.json            # private; Biome, tsc-via-JSDoc; @openai/codex-sdk pinned if SP-1 passes
├── package-lock.json       # committed; pins the runtime SDK version (reproducible installs)
├── tsconfig.scripts.json
└── plugins/codex-gate/
    ├── .claude-plugin/plugin.json
    ├── agents/codex-reviewer.md
    ├── commands/
    │   ├── review.md
    │   ├── adversarial-review.md
    │   ├── setup.md
    │   ├── status.md
    │   ├── result.md
    │   └── cancel.md
    ├── hooks/hooks.json
    ├── prompts/
    │   ├── review.md
    │   ├── adversarial-review.md
    │   └── stop-review-gate.md
    ├── schemas/
    │   ├── review-output.schema.json           # internal draft-07 (validation)
    │   ├── adversarial-output.schema.json       # internal draft-07 (validation)
    │   ├── codex-output.review.strict.json      # OpenAI-strict outputSchema (sent to Codex)
    │   └── codex-output.adversarial.strict.json # OpenAI-strict outputSchema (sent to Codex)
    ├── scripts/
    │   ├── codex-companion.mjs
    │   ├── session-lifecycle-hook.mjs      # SessionStart/End
    │   ├── session-tracker-hook.mjs        # PostToolUse: record touched files
    │   ├── stop-review-gate-hook.mjs       # Stop: circuit breaker
    │   └── lib/
    │       ├── codex-driver.mjs            # thin seam + single SDK implementation
    │       ├── codex-sdk-driver.mjs        # sole transport (SP-1); strips inherited API-key env
    │       ├── review-schema.mjs           # single validator for BOTH schemas
    │       ├── scope.mjs   git.mjs
    │       ├── session-tracker.mjs         # read/write session-touched file list
    │       ├── loop-state.mjs              # circuit-breaker state + fingerprints
    │       ├── statelock.mjs               # advisory file lock for shared state (§4.4)
    │       ├── jobs.mjs   state.mjs        # background job lifecycle + per-workspace state
    │       ├── render.mjs  models.mjs  args.mjs  auth.mjs
    └── skills/codex-reviewing/
        ├── SKILL.md
        └── references/prompting.md
```

Convention compliance: only `plugin.json` in `.claude-plugin/`; components at plugin root; bundled paths via `${CLAUDE_PLUGIN_ROOT}`; persistent state in `${CLAUDE_PLUGIN_DATA}`; no absolute paths / no `../`.

### 4.3 Why no MCP / no always-on *token* cost

No `.mcp.json`. All capability is exposed via skills/commands/agent and pays *token* cost only on invocation (progressive disclosure) — the property that keeps the gemini plugin cheap, preserved here.

**Caveat (not zero-cost):** the `PostToolUse` tracker hook (§5.4) runs on **every** Write/Edit/NotebookEdit, even when no review is ever requested. That is a small *latency* cost (a fast file append, bounded by a tight timeout), not a token cost. We accept it as the price of faithful `--session` scope, and keep the hook's work minimal (append a path, no parsing, no Codex call). If measured latency is material, the tracker becomes opt-in alongside the stop-gate.

### 4.4 Shared-state concurrency

State is file-based and can be touched by concurrent sessions or re-entrant hooks. To avoid races:
- `loop-state` is keyed by `session_id` (single-writer in practice, but re-entrancy is guarded — §7.4).
- Any state that can be shared across sessions in the same workspace (job state, pruning) is written under an **advisory lock** (`statelock.mjs`: lockfile + stale-lock breaking by pid/mtime). Writes are atomic (write-temp-then-rename).
- The stop-gate additionally relies on `stop_hook_active` for re-entrancy. Locking and re-entrancy are independent concerns; both are required.

---

## 5. Components

### 5.1 `codex-companion.mjs` (dispatcher)

| Subcommand | Purpose |
|---|---|
| `review` | Review the resolved scope (foreground or `--background`) |
| `adversarial-review` | Same pipeline, adversarial prompt + adversarial schema |
| `setup` | Login probe (authed vs throttled) + stop-gate toggle |
| `status [jobId]` | Inspect background job(s) |
| `result <jobId>` | Fetch a completed job's structured result |
| `cancel <jobId>` | Cancel/terminate a background job |
| `task-worker` | Internal: detached background executor (not user-facing) |

Invoked as `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" <subcommand> [args]`. Flags (`args.mjs`): `--session`, `--base <ref>`, `<file>...`, `--text`/stdin, `--model <m>`, `--focus <text>` (adversarial), `--background`, `--json`.

### 5.2 `agents/codex-reviewer.md` (primary model-invocable surface)

- Frontmatter: `name: codex-reviewer`, third-person `description` with orchestrator trigger phrases, `tools: Bash`. **No** `mcpServers`/`hooks`/`permissionMode` (disallowed for plugin agents).
- Thin forwarding wrapper (lessons from `gemini-rescue`): exactly one companion call; no repo spelunking, no polling, no summarizing findings away; return the structured verdict verbatim.
- Accepts a scope from the caller (`--session`, `--base`, files) — orchestrator passes scope per story.
- Isolated context ⇒ orchestrator context stays clean.

### 5.3 Commands

| Command | Model-invocable | allowed-tools | Notes |
|---|---|---|---|
| `review` | `disable-model-invocation: true` | `Bash(node:*)`, `Bash(git:*)`, `Read`, `Glob`, `Grep`, `AskUserQuestion` | Manual; scope via args (OD-2) |
| `adversarial-review` | `disable-model-invocation: true` | same | Manual; `--focus` text |
| `setup` | model-invocable | `Bash(node:*)`, `AskUserQuestion` | Login probe + gate toggle |
| `status` | `disable-model-invocation: true` | `Bash(node:*)` | Inline `!`-exec; background jobs |
| `result` | `disable-model-invocation: true` | `Bash(node:*)` | Inline `!`-exec |
| `cancel` | `disable-model-invocation: true` | `Bash(node:*)` | — |

Automatic path is the subagent; manual commands are user-only to avoid double exposure (OD-2).

### 5.4 Hooks (`hooks/hooks.json`)

| Event | Script | Timeout | Behavior |
|---|---|---|---|
| `SessionStart` | `session-lifecycle-hook.mjs SessionStart` | 5s | Persist session id + data path; init loop-state. **Does not** install npm deps (see SDK install note below). |
| `PostToolUse` (Write/Edit/NotebookEdit) | `session-tracker-hook.mjs` | 3s | Append touched file path to session-touched list. Minimal work only (§4.3). |
| `SessionEnd` | `session-lifecycle-hook.mjs SessionEnd` | 5s | Clean up this session's state. |
| `Stop` | `stop-review-gate-hook.mjs` | aligned w/ script (§8) | Opt-in circuit-breaker review-gate (§7.4) |

**SDK install (corrected):** the SDK is **never** installed inside the 5s `SessionStart` hook (an `npm install` cannot reliably complete in 5s on a cold cache). Instead:
- The pinned SDK is installed **lazily and idempotently on first review**, not on every session start, with a realistic timeout owned by the driver (not the hook).
- `SessionStart` only *checks* presence (a stat, well within 5s) and records a flag; if absent, the first `review`/`setup` performs the install (with progress + its own timeout) or returns a structured `CODEX_ERROR`/remediation. `/codex-gate:setup` can pre-install explicitly.
- Install uses the committed `package-lock.json` to pin the SDK version (reproducible across users; §4.2).

### 5.5 `skills/codex-reviewing/SKILL.md`

Internal, `user-invocable: false`. Tells the subagent how to call the companion and return results. ≤ 2,000 words; detail in `references/prompting.md`; referenced explicitly from the agent.

### 5.6 lib modules

- **`codex-driver.mjs`** — `createDriver(overrides?)` thin seam over a **single** SDK implementation in `codex-sdk-driver.mjs` (no factory/selection — exec fallback dropped, OD-5). Loads the `Codex` class **lazily and dynamically** via `sdk-load.mjs` `loadCodex(dataDir)` — `import()` of the SDK installed in `${CLAUDE_PLUGIN_DATA}` by absolute file URL (the static bare import would not resolve in a distributed install), with a dev bare-specifier fallback; a `CodexClass` override short-circuits it for tests. Implemented contract (refined from `review({scope,...})`): `review({kind, prompt, workingDirectory, skipGitRepoCheck?, model}) → {ok:true, payload, usage} | {ok:false, error}`, where `kind` (`"review"|"adversarial"`) selects **both** the strict outputSchema and the internal validator. Read-only sandbox, approvals off, subscription login enforced (`stripApiKeys`).
- **`codex-sdk-driver.mjs`** — `@openai/codex-sdk`, `startThread({ sandboxMode:"read-only", approvalPolicy:"never", skipGitRepoCheck })`, `run(prompt, { outputSchema })`. Sole transport (SP-1). **Constructs `Codex({ env })` with inherited `OPENAI_API_KEY`/`CODEX_API_KEY` actively stripped** so the subscription login is always used (§6.3). Reads `Turn.usage` for token telemetry (§7.4). SDK installed (pinned, lazily) into `${CLAUDE_PLUGIN_DATA}` (§5.4); it bundles its own pinned codex binary.
- **`review-schema.mjs`** — single authority over the **dual-schema** model (§9). API: `strictOutputSchema(kind)` (the OpenAI-strict schema sent to the driver), `validate(kind, payload) → {ok, value} | {ok:false, code:"SCHEMA_INVALID", errors}`, and `dropNulls(value)`. `validate` runs **mandatory tolerant normalization** (`dropNulls` to remove the nulls the strict schema forces on optional fields, plus ajv `removeAdditional` + `coerceTypes` to strip unknown keys and coerce obvious deviations) before validating against the richer **draft-07** internal schema. Normalization is required, not best-effort — SP-1 showed strict output always emits optionals as `null`.
- **`scope.mjs`** + **`git.mjs`** — Git-optional scope resolution (§7.1); Git ops isolated in `git.mjs`. Computes and surfaces the *coverage gap* between tracked files and Git diff (§7.1) so the caller can see when scope may be incomplete.
- **`session-tracker.mjs`** — read/write the per-session touched-files list (written by the PostToolUse hook).
- **`loop-state.mjs`** — circuit-breaker state: iteration count, token budget spent (when observable), finding fingerprints + status (open/addressed/contested). Keyed by `session_id`.
- **`statelock.mjs`** — advisory lock + atomic write helpers for shared state (§4.4).
- **`jobs.mjs` / `state.mjs`** — background job lifecycle (`--background`) and per-workspace persisted state in `${CLAUDE_PLUGIN_DATA}`; detached `task-worker`, pruning, `status`/`result`/`cancel`. Shared state writes go through `statelock.mjs` (§4.4).
- **`render.mjs` / `models.mjs` / `args.mjs` / `auth.mjs`** — rendering; model aliases (`mini`→`gpt-5.4-mini`, default `gpt-5.5`); arg parsing; login probe.

---

## 6. Codex integration details

### 6.1 Driver contract

The driver enforces: read-only sandbox, approvals disabled, subscription login (**actively strips** inherited `OPENAI_API_KEY`/`CODEX_API_KEY` — not merely "does not set" them; SP-1 §6.3), model from `models.mjs`, and a **strict `outputSchema`** (§9) = the review or adversarial schema. It returns a validated payload or a structured error (§8). The driver also surfaces, when available, raw model-reported `severity` and `category`/rule id per finding (consumed advisorily — see §7.4) and token usage from `Turn.usage` (consumed by the budget trip — §7.4).

SDK invocation (sole transport):
```js
const codex = new Codex({ env: stripApiKeys(env) });          // force subscription login
const thread = codex.startThread({
  sandboxMode: "read-only", approvalPolicy: "never",
  skipGitRepoCheck,                       // true for file/text scopes; false for Git-derived scopes
  workingDirectory, model,
});
const turn = await thread.run(prompt, { outputSchema: strictOutputSchema(kind) });
// turn.finalResponse → JSON; turn.usage → token telemetry; Codex reads files itself in the read-only sandbox.
```
`skipGitRepoCheck` is `true` for file/text scopes so Codex runs outside a repo; `false` for Git-derived scopes. On any thrown transport error the driver returns a §8 envelope via `classifyError` (RATE_LIMITED / AUTH_REQUIRED / MODEL_UNAVAILABLE / TIMEOUT / CODEX_ERROR); an unparseable payload → `CODEX_ERROR`, a payload that fails validation → `SCHEMA_INVALID`. It **never** emits a verdict on failure.

### 6.2 Models

Default `gpt-5.5` (review and adversarial); override via `--model`/alias. Resolved in `models.mjs`.

### 6.3 Auth, quota & ToS (subscription only)

- Relies on cached `codex login` (ChatGPT OAuth, `~/.codex/auth.json`, auto-refreshed).
- **The driver actively strips** `OPENAI_API_KEY`/`CODEX_API_KEY` from the env it passes to the SDK ⇒ Codex always uses the subscription. **SP-1 correction (load-bearing):** merely *not setting* these is insufficient — when the user's shell already exports `OPENAI_API_KEY` (common; observed on the dev machine), Codex would otherwise prefer the API key, silently billing the API and defeating the subscription-only premise. The strip is mandatory, not defensive.
- `/codex-gate:setup` real probe distinguishes **not-authenticated** (`AUTH_REQUIRED` → "run `codex login`") from **authenticated-but-throttled** (`RATE_LIMITED`) — it must not report "not logged in" on a rate-limited probe. **Setup config mechanism (single source of truth):** the stop-gate/quota knobs live only in `plugin.json` `userConfig` (edited via `/plugin`); Claude Code exports them as env to the `Stop` hook, and `setup` *reports* those live, effective values (`gateConfigFromEnv`) and uses `AskUserQuestion` to guide intent — it never persists a parallel config that could diverge from `userConfig`.

**Quota & ToS risk — mitigation, not just acknowledgement.** High-volume orchestrator use (review after every story, on every `Stop`) can exhaust subscription quota, and headless programmatic use under a ChatGPT subscription may carry ToS exposure beyond throttling. This is **existential** to the plugin (if the account is banned, the orchestrator workflow dies). Controls in v0.1:

1. **Daily review cap — OFF by default (user choice, OD-8).** `userConfig.maxReviewsPerDay` exists as a quota guard but ships **disabled** (`0` = no cap), per the owner's decision to not bound automated volume by default. When set > 0, exceeding it returns a `QUOTA_GUARD` error with remediation (never a silent drop). **Consequence (stated plainly):** with the cap off, the *only* automatic quota/ToS defense is the rate-limit backoff (#2) — there is no proactive ceiling. The user owns this risk.
2. **Rate-limit backoff & detection (always on):** repeated `RATE_LIMITED` within a window short-circuits further automated calls for a cooldown and emits a visible warning, instead of hammering the endpoint. With the cap off, this is the primary guard.
3. **ToS posture documented:** README states plainly that automated/headless subscription use is at the user's risk and that the supported high-volume path is the **future API-key OD** (OD-8). The user opts into automation knowingly.
4. **Escape hatch:** re-enabling an API-key path for high-volume use is an explicit future OD (not v0.1).

Behavior on quota exhaustion at the call site is defined in §8 (fail visibly).

### 6.4 Version-churn handling

The SDK offloads churn to OpenAI **and is version-pinned via the committed lockfile** (so all users run the same SDK and upgrades are deliberate, not drift). The SDK bundles its **own pinned codex binary**, so the unversioned exec `--json` event stream is never parsed by us — eliminating the churn surface that motivated the original compat layer. With no exec fallback (OD-5), `codex-compat.mjs` is not built.

---

## 7. Feature designs

### 7.1 Scope resolution (session-first, Git-optional, gap-visible)

Precedence:
1. **Explicit file/dir paths** → review those targets. No Git.
2. **Pasted text/diff** (`--text`/stdin) → review as-is. No Git.
3. **`--session`** → the files this session created/modified, from the `PostToolUse` tracker (§5.4). If in a Git repo, intersect with the working-tree/diff for line context; otherwise review the touched files whole. No Git strictly required.
4. **`--base <ref>`** → `git diff $(git merge-base <ref> HEAD)..HEAD`. Requires Git.
5. **Default:**
   - Stop-gate → `--session` (session-touched files).
   - Manual inside a Git repo → working-tree diff.
   - Otherwise → `NO_SCOPE` error with guidance, never a crash.

**Tracker blind spot (made visible, per §8).** The `PostToolUse` tracker only records `Write`/`Edit`/`NotebookEdit`. Files mutated via `Bash` (e.g. `sed`, code generators, `git apply`, `mv`, formatters, build steps) are invisible to it. "Review the code the session produced" would therefore *silently* miss a whole class of changes — a false-coverage failure forbidden by §8. Mitigation:
- **Inside a Git repo:** `scope.mjs` computes the set difference between the working-tree diff and the tracker list. Any changed file **not** in the tracker (i.e. likely Bash-driven) is **added to the review scope** and the result carries `coverage: "git-augmented"`; when Bash-only files were added, a `coverageNote` lists them. The reviewer sees the real change set, not just the hooked subset.
- **Outside a Git repo:** the tracker is the only available signal. The result carries `coverage: "tracker-only"` plus a `coverageNote: "tracker-only (Bash edits not detectable)"` **visible warning**, so the caller knows coverage may be incomplete instead of assuming completeness.

**Resolution result (as implemented).** `resolveScope(input, deps) → {ok:true, scope} | {ok:false, error:{code:"NO_SCOPE",…}}`. `scope.coverage` is a typed enum — `"explicit" | "text" | "git-augmented" | "tracker-only" | "diff"` — and the human-readable warning lives in `scope.coverageNote`. Git ops (`git.mjs`) and the session tracker (`session-tracker.mjs`) are injected, so resolution is unit-testable without a real repo. `session` mode returns `ok` even when `targets` is empty; the stop-gate treats empty as a no-op ALLOW.

The orchestrator passes scope explicitly per story; the stop-gate uses session scope (and is a no-op when the session touched nothing reviewable).

### 7.2 Review

`prompts/review.md` — correctness / quality / security review → `review-output` schema (§9.1).

### 7.3 Adversarial review

`prompts/adversarial-review.md` — "challenge the design; question assumptions and trade-offs; find where it breaks under real conditions; assume it is wrong." Accepts `--focus`. Produces the **adversarial** schema (§9.2), which is design-oriented (assumptions, failure modes, trade-offs) rather than line-anchored defects — a regular review schema would mutilate this output.

**`sound` vs "did not run" (per §8).** A `sound` verdict means Codex ran and found no blocking challenges. It must never be inferred from an empty/failed run. The driver distinguishes:
- a completed run that returned zero challenges → `verdict: "sound"` (a real result);
- a run that failed, timed out, or produced an unparseable payload → a structured §8 error (`CODEX_ERROR`/`TIMEOUT`/…), **never** `sound`.
`review-schema.mjs` rejects a payload that lacks an explicit, model-emitted `verdict`; absence is an error, not silent approval.

### 7.4 Stop-gate circuit breaker

Opt-in via `userConfig.stopReviewGate` (default off). A bounded review→fix loop that **provably terminates** (it cannot loop forever) and is *designed* to converge on quality, but **does not claim guaranteed convergence** — when it cannot make progress it stops and hands to a human (fail open + visible). Grounded in: Self-Refine / FAIR-RAG / debugging-decay (gains plateau then regress past 2–3 iterations); "LLMs can't self-correct reasoning yet" (the **stop decision must be external**, never the model's); SonarQube/SARIF fingerprinting; and Claude Code's documented `stop_hook_active` + 8-block backstop.

**Per-`Stop` decision logic:**
```
1. If stop_hook_active == true            → ALLOW (reentrancy guard).
2. Acquire loop-state (keyed by session_id; advisory lock §4.4). iteration += 1.
3. scope = session-touched files (git-augmented when possible, §7.1).
   If empty / diff unchanged since last pass → ALLOW.
4. TRIP CHECKS (any true → OPEN: ALLOW + visible systemMessage summary of unresolved findings):
     - iteration > MAX_ITERATIONS (default 3)
     - token_budget_spent > BUDGET (default ~400k tokens / loop) — token usage IS observable
       (SP-1 confirmed `Turn.usage`). NOTE: each review bills ~94k input (~48k cached) + ~700
       output regardless of diff size (fixed Codex overhead), so the budget is sized to permit
       ~3 reviews; at the old ~150k it tripped after one review, defeating MAX_ITERATIONS.
     - no-progress: the set of OPEN blocking fingerprints has not strictly shrunk for 2 rounds
       (set-based, not count-based — see below)
     - oscillation: a fingerprint went addressed → reappeared
5. Run Codex review. For each finding:
     fp = hash("v1:" + category + normalize(message) + normalize(code_context))
     baselineState vs seen-set: new | unchanged | updated | absent
6. severity = host-derived (see "Severity ownership" below), NOT the raw model field.
   blocking = findings WHERE severity >= THRESHOLD (default BLOCKER only)
              AND baselineState == new AND status != contested
7. If blocking empty → record clean diff hash → ALLOW.
   Else → mark touched prior findings 'addressed'; any 'addressed' that reappears → 'contested' (excluded);
          return {decision:"block", reason: formatted blocking findings only}.
```

**Severity ownership (contradiction resolved).** There is exactly one source of truth for *gating* severity: **the host**, derived deterministically by category. The model-emitted `severity` field in the schema (§9.1) is **advisory only** — captured for display and for SP-1 measurement, but **not** used by the gate, because LLM severity self-rating is near-random. The schema documents the field as advisory; `loop-state.mjs` computes the gating severity via a category→severity map in host code and gates on that. (Previously the spec described both behaviors; the host-mapping behavior is canonical.)

**No-progress is set-based, not count-based.** Progress is measured by whether the *set* of OPEN blocking fingerprints strictly shrinks — i.e. previously-open blockers are actually being resolved — not by whether the raw count drops. This prevents the failure where the reviewer swaps one blocker for another (count flat but the set churns) or fixes 1-of-N each round (count decreasing but never converging within the cap). A round makes progress iff `open_blocking_now ⊊ open_blocking_prev`.

**Defaults:**

| Parameter | Default | Rationale |
|---|---|---|
| `MAX_ITERATIONS` | 3 | refinement plateaus/regresses past 2–3 |
| `SEVERITY_THRESHOLD` | BLOCKER only | reviewers over-report; raise the bar (tune to +MAJOR after measuring) |
| gate basis | **new findings only** | pre-existing nits never block (SonarQube "new code") |
| `TOKEN_BUDGET` | ~400k / loop | independent ceiling, OR'd with iteration cap — **active (SP-1 confirmed `Turn.usage`)**; sized for ~3 reviews given ~94k input/review fixed overhead |
| fingerprint | `hash(v1:category+norm(msg)+norm(context))` | location-independent, versioned; **`category` from a schema-forced enum** (SP-1 — see below) |
| oscillation | addressed→reappeared ⇒ contested, never re-block | kills the A→B→A quota sink |
| trip behavior | **fail open + visible summary**, hand to human | breaker can't converge ⇒ get out of the way, but visibly |
| reentrancy | `stop_hook_active` guard + rely on `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=8` | defense in depth |

**Known limitation (acknowledged, measured by V-1/telemetry).** With `BLOCKER`-only gating *and* reviewer over-reporting calibrated away, the realistic steady state may be a gate that **rarely blocks** while still paying per-turn cost (latency, quota, and — if observable — tokens). This is a deliberate bias toward *not* nagging. We ship it as the default but instrument block-rate; if the gate proves inert in practice we tune the threshold to `+MAJOR` (config already supports it) rather than shipping a noisier default unmeasured.

**Deliberate non-feature (v1):** never ask the reviewer to self-rate severity/confidence to gate (LLM severity judgment is near-random); severity is mapped by category in host code; all gating is deterministic.

> **Fingerprint stability — resolved by SP-1.** The dedup/oscillation layer requires a **stable category/rule id** per finding. SP-1 found: (1) a **schema-forced `category` enum is stable** across runs and validates reliably — so it is now the **default**, not a degradation fallback (the strict outputSchema constrains `category` to the closed enum listed in the §9.1 note); (2) however, the per-finding *set and titles* churn run-to-run (4–5 findings; secondary findings appear/disappear; wording varies), so `normalize(message)` is **not** a stable key on its own. Consequence: `category` anchors the fingerprint, but the `+norm(msg)` component carries residual noise — oscillation/no-progress detection works at the category-cluster level but should not be trusted for fine-grained per-message identity. The **iteration + token caps remain the only hard termination guarantee** (already the design). Degradation path retained: if a future model regresses on category stability, **disable** oscillation/no-progress trips and rely solely on the iteration + budget caps (logged visibly as reduced-precision mode). The severe/blocking findings (e.g. injection, off-by-one, race) were present in every SP-1 run, so gate stability is better than the raw finding-set churn suggests.

### 7.5 Background jobs (v0.1, OD-6)

For long-running manual reviews (e.g. a large repo or branch in one shot), `review --background`:
- `jobs.mjs` creates a job record in `${CLAUDE_PLUGIN_DATA}/state/<workspace-slug>-<hash>/` (writes via `statelock.mjs`, §4.4), spawns `task-worker` detached (`{ detached: true, stdio: "ignore" }`, `unref`), returns a `jobId`.
- `status` / `result` / `cancel` operate on that state; jobs pruned to a max count (newest-first by `updatedAt`).
- `SessionEnd` terminates jobs started by the ending session.

**Acknowledged cost (the reason this was debated):** background jobs are a real subsystem with their own failure modes (orphaned processes, stale locks, zombie workers) that **neither primary consumer needs** — the orchestrator subagent and the stop-gate are synchronous (they need the verdict to act). It is included in v0.1 by owner decision (OD-6) for ad-hoc manual use; the orphan/stale-lock risks are mitigated by `statelock.mjs` stale-lock breaking and `SessionEnd` cleanup, and exercised explicitly in the test plan (§12).

The orchestrator subagent and the stop-gate remain **synchronous**; background is for ad-hoc manual use only.

---

## 8. Error & failure policy

Structured error envelope from the driver:
```jsonc
{ "code": "RATE_LIMITED | QUOTA_GUARD | MODEL_UNAVAILABLE | AUTH_REQUIRED | CODEX_ERROR | TIMEOUT | NO_SCOPE | SCHEMA_INVALID",
  "message": "string", "remediation": "string?" }
```

**Principle: fail visibly, never falsely approve.** Failure classes:

1. **Codex unavailable** (rate-limit / quota-guard / auth / error — *not* a finding):
   - **Subagent / orchestrator / manual:** hard fail — propagate the structured error; the caller (orchestrator) aborts the story/epic rather than proceeding unreviewed.
   - **Stop-gate:** ALLOW the turn to end **with a loud `systemMessage` "⚠ TURN NOT REVIEWED: <reason>"**. It is explicitly marked unreviewed, never "approved"; blocking would only loop uselessly since Codex won't recover mid-turn. **OD-1 refinement (see below)** addresses the load-degradation concern.
2. **Schema-validation failure** (`SCHEMA_INVALID`): `review-schema.mjs` first applies tolerant normalization (§5.6/§9). If the payload *still* fails strict validation, this is treated as **Codex unavailable** (class 1), not as an approval — same visible handling. A malformed payload never becomes a passing verdict.
3. **Breaker can't converge** (loop exhausted, §7.4): fail open + visible summary of unresolved findings, hand to human.
4. **Scope coverage gap** (§7.1): not an error, but a **visible annotation** (`coverage` enum + `coverageNote`) on the result so partial coverage is never read as full coverage.

**OD-1 refinement (gate degradation under load).** The naive "always ALLOW with a warning on unavailability" degrades exactly under the high-volume load this plugin targets (rate-limits are *expected* per §6.3), turning the gate into "always allow + ignorable warning." To keep the warning meaningful:
- A single transient failure → ALLOW + visible "NOT REVIEWED" (as above).
- **Persistent** unavailability (N consecutive unreviewed turns, `userConfig.notReviewedStreakLimit`, default small) → escalate the message severity and surface a one-line actionable remediation (`run /codex-gate:setup` / raise quota / disable gate), so the user is prompted to act rather than habituate to noise.
- Hard fail-closed remains the documented alternative for users who want it (`userConfig.stopGateOnUnavailable: "allow" | "block"`, default `"allow"`), making OD-1 a real, user-owned choice rather than a silent default.

**Timeout policy:** single source of truth for the stop-gate timeout; the value in `hooks.json` matches the spawn timeout in the script. No dead constants.

---

## 9. Output schemas

**Dual-schema model (SP-1 finding — mandatory).** SP-1 proved the OpenAI structured-output backend rejects the schemas below if sent verbatim as `outputSchema`:

```
400 invalid_json_schema: 'required' must include every key in properties. Missing 'line_start'.
```

OpenAI's strict subset requires: **every** property in `required`, `additionalProperties:false`, optional fields modeled as **nullable** (`"type": ["integer","null"]`), and **no `minimum`/`maximum`/`format`** (rejected). So each schema exists in **two shapes**:

1. **Strict outputSchema** (`schemas/codex-output.*.strict.json`) — sent to the driver/Codex. All-required, nullable optionals, no numeric bounds. This is what the model is constrained to.
2. **Internal draft-07 schema** (`schemas/*-output.schema.json`, shown in §9.1/§9.2) — the richer validation target with genuine optionals + bounds, run by `review-schema.mjs`.

The pipeline is: send strict schema → receive payload (optionals come back as `null`) → **`dropNulls()` + tolerant normalization** (strip unknown keys, coerce common deviations) → validate against the internal draft-07 schema. Normalization is **required, not best-effort**: the strict schema *guarantees* nulls on absent optionals, which the draft-07 schema (typed, non-nullable optionals) would otherwise reject. SP-1 confirmed all runs validate `true` after this step (`spike/sp-1/FINDINGS.md`). A payload that still fails strict validation maps to `SCHEMA_INVALID` → treated as Codex-unavailable (§8), never a passing verdict.

### 9.1 `review-output.schema.json` (defect-oriented)

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object", "additionalProperties": false,
  "required": ["verdict", "summary", "findings", "next_steps"],
  "properties": {
    "verdict": { "enum": ["approve", "request_changes", "comment"] },
    "summary": { "type": "string" },
    "findings": { "type": "array", "items": {
      "type": "object", "additionalProperties": false,
      "required": ["category", "severity", "file", "title", "detail"],
      "properties": {
        "category": { "type": "string" },                 // stable id for fingerprinting (§7.4)
        "severity": { "enum": ["blocker", "major", "minor", "info"] },  // ADVISORY ONLY — not used for gating (§7.4)
        "file": { "type": "string" },
        "line_start": { "type": "integer", "minimum": 1 },
        "line_end": { "type": "integer", "minimum": 1 },
        "title": { "type": "string" },
        "detail": { "type": "string" },
        "suggestion": { "type": "string" }
      }
    }},
    "next_steps": { "type": "array", "items": { "type": "string" } }
  }
}
```
`severity` is **advisory** — SP-1 observed the model's self-rated severity flip for the *same* defect across runs (e.g. a race condition rated `major`, `major`, `blocker`), empirically confirming the §7.4 decision to derive gating severity from `category` in host code, never from this field. `category` powers fingerprinting; the **strict outputSchema constrains it to a closed category enum** (`correctness`, `security`, `concurrency`, `performance`, `data-integrity`, `error-handling`, `api-misuse`, `style`, `other`) — the free-string `type:"string"` shown here is the tolerant internal-validation shape; the strict variant sent to Codex enforces the closed set, which SP-1 confirmed yields a stable key.

### 9.2 `adversarial-output.schema.json` (design-oriented)

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object", "additionalProperties": false,
  "required": ["verdict", "summary", "challenges"],
  "properties": {
    "verdict": { "enum": ["sound", "request_changes", "reconsider"] },  // must be model-emitted; absence = error, never inferred (§7.3)
    "summary": { "type": "string" },
    "challenges": { "type": "array", "items": {
      "type": "object", "additionalProperties": false,
      "required": ["severity", "title", "argument"],
      "properties": {
        "severity": { "enum": ["blocker", "major", "minor", "info"] },  // advisory (adversarial review does not gate a loop)
        "title": { "type": "string" },
        "target": { "type": "string" },                   // assumption / decision / trade-off under attack
        "argument": { "type": "string" },                 // why it may be wrong
        "failure_mode": { "type": "string" },             // how it breaks under real conditions
        "file": { "type": "string" },                     // optional; design issues often have none
        "recommendation": { "type": "string" }
      }
    }},
    "next_steps": { "type": "array", "items": { "type": "string" } }
  }
}
```

`review-schema.mjs` validates/normalizes both against their files. Errors use the §8 envelope, never mixed into payloads. An empty `challenges` array with an explicit `verdict: "sound"` is a valid result; a missing/failed payload is an error, not `sound` (§7.3).

---

## 10. Security model

- **Read-only sandbox for the Codex subprocess** (`sandboxMode:"read-only"`): *Codex* cannot modify the working tree, even though it spawns its own shell commands to read scope files (confirmed in SP-1). This is the core trust-boundary improvement over gemini and is its precise scope.
- **Trust-boundary scope (clarified).** "Read-only by construction" applies to the **Codex subprocess**, not to the plugin as a whole. The companion runs via `Bash` (the subagent has `tools: Bash`; §5.2) with the **user's full privileges** — a buggy or compromised companion script can do anything the user can. The mitigations for *that* boundary are: minimal, audited companion code; no `../`/absolute paths; no secret writes; pinned dependencies (§3); and never shelling out to Codex with write/approval flags. We do **not** claim the plugin is sandboxed — only that the model-driven review step is.
- No API-key handling; subscription token owned by the Codex CLI. No secrets written to `${CLAUDE_PLUGIN_ROOT}` or session state.
- Subagent has `tools: Bash` only; no `mcpServers`/`hooks`/`permissionMode`.
- Stop-gate runs an external service synchronously on turn end — opt-in, bounded (§7.4), volume-capped (§6.3), and fails visibly (§8).
- Shared state writes are locked + atomic (§4.4) to avoid corruption from concurrent sessions.

---

## 11. Configuration

### 11.1 `plugin.json`

```jsonc
{
  "name": "codex-gate",
  "version": "0.1.0",
  "description": "Cross-model code review for Claude Code: review, adversarial review, and a converging stop-gate, powered by the Codex CLI on your ChatGPT subscription.",
  "author": { "name": "Vitor Mendonça" },
  "homepage": "https://github.com/vitorlm/codex-gate-plugin-cc",
  "repository": "https://github.com/vitorlm/codex-gate-plugin-cc",
  "license": "Apache-2.0",
  "keywords": ["codex", "code-review", "openai", "adversarial-review", "cross-model"],
  "userConfig": {
    "stopReviewGate":        { "type": "boolean", "title": "Enable stop review-gate",
                               "description": "Run a converging Codex review when a turn ends.", "default": false },
    "stopGateOnUnavailable": { "type": "string",  "title": "Stop-gate behavior when Codex is unavailable",
                               "description": "allow (warn, NOT REVIEWED) | block (fail-closed)", "default": "allow" },
    "notReviewedStreakLimit":{ "type": "number",  "title": "Escalate after N consecutive NOT REVIEWED turns",
                               "description": "After this many consecutive unreviewed turns, escalate the warning with an actionable remediation.", "default": 3, "min": 1, "max": 20 },
    "reviewModel":           { "type": "string",  "title": "Review model",
                               "description": "Codex model used for review and adversarial review (e.g. gpt-5.5).", "default": "gpt-5.5" },
    "maxIterations":         { "type": "number",  "title": "Stop-gate max iterations",
                               "description": "Hard ceiling on stop-gate review->fix rounds before the loop opens and hands to a human.", "default": 3, "min": 1, "max": 10 },
    "maxReviewsPerDay":      { "type": "number",  "title": "Daily automated-review cap (quota guard)",
                               "description": "0 = no cap (default). Set >0 to enforce a daily ceiling on automated reviews.", "default": 0, "min": 0 },
    "severityThreshold":     { "type": "string",  "title": "Stop-gate block threshold",
                               "description": "blocker | major | minor | info", "default": "blocker" }
  }
}
```
`defaultEnabled` omitted (enabled): no always-on *token* cost; the only external side effects (stop-gate, quota use) are themselves opt-in / bounded (OD-3, §6.3, §4.3). **Build note:** `claude plugin validate --strict` requires a `description` on **every** `userConfig` field — all are populated above.

### 11.2 `marketplace.json`

```jsonc
{
  "name": "vitorlm-codex-gate",
  "description": "Cross-model code review for Claude Code, powered by the Codex CLI on a ChatGPT subscription.",
  "owner": { "name": "Vitor Mendonça" },
  "plugins": [ { "name": "codex-gate", "source": "./plugins/codex-gate",
                 "description": "Cross-model code review for Claude Code." } ]
}
```
**Build note:** the top-level `description` is required by `claude plugin validate --strict` (a missing one is a warning, and `--strict` treats warnings as errors).

---

## 12. Testing strategy (TDD)

Runner: Node's built-in `node:test` + `node:assert/strict` (no extra runner dep). `npm run check` = Biome → `tsc` (JSDoc) → `node --test` → `claude plugin validate --strict`. Test files (`*.test.mjs`) are excluded from `tsc`; Biome ignores `spike/`, but `node --test` discovers `**/*.test.mjs` repo-wide, so the V-1 spike tests run too. **Status (steps 3–12): 192 tests passing** (175 plugin + 17 V-1 spike) across the suites marked ✓ below; collaborators are dependency-injected so unit tests need no real Codex/Git/network.

- **Unit (injected fakes, fixture payloads):**
  - ✓ `scope.mjs`: explicit files (non-Git), text (non-Git), `--session`, `--base`, working-tree default, `NO_SCOPE`, **git-augmented gap detection (Bash-edited file added to scope + `coverageNote`)**, **`tracker-only` coverage outside Git**, typed `coverage` enum, empty-session no-op; Git + tracker injected.
  - ✓ `git.mjs`: `isGitRepo`, `changedFiles` (porcelain, rename→new name), `diffFiles` (`base...HEAD`); `run` injected.
  - ✓ `session-tracker.mjs`: append accumulation, **read-time de-dup**, per-session isolation, `clear` (SessionEnd) cleanup (real fs in a tmp dir).
  - ✓ `session-tracker-hook.mjs`: `extractTouched` for Write/Edit (`file_path`) + NotebookEdit (`notebook_path`); null when no path.
  - ✓ `review-schema.mjs`: both schemas — valid, missing fields, bad enum, **tolerant normalization (null optionals dropped, extra keys stripped)**, **strict failure → `SCHEMA_INVALID`**, **verdict never inferred** (missing verdict / unparseable → error, never approve/sound).
  - `loop-state.mjs` + stop-gate: new-finding blocks, nit/pre-existing don't, fingerprint dedup, oscillation→contested, **set-based no-progress trip (count-flat-but-churning does NOT count as progress; 1-of-N decreasing does NOT falsely satisfy)**, iteration trip, **budget trip active-vs-inactive depending on token observability**, `stop_hook_active` allow, **host-derived severity used for gating (model severity ignored)**.
  - failure policy (§8): unavailable → hard fail (caller) vs visible-allow (gate); **OD-1 streak escalation**; **`stopGateOnUnavailable: block` path**; breaker trip → visible summary; **`sound` never inferred from failed adversarial run (§7.3)**.
  - ✓ `codex-sdk-driver.mjs` / `codex-driver.mjs`: **strips inherited `OPENAI_API_KEY`/`CODEX_API_KEY`** before constructing `Codex({env})` (subscription forced); read-only / approvals-never thread options; sends the strict `outputSchema(kind)`; happy path returns payload + `Turn.usage`; maps SDK throws + unparseable + schema-invalid → §8 envelope; seam wires real validator (fake Codex injected).
  - ✓ `models.mjs` (alias/default resolution), `args.mjs` (flag parser incl. unknown-flag + missing-value errors), `render.mjs` (verdict/challenge/error presentation), `prompts.mjs` (scope section + template + adversarial focus).
  - ✓ `quota.mjs` (§6.3): `maxPerDay=0` → no cap; `>0` → `QUOTA_GUARD` at the cap with daily reset; rate-limit cooldown activates at threshold within window and expires after cooldown; out-of-window hits ignored.
  - ✓ `loop-state.mjs` (§7.4): fingerprint stability, host-derived severity gating (model severity ignored), set-based no-progress, `preReview` trips (reentrancy/empty/unchanged/iteration/budget), `postReview` (new-only blocking, oscillation→contested, no-progress→open, token accrual), per-session persistence, `stopHookOutput`, and `sdk-install` ensure/skip/error.
  - ✓ `pipeline.mjs` `runReview`: quota gate short-circuits before any review; `NO_SCOPE` returned without a Codex call; happy path composes prompt + inverts `skipGitRepoCheck` + records success; `RATE_LIMITED` recorded for backoff; adversarial focus forwarded. Dispatcher (`codex-companion.mjs`) smoke-tested for usage / NO_SCOPE / bad-flag paths (no Codex call).
  - ✓ `statelock.mjs`: concurrent writers serialized (real-fs), stale-lock breaking (dead pid / old age), timeout when fresh-held, atomic `writeJsonAtomic` (no temp left behind), `readJson` fallback.
  - quota guard (§6.3): `maxReviewsPerDay=0` (default) → **no cap, no `QUOTA_GUARD`**; `>0` → cap enforced → `QUOTA_GUARD`; rate-limit backoff/cooldown active in both modes.
  - ✓ `state.mjs` (§7.5): deterministic per-workspace slug+hash, same-basename disambiguation, base-dir injection, null when no base dir.
  - ✓ `auth.mjs` / `setup.mjs` (§6.3, step 11): `probeAuth` injected-probe classification — `OK` / `AUTH_REQUIRED` / `RATE_LIMITED` (throttled ≠ not-authed) / `CODEX_ERROR`, reuse of a driver `{ok:false,error}` envelope, best-effort `authFilePresent` hint (never authoritative); `runSetup` authed / not-authed / throttled / sdk-absent-then-installed / install-failure / gate-config surfacing, and `gateConfigFromEnv` env→view mapping. Injected probe/ensureSdk/readAuthFile — never touches Codex/network/`~/.codex`.
  - ✓ `jobs.mjs` (§7.5): background lifecycle (create → run → result → prune → cancel); `SessionEnd` cleanup (`terminateSessionJobs`, per-session filtered); over `statelock` (atomic + lock); orphan/zombie-worker handling (`reconcileJob`: dead pid → error). Companion handlers (`spawnBackgroundReview` detached spawn + jobId, `runTaskWorker` writes result/error and never throws, `status`/`result`/`cancel`) tested with injected spawn/clock/id/runReview (no Codex).
  - **fingerprint degradation (§7.4): free-text-only Codex → oscillation/no-progress disabled, iteration cap still terminates, reduced-precision logged.**
- **Spike harnesses (gated on real Codex login):**
  - **SP-1:** SDK-on-subscription, `outputSchema`, category-id stability, token observability, strict-schema viability.
  - **V-1 ✓ (harness built; live run pending, human-gated):** cross-model (Codex) vs same-model (Claude) reviewer on 8 seeded-defect fixtures + 1 defect-free control (`spike/v-1/`). **Pure scoring (`score.mjs`) unit-tested** (17 tests): per-fixture true positives, the distinct TP classes Codex catches that Claude misses, FP counts → §0 verdict (`criterionMet` = edge on ≥30% of fixtures **and** acceptable Codex FP rate). Reviewers are **injected** (`codexReviewer` wired to the shipped driver read-only/subscription; `claudeReviewer` supplied by the human via Anthropic API or a Claude subagent) — the build/tests call **no** backend. The live run + 1.0 gate decision are manual/quota-gated (`spike/v-1/README.md`).
- **Integration (opt-in):** end-to-end review of a tiny fixture.
- **Tooling:** `node:test`; Biome + `tsc` via JSDoc (`esModuleInterop`; ajv imported as named `{ Ajv }`); runtime deps pinned in the lockfile (`@openai/codex-sdk@0.139.0`, `ajv@8.17.1`); CHANGELOG discipline; red→green TDD.

---

## 13. Versioning & distribution

- SemVer from `0.1.0`; **bump every release**. CHANGELOG per release.
- Runtime SDK pinned via committed `package-lock.json` (§4.2).
- Marketplace source by branch initially; pin by `sha` once published.
- `claude plugin validate --strict` in CI.
- Local dev: `claude --plugin-dir ./plugins/codex-gate`; `/reload-plugins`.

---

## 14. Open decisions

| ID | Decision | Adopted default | Alternative |
|---|---|---|---|
| OD-1 | Stop-gate on Codex **unavailability** | **Allow + loud "NOT REVIEWED"**, with **streak escalation** and a **user-selectable `block` mode** (§8) | Hard fail-closed by default |
| OD-2 | Manual commands model-invocability | **`disable-model-invocation: true`** (auto path = subagent) | Also model-invocable |
| OD-3 | `defaultEnabled` | **Enabled** | `false` |
| OD-4 | License | **Apache-2.0** | MIT |
| OD-5 | Transport | **SDK sole transport (pinned, bundled binary) — SP-1 confirmed on subscription; no exec fallback** | (resolved 2026-06-14; exec fallback dropped) |
| OD-6 | Background jobs | **Included in v0.1** (manual `--background` + status/result/cancel) | Defer to post-v0.1 |
| OD-7 | Scope default for stop-gate | **Session-touched files, git-augmented** (§7.1) | Working-tree diff |
| OD-8 | High-volume auth / quota cap | **Subscription only; `maxReviewsPerDay` cap OFF by default (no proactive ceiling)** | Default-on cap; future API-key path for ToS-safe high volume |
| OD-9 | Cross-model value | **Validate via V-1 before 1.0** | Assume the premise (rejected) |

---

## 15. Build sequence (informative; full plan via writing-plans)

1. ~~**SP-1 spike**~~ **DONE (2026-06-14)** — `@openai/codex-sdk` on subscription + structured output + token observability + category-enum stability + strict-schema viability all confirmed; deltas folded into §3/§5.6/§6.3/§7.4/§9. Evidence: `spike/sp-1/`.
2. **DONE** — Repo scaffold: `marketplace.json`, `plugin.json`, README/LICENSE/CHANGELOG, dev tooling (Biome, `tsc`, `node:test`), **committed lockfile** (pins `@openai/codex-sdk`, `ajv`). Validator surfaced two doc deltas (per-field + marketplace `description`).
3. **DONE** — Schemas **dual shape** (§9): strict outputSchemas + internal draft-07 + `review-schema.mjs` (`dropNulls`, `validate`, `strictOutputSchema`) with mandatory tolerant normalization (+ 12 tests).
4. **DONE** — `codex-driver.mjs` (thin seam) + `codex-sdk-driver.mjs` (sole transport; **strips inherited API-key env**; `Turn.usage`; §8 error mapping) — no exec driver / no compat layer (+ 12 tests, fake Codex injected).
5. **DONE** — `scope.mjs` (+ `git.mjs`) with **git-augmented gap detection** + `session-tracker.mjs` + `session-tracker-hook.mjs` PostToolUse hook (wired in `hooks/hooks.json`) (+ 26 tests).
6. **DONE** — `statelock.mjs`: `withLock` (advisory lockfile, stale-break by dead-pid/age) + `writeJsonAtomic`/`readJson` atomic helpers (+ 7 tests, incl. real-fs serialization + timeout).
7. **DONE** — `review` / `adversarial-review` foreground pipeline (`pipeline.mjs` `runReview`) + prompts + `render.mjs` + `args.mjs` + `models.mjs` + **quota guard (`quota.mjs`, §6.3)** + `codex-companion.mjs` dispatcher + command files (+ 40 tests, dispatcher smoke-tested).
8. **DONE** — `agents/codex-reviewer.md` (thin one-call forwarder, `tools: Bash`, returns verdict verbatim) + `skills/codex-reviewing` (SKILL.md + references/prompting.md).
9. **DONE** — `loop-state.mjs` (`fingerprint`/`gatingSeverity`/`madeProgress`/`preReview`/`postReview` + persistence) + `stop-review-gate-hook.mjs` (opt-in, fail-open, OD-1 unavailable handling) + `session-lifecycle-hook.mjs` + `sdk-install.mjs` (lazy pinned install) + `sdk-load.mjs` (**dynamic `import()` of the SDK from `${CLAUDE_PLUGIN_DATA}` by absolute file URL, with dev bare-specifier fallback** — resolves the distributed-install resolution gap; `codex-driver.mjs` loads `Codex` lazily, no static bare import); SessionStart/Stop/SessionEnd wired in `hooks.json` (+ 26 tests, hooks smoke-tested).
10. **DONE** — Background jobs (OD-6, §7.5): `state.mjs` (per-workspace slug+hash dir) + `jobs.mjs` (create/get/list/update/complete/cancel/prune + `reconcileJob` orphan recovery, over `statelock`) + detached `task-worker` + `status`/`result`/`cancel` subcommands & command files + `SessionEnd` job termination (+ 35 tests; injected spawn/clock/id/runReview — no Codex).
11. **DONE** — `/codex-gate:setup` login probe (authed vs throttled) + gate/quota config: `auth.mjs` (`probeAuth` injected-probe classification reusing `classifyError`; `RATE_LIMITED` ≠ not-authed; `authFileExists` cheap non-authoritative hint) + `setup.mjs` (`runSetup` pre-installs the pinned SDK via `ensureSdk`, reports SDK presence + auth state, surfaces the effective stop-gate config; `gateConfigFromEnv` reads the hook's env) + `setup` subcommand (replaces the stub; degrades cleanly with no data dir) + `commands/setup.md` (model-invocable; `Bash(node:*)`, `AskUserQuestion`; userConfig→env→hook single source of truth, `AskUserQuestion` guides intent) (+ 17 tests, injected probe/ensureSdk/readAuthFile — no Codex).
12. **DONE (harness built; live run pending, human-gated)** — V-1 validation harness (cross-model vs same-model) in `spike/v-1/`: 8 seeded-defect fixtures + 1 control with a defect-**class** manifest (labelled truth), pure deterministic scoring (`score.mjs`) computing the §0 verdict (Codex-edge fraction ≥30% **and** acceptable FP rate), and a runner (`run-v1.mjs`) with **injected** Codex/Claude reviewers (real backends opt-in, never called by the build). Scoring unit-tested (17 tests). The live run + the 1.0 gate decision are a manual/quota-gated activity (`spike/v-1/README.md`); this step delivers the harness, not the verdict.
13. **DONE (validate + docs done; publish = human push)** — `claude plugin validate ./plugins/codex-gate --strict` and `claude plugin validate . --strict` (marketplace) both pass; README (full `/codex-gate:` command surface incl. `--background`, install via `vitorlm/codex-gate-plugin-cc` + `codex-gate@vitorlm-codex-gate`, ToS/trust posture §6.3, `userConfig` table, dev `npm run check`) and CHANGELOG (`[0.1.0] - 2026-06-15`, `codex-gate-plugin-cc` link refs) finalized; secret scan clean; two cosmetic spike-lint advisories cleared (`spike/v-1/`). 192 tests green. The actual publish (`git push` to `github.com/vitorlm/codex-gate-plugin-cc`) is a human action; the live V-1 run + 1.0 gate decision remain pending/human-gated.
