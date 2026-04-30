import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./config.js";
import { CostTracker, SpendCapExceeded } from "./cost-tracker.js";
import { stageSearch } from "./stages/search.js";
import { stageAnalyse } from "./stages/analyse.js";
import { stageSynthesize } from "./stages/synthesize.js";
import type { Source, StageResult } from "./types.js";

async function runResearchPipeline(query: string): Promise<void> {
  // maxRetries: SDK auto-retries 429/529 with exponential backoff.
  // Default is 2; we bump to 5 for agentic workloads where short bursts
  // can briefly exceed per-minute limits even on a paid tier.
  const client = new Anthropic({ maxRetries: 5 });

  const capUsd = Number(process.env.MAX_SPEND_USD ?? "2.50");
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(`Invalid MAX_SPEND_USD: ${process.env.MAX_SPEND_USD}`);
  }
  const tracker = new CostTracker(MODEL, capUsd);

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Research Agent — Multi-stage Pipeline   ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`Query: "${query}"`);
  console.log(`Model: ${MODEL}   Spend cap: $${capUsd.toFixed(2)}\n`);

  const results: StageResult[] = [];

  try {
    const searchResult = await stageSearch(client, tracker, query);
    results.push(searchResult);
    if (!searchResult.success) {
      console.error(`\n✗ Pipeline aborted at stage 1: ${searchResult.error}`);
      return;
    }
    const sources = searchResult.data as Source[];
    console.log(`✓ Fetched ${sources.length} sources`);

    const analyseResult = await stageAnalyse(client, tracker, query, sources);
    results.push(analyseResult);
    if (!analyseResult.success) {
      console.error(`\n✗ Pipeline aborted at stage 2: ${analyseResult.error}`);
      return;
    }
    console.log(`✓ Analysis complete`);

    const synthResult = await stageSynthesize(
      client,
      tracker,
      query,
      sources,
      analyseResult.data
    );
    results.push(synthResult);
    if (!synthResult.success) {
      console.error(`\n✗ Pipeline aborted at stage 3: ${synthResult.error}`);
      return;
    }
    console.log(`✓ Report written`);

    console.log(`\n── Pipeline complete ──`);
    console.log(`Stages run: ${results.length}`);
    console.log(`All succeeded: ${results.every((r) => r.success)}`);
    console.log(`Cost:    ${tracker.summary()}`);
    console.log(`Output:  ./output/report.md\n`);
  } catch (err) {
    if (err instanceof SpendCapExceeded) {
      console.error(`\n💰 ${err.message}`);
      console.error(`Stages completed before halt: ${results.filter((r) => r.success).length}`);
      console.error(`Cost: ${tracker.summary()}`);
      console.error(`Tip: re-run with MAX_SPEND_USD=<higher> to continue.\n`);
      return;
    }
    throw err;
  }
}

const query = process.argv[2] ?? "the current state of AI agent frameworks";
runResearchPipeline(query).catch(console.error);
