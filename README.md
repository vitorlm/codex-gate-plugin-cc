# codex-gate — cross-model code review for Claude Code

Delegate **code review** and **adversarial review** to OpenAI **Codex** (a different model family) from inside Claude Code. The thesis: a model is a weak judge of its own output — an independent model from another family catches error classes the generator misses in itself. Review runs on your **ChatGPT subscription** (cached `codex login`), never on an API key.

> **Status:** `0.1.0`, pre-release. Build complete (192 tests green; `claude plugin validate --strict` passes). The blocking transport spike **SP-1 passed** (2026-06-14) — `@openai/codex-sdk` runs on the ChatGPT subscription with structured output. The V-1 cross-model validation harness is built; its live run and the 1.0 gate decision remain a manual, quota-gated activity. See `docs/tech-spec.md`, `spike/sp-1/FINDINGS.md`, and `spike/v-1/README.md`. The marketplace entry is not yet published.

## Commands

All commands live under the `/codex-gate:` namespace:

- **`/codex-gate:review`** — correctness / quality / security review of the resolved scope. Add `--background` to run a long review (large repo or branch) as a detached job and poll it.
- **`/codex-gate:adversarial-review`** — challenges a design or document: assumptions, trade-offs, failure modes (no Git required — works on a standalone file or pasted text). Accepts `--focus <text>`.
- **`/codex-gate:setup`** — probe the Codex login (distinguishes *not authenticated* from *rate-limited*), pre-install the pinned SDK, and toggle the stop-gate.
- **`/codex-gate:status [jobId]`** — inspect background review job(s).
- **`/codex-gate:result <jobId>`** — fetch a completed background job's structured result.
- **`/codex-gate:cancel <jobId>`** — cancel a running background job.

Beyond the slash commands:

- **Stop review-gate** (opt-in) — a bounded, provably-terminating review→fix loop when a turn ends.
- **`codex-reviewer` subagent** — an isolated-context surface an orchestrator can call after each story.

Review scope is **session-first and Git-optional**: explicit files, pasted text, the files this session touched, or a `--base` diff. Git enables line-level diff context but is never required.

## Requirements

- [Codex CLI](https://github.com/openai/codex) installed and logged in with a **ChatGPT subscription** (`codex login`).
- Node.js ≥ 18.
- The Codex SDK (`@openai/codex-sdk`, version-pinned) is installed lazily on first review into the plugin's data dir.

## Install

```sh
# From the marketplace (once published):
/plugin marketplace add vitorlm/codex-gate-plugin-cc
/plugin install codex-gate@vitorlm-codex-gate

# Local development:
claude --plugin-dir ./plugins/codex-gate
```

Then run `/codex-gate:setup` to probe the login (it distinguishes *not authenticated* from *rate-limited*) and toggle the stop-gate.

## Configuration

Set via the plugin's `userConfig` (see `plugins/codex-gate/.claude-plugin/plugin.json`):

| Key | Default | Meaning |
|---|---|---|
| `stopReviewGate` | `false` | Run a converging Codex review when a turn ends. |
| `stopGateOnUnavailable` | `"allow"` | When Codex is unavailable: `allow` (warn, NOT REVIEWED) or `block` (fail-closed). |
| `notReviewedStreakLimit` | `3` | Escalate after N consecutive NOT REVIEWED turns. |
| `reviewModel` | `"gpt-5.5"` | Review model. |
| `maxIterations` | `3` | Stop-gate max iterations. |
| `maxReviewsPerDay` | `0` | `0` = no cap. Set `>0` for a daily automated-review ceiling. |
| `severityThreshold` | `"blocker"` | Stop-gate block threshold. |

## Trust & ToS posture — read this

- **Read-only for Codex.** The Codex subprocess runs in a `read-only` sandbox and cannot modify your working tree. This bounds the *review step*, not the whole plugin: the companion runs with your full user privileges (see `docs/tech-spec.md` §10).
- **Subscription, never an API key.** The driver **actively strips** `OPENAI_API_KEY`/`CODEX_API_KEY` from the environment it hands to Codex, so review always bills your ChatGPT subscription. If you keep an API key exported in your shell, it is *not* used here.
- **Automated/headless subscription use is at your own risk.** High-volume use (review after every story, on every turn) can exhaust quota and may carry ToS exposure beyond throttling. There is no proactive daily cap by default (`maxReviewsPerDay: 0`); the only always-on guard is rate-limit backoff. The supported high-volume path (an API-key option) is a future decision, not in `0.1`.

## Development

```sh
npm install        # installs pinned SDK + dev tooling; commit package-lock.json
npm run lint       # Biome
npm run typecheck  # tsc via JSDoc (checkJs)
npm run validate   # claude plugin validate --strict
npm run check      # all of the above
```

## License

[Apache-2.0](./LICENSE) © Vitor Mendonça
