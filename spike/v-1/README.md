# V-1 — cross-model vs same-model validation harness

**Status: harness built; live run pending (human/quota-gated).** This step
delivers the harness and its tested scoring logic — **not** the verdict. The
live run and the resulting 1.0 gate decision are a manual activity (real Codex
login + a Claude same-model backend, both costing quota).

Mirrors `spike/sp-1/` in style: a self-contained research harness, not shipped
plugin code.

## What V-1 decides

The plugin's entire value thesis (tech-spec §0) is that **cross-model** review
(Claude generates, Codex/GPT reviews) catches defect classes a **same-model**
(Claude reviews Claude) reviewer misses. If it doesn't, the cross-model premise
— and the plugin — is not justified, and the simpler answer is a Claude
subagent.

**Success criterion (§0):** Codex finds **≥1 distinct true-positive defect
class that the Claude same-model reviewer misses, on ≥30% of fixtures, at an
acceptable false-positive rate.**

`score.mjs` encodes exactly this: `criterionMet = fractionWithCodexEdge ≥
threshold (0.30) AND codexFpRate ≤ fpRateLimit (0.5 mean FPs/fixture)`.

## Layout

| File | Role |
|---|---|
| `fixtures/*.js` | 8 seeded-defect fixtures + 1 defect-free control (`f09`). |
| `fixtures/manifest.json` | Ground truth: per-fixture seeded defect **classes** + the class taxonomy. |
| `score.mjs` | **Pure, deterministic scoring** (the load-bearing, 1.0-gating part). No I/O, no clock, no randomness. |
| `score.test.mjs` | Unit tests for the scoring math (edge counting, ≥30% boundary, FP counting, both-miss/both-catch, hallucination guard). |
| `run-v1.mjs` | Runner glue: load fixtures → run injected reviewers → normalize findings to classes → `scoreAll` → verdict. |
| `run-v1.test.mjs` | Tests the runner glue + class-normalization with **synthetic** reviewers (no live backend). |

Tests run under repo-wide `node --test` (biome and `tsc` exclude `spike/`).

## The defect-class taxonomy

Findings are scored as **classes** (`namespace:slug`), not free text — SP-1
showed finding titles churn run-to-run but the coarse `category` enum is stable.
V-1 refines that coarse category into a finer class using stable keyword cues in
the finding title/detail (`classifyFinding` in `run-v1.mjs`). The keyword map is
the **only** place fixture-specific knowledge lives and is applied **identically
to both reviewers**, so neither side is advantaged. An unclassifiable finding is
dropped (not counted as a false positive of some unrelated class).

Seeded classes (truth) span: `correctness:{off-by-one,float-money,logic,
mutation}`, `security:{sqli,timing,weak-crypto,path-traversal}`,
`concurrency:race`, `data-integrity:unvalidated`, `performance:n-plus-one`,
`error-handling:unhandled`, `resource:leak`, `api-misuse:shallow-copy`.

## How the two review sides are supplied (injected)

Both review-producing calls are **injected** so the harness is runnable by a
human but calls **no** backend during the build/tests.

- **Codex cross-model (real):** `makeRealCodexReviewer()` wires the shipped
  plugin driver (`plugins/codex-gate/scripts/lib/codex-driver.mjs`) — read-only
  sandbox, ChatGPT subscription, **no API key**. Constructing it does nothing;
  only invoking the returned function calls Codex. Requires a valid
  `codex login`.
- **Claude same-model (you supply it):** intentionally **not** implemented.
  Provide a `claudeReviewer(fixture)` that returns
  `{ findings: [{ category, title, detail }] }` (same shape as Codex, so the
  same `classifyFinding` applies). Two options:
  1. **Anthropic API** — call a Claude model with an equivalent review prompt
     over the fixture source. Requires `ANTHROPIC_API_KEY`.
  2. **Claude subagent** — dispatch the same review task to a Claude subagent
     and adapt its output to the finding shape.

  Use the **same model family that generates code in the loop** (the
  "same-model" arm) and an **equivalent prompt** to the Codex side, or the
  comparison is unfair.

## Running it live (human, quota-gated — NOT part of the build)

```js
import { runHarness, makeRealCodexReviewer } from "./run-v1.mjs";

const codexReviewer = await makeRealCodexReviewer();       // needs `codex login`
const claudeReviewer = /* your Anthropic-API or subagent fn */;

const verdict = await runHarness({ codexReviewer, claudeReviewer });
console.log(JSON.stringify(verdict, null, 2));
// gate on verdict.criterionMet
```

`run-v1.mjs` is **library code**; running it directly from the CLI exits 2 on
purpose — it must not run live by accident.

### Expected cost (from SP-1 evidence)

SP-1 measured **~94k input tokens (≈48k cached) + ~650–800 output** per Codex
review of an ~18-line fixture; the ~94k is mostly fixed Codex overhead, not
fixture size. V-1 has **9 fixtures × 1 Codex review** ≈ **~850k input tokens**
on the subscription, plus 9 Claude reviews on whatever backend you supply. Run
sequentially and watch for `RATE_LIMITED`/`QUOTA` (the driver maps these per
§8). Re-run a fixture set 2–3× if you want to smooth the finding-set churn SP-1
documented before trusting a borderline verdict.

## Interpreting the verdict

`scoreAll(...)` returns:

- `criterionMet` — the §0 gate (edge fraction **and** FP rate).
- `fractionWithCodexEdge` / `fixturesWithCodexEdge` — the ≥30% numerator.
- `codexFpRate` / `claudeFpRate` — mean false positives per fixture (the
  control `f09` is where FPs are most telling).
- `perFixture[]` — per fixture: Codex/Claude true positives, `codexEdgeClasses`
  (the distinct TP classes Codex caught that Claude missed), and false
  positives for both sides.

**If `criterionMet` is false on a fair live run, the cross-model thesis is not
supported and the 1.0 decision should reconsider the plugin (revert to a Claude
subagent), per §0 / OD-9.**

## Caveats (don't over-read a single run)

- Small N (9). The threshold is a directional signal, not a statistical proof.
- Finding-set churn (SP-1): secondary findings appear/disappear run-to-run.
  Prefer a small multi-run aggregate for borderline verdicts.
- `classifyFinding` is keyword-based and curated for these fixtures; extending
  the fixture set means extending the map. Keep it symmetric across reviewers.
