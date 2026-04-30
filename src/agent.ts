import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./config.js";
import { CostTracker, SpendCapExceeded } from "./cost-tracker.js";
import { stageReformulate } from "./stages/reformulate.js";
import { stageSearch } from "./stages/search.js";
import { stageAnalyse } from "./stages/analyse.js";
import { stageSynthesize } from "./stages/synthesize.js";
import { logger, logPath } from "./logger.js";
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
  console.log(`Model: ${MODEL}   Spend cap: $${capUsd.toFixed(2)}`);
  console.log(`Log:   ${logPath}\n`);

  const results: StageResult[] = [];

  try {
    const reformulateResult = await stageReformulate(client, tracker, query);
    results.push(reformulateResult);
    const researchQuery =
      reformulateResult.success && typeof reformulateResult.data === "string"
        ? reformulateResult.data
        : query;

    if (researchQuery !== query) {
      console.log(`Reformulated query: "${researchQuery}"\n`);
    }

    const searchResult = await stageSearch(client, tracker, researchQuery);
    results.push(searchResult);
    if (!searchResult.success) {
      logger.error({ stage: 1, error: searchResult.error }, "pipeline aborted");
      return;
    }
    const sources = searchResult.data as Source[];
    logger.info({ sourceCount: sources.length }, "stage 1 complete");

    const analyseResult = await stageAnalyse(client, tracker, researchQuery, sources);
    results.push(analyseResult);
    if (!analyseResult.success) {
      logger.error({ stage: 2, error: analyseResult.error }, "pipeline aborted");
      return;
    }
    logger.info("stage 2 complete");

    const synthResult = await stageSynthesize(
      client,
      tracker,
      researchQuery,
      sources,
      analyseResult.data
    );
    results.push(synthResult);
    if (!synthResult.success) {
      logger.error({ stage: 3, error: synthResult.error }, "pipeline aborted");
      return;
    }
    logger.info("stage 3 complete");

    logger.info(
      {
        stagesRun: results.length,
        allSucceeded: results.every((r) => r.success),
        cost: tracker.summary(),
        output: "./output/report.md",
        log: logPath,
      },
      "pipeline complete"
    );
  } catch (err) {
    if (err instanceof SpendCapExceeded) {
      logger.error(
        {
          spent: err.spent,
          cap: err.cap,
          stagesCompleted: results.filter((r) => r.success).length,
          tip: "re-run with MAX_SPEND_USD=<higher> to continue",
        },
        err.message
      );
      return;
    }
    throw err;
  }
}

const query = process.argv[2] ?? "the current state of AI agent frameworks";
runResearchPipeline(query).catch(console.error);
