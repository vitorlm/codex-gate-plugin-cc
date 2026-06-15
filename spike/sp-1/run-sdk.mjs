import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Codex } from "@openai/codex-sdk";
import {
  HERE,
  subscriptionEnv,
  loadSchema,
  strictValidator,
  dropNulls,
  REVIEW_PROMPT,
  classifyError,
  tryParseJson,
} from "./lib.mjs";

const STABILITY_RUNS = Number(process.env.SP1_RUNS ?? 3);

async function runOnce({ codex, outputSchema, internalSchema, label }) {
  const started = process.hrtime.bigint();
  const thread = codex.startThread({
    sandboxMode: "read-only",
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    workingDirectory: HERE,
  });
  const turn = await thread.run(REVIEW_PROMPT, { outputSchema });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  const parsed = tryParseJson(turn.finalResponse ?? "");
  // Tolerant normalization, then validate against the internal draft-07 schema.
  const normalized = parsed.ok ? dropNulls(parsed.value) : null;
  const validate = strictValidator(internalSchema);
  const valid = parsed.ok ? validate(normalized) : false;

  return {
    label,
    ms: Math.round(ms),
    threadId: thread.id,
    usage: turn.usage,
    finalResponseLen: (turn.finalResponse ?? "").length,
    itemTypes: turn.items.map((i) => i.type),
    parseOk: parsed.ok,
    salvaged: !!parsed.salvaged,
    strictValid: valid,
    strictErrors: valid ? null : (validate.errors ?? parsed.error ?? null),
    payload: normalized,
  };
}

function summarizeFindings(payload) {
  if (!payload?.findings) return [];
  return payload.findings.map((f) => ({
    category: f.category,
    severity: f.severity,
    title: f.title,
    line: f.line_start ?? null,
  }));
}

async function main() {
  const { env, stripped } = subscriptionEnv();
  console.log(`[auth] stripped inherited API-key vars: ${stripped.join(", ") || "(none)"}`);
  console.log(`[auth] forcing ChatGPT subscription login from ~/.codex/auth.json`);

  const codex = new Codex({ env });
  const report = { meta: { strippedEnv: stripped, runs: STABILITY_RUNS }, freeCategory: [], enumCategory: null, error: null };

  try {
    // --- Variant A: free-string category, repeated for stability ---
    const outA = loadSchema("codex-output.review.strict.json");
    const intA = loadSchema("review-output.schema.json");
    for (let i = 0; i < STABILITY_RUNS; i++) {
      const r = await runOnce({ codex, outputSchema: outA, internalSchema: intA, label: `free#${i + 1}` });
      report.freeCategory.push(r);
      console.log(
        `[free#${i + 1}] ${r.ms}ms valid=${r.strictValid} parse=${r.parseOk} ` +
          `findings=${r.payload?.findings?.length ?? "-"} ` +
          `usage(in/out/reason)=${r.usage ? `${r.usage.input_tokens}/${r.usage.output_tokens}/${r.usage.reasoning_output_tokens}` : "null"}`,
      );
      for (const f of summarizeFindings(r.payload)) {
        console.log(`        - [${f.severity}] (${f.category}) ${f.title} @${f.line}`);
      }
    }

    // --- Variant B: enum-constrained category (degradation plan §7.4a) ---
    const outB = loadSchema("codex-output.review.enum.strict.json");
    const intB = loadSchema("review-output.enum.schema.json");
    const rb = await runOnce({ codex, outputSchema: outB, internalSchema: intB, label: "enum" });
    report.enumCategory = rb;
    console.log(
      `[enum]   ${rb.ms}ms valid=${rb.strictValid} parse=${rb.parseOk} ` +
        `findings=${rb.payload?.findings?.length ?? "-"}`,
    );
    for (const f of summarizeFindings(rb.payload)) {
      console.log(`        - [${f.severity}] (${f.category}) ${f.title} @${f.line}`);
    }
  } catch (err) {
    report.error = { code: classifyError(err), message: String(err?.message ?? err) };
    console.error(`[ERROR] ${report.error.code}: ${report.error.message}`);
  }

  // --- Verdict on the five SP-1 questions ---
  const free = report.freeCategory.filter((r) => r.parseOk);
  const q1 = free.length > 0 && !report.error; // SDK ran on subscription + outputSchema
  const q3 = free.some((r) => r.usage && Number.isFinite(r.usage.output_tokens)); // token usage observable
  const q4 = free.some((r) => r.strictValid); // strict additionalProperties:false viable
  // q2: category stability across free runs
  const catSets = free.map((r) =>
    new Set((r.payload?.findings ?? []).map((f) => String(f.category).toLowerCase())),
  );
  const allCats = [...new Set(catSets.flatMap((s) => [...s]))];
  report.verdict = {
    "SP1-Q1_sdk_subscription_outputSchema": q1,
    "SP1-Q3_token_usage_observable": q3,
    "SP1-Q4_strict_schema_viable": q4,
    "SP1-Q2_category_vocab_seen": allCats,
    "SP1-Q2_enum_constraint_valid": report.enumCategory?.strictValid ?? null,
  };

  writeFileSync(resolve(HERE, "report-sdk.json"), JSON.stringify(report, null, 2));
  console.log("\n=== SP-1 SDK verdict ===");
  console.log(JSON.stringify(report.verdict, null, 2));
  console.log("\nFull report → spike/sp-1/report-sdk.json");
}

main();
