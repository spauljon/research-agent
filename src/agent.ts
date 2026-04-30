import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./config.js";
import { CostTracker, SpendCapExceeded } from "./cost-tracker.js";
import { stageReformulate } from "./stages/reformulate.js";
import { stageSearch } from "./stages/search.js";
import { stageAnalyse } from "./stages/analyse.js";
import { stageSynthesize } from "./stages/synthesize.js";
import { logger, logPath } from "./logger.js";
import { loadCheckpoint, saveCheckpoint, clearCheckpoint } from "./checkpoint.js";
import type { Checkpoint, Source, StageResult } from "./types.js";

const STAGE_NAMES: Record<number, string> = {
  0: "reformulate",
  1: "search",
  2: "analyse",
};

class PipelineAborted extends Error {}

function assertStageSuccess(result: StageResult, stage: number): void {
  if (!result.success) {
    logger.error({ stage, error: result.error }, "pipeline aborted");
    throw new PipelineAborted();
  }
}

function printBanner(query: string, cp: Checkpoint | null, capUsd: number): void {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Research Agent — Multi-stage Pipeline   ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`Query: "${query}"`);
  if (cp && cp.completedStages.length > 0) {
    const doneNames = cp.completedStages.map((s) => STAGE_NAMES[s] ?? s).join(", ");
    console.log(`Resuming — completed stages: ${doneNames}`);
  }
  console.log(`Model: ${MODEL}   Spend cap: $${capUsd.toFixed(2)}`);
  console.log(`Log:   ${logPath}\n`);
}

async function executeStages(
  client: Anthropic,
  tracker: CostTracker,
  query: string,
  cp: Checkpoint | null,
  results: StageResult[]
): Promise<void> {
  // Stage 0: Reformulate
  let researchQuery: string;
  if (cp?.completedStages.includes(0) && cp.reformulatedQuery !== null) {
    researchQuery = cp.reformulatedQuery;
    logger.debug("stage 0 skipped (checkpoint)");
    console.log(`[checkpoint] reformulate → "${researchQuery}"\n`);
  } else {
    const result = await stageReformulate(client, tracker, query);
    results.push(result);
    researchQuery = result.success && typeof result.data === "string" ? result.data : query;
    if (researchQuery !== query) console.log(`Reformulated query: "${researchQuery}"\n`);
    await saveCheckpoint(query, 0, { reformulatedQuery: researchQuery });
  }

  // Stage 1: Search & Fetch
  let sources: Source[];
  if (cp?.completedStages.includes(1) && cp.sources !== null) {
    sources = cp.sources;
    logger.debug("stage 1 skipped (checkpoint)");
    console.log(`[checkpoint] search → ${sources.length} sources\n`);
  } else {
    const result = await stageSearch(client, tracker, researchQuery);
    results.push(result);
    assertStageSuccess(result, 1);
    sources = result.data as Source[];
    logger.info({ sourceCount: sources.length }, "stage 1 complete");
    await saveCheckpoint(query, 1, { sources });
  }

  // Stage 2: Analyse
  let analysis: unknown;
  if (cp?.completedStages.includes(2) && cp.analysis !== null) {
    analysis = cp.analysis;
    logger.debug("stage 2 skipped (checkpoint)");
    console.log(`[checkpoint] analyse\n`);
  } else {
    const result = await stageAnalyse(client, tracker, researchQuery, sources);
    results.push(result);
    assertStageSuccess(result, 2);
    analysis = result.data;
    logger.info("stage 2 complete");
    await saveCheckpoint(query, 2, { analysis });
  }

  // Stage 3: Synthesise & Write (never skipped — idempotent side effect)
  const result = await stageSynthesize(client, tracker, researchQuery, sources, analysis);
  results.push(result);
  assertStageSuccess(result, 3);
  logger.info("stage 3 complete");
}

async function runResearchPipeline(query: string): Promise<void> {
  // maxRetries: SDK auto-retries 429/529 with exponential backoff.
  // Default is 2; we bump to 5 for agentic workloads where short bursts
  // can briefly exceed per-minute limits even on a paid tier.
  const client = new Anthropic({ maxRetries: 5 });

  const capUsd = Number(process.env.MAX_SPEND_USD ?? "2.50");
  if (!Number.isFinite(capUsd) || capUsd <= 0)
    throw new Error(`Invalid MAX_SPEND_USD: ${process.env.MAX_SPEND_USD}`);
  const tracker = new CostTracker(MODEL, capUsd);
  const cp = await loadCheckpoint(query);

  printBanner(query, cp, capUsd);

  const results: StageResult[] = [];
  try {
    await executeStages(client, tracker, query, cp, results);
    await clearCheckpoint(query);
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
    if (err instanceof PipelineAborted) return;
    if (err instanceof SpendCapExceeded) {
      logger.error(
        {
          spent: err.spent,
          cap: err.cap,
          stagesCompleted: results.filter((r) => r.success).length,
          tip: "checkpoint saved — re-run with the same query to resume",
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
