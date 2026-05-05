import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MODEL_CONFIG, MODEL_PRICING } from "./config.js";
import { CostTracker, SpendCapExceeded } from "./cost-tracker.js";
import { createModelAdapter } from "./model-adapters/index.js";
import { stageReformulate } from "./stages/reformulate.js";
import { stageSearch } from "./stages/search.js";
import { stageAnalyse } from "./stages/analyse.js";
import { stageSynthesize } from "./stages/synthesize.js";
import { stagePersist } from "./stages/persist.js";
import { createMcpClient } from "./mcp-client.js";
import { logger, logPath } from "./logger.js";
import { loadCheckpoint, saveCheckpoint, clearCheckpoint } from "./checkpoint.js";
import type { Checkpoint, Source, StageResult } from "./types.js";
import type { SupabaseMcpClient } from "./mcp-client.js";
import type { ModelAdapter } from "./model-adapters/types.js";

const STAGE_NAMES: Record<number, string> = {
  0: "reformulate",
  1: "search",
  2: "analyse",
  3: "synthesize",
  4: "persist",
};

class PipelineAborted extends Error {}

function assertStageSuccess(result: StageResult, stage: number): void {
  if (!result.success) {
    logger.error({ stage, error: result.error }, "pipeline aborted");
    throw new PipelineAborted();
  }
}

async function runReformulateStage(
  adapter: ModelAdapter,
  tracker: CostTracker,
  query: string,
  results: StageResult[]
): Promise<string> {
  const result = await stageReformulate(adapter, tracker, query);
  results.push(result);
  const researchQuery = result.success && typeof result.data === "string" ? result.data : query;
  if (researchQuery !== query) console.log(`Reformulated query: "${researchQuery}"\n`);
  await saveCheckpoint(query, 0, { reformulatedQuery: researchQuery });
  return researchQuery;
}

async function runPersistStage(
  cp: Checkpoint | null,
  mcpClient: SupabaseMcpClient | null,
  query: string,
  sources: Source[],
  analysis: unknown,
  results: StageResult[]
): Promise<void> {
  if (cp?.completedStages.includes(4)) {
    logger.debug("stage 4 skipped (checkpoint)");
    console.log(`[checkpoint] persist\n`);
    return;
  }
  if (mcpClient === null) {
    logger.warn("stage 4 skipped — MCP server unreachable");
    return;
  }
  const result = await stagePersist(mcpClient, query, sources, analysis);
  results.push(result);
  assertStageSuccess(result, 4);
  await saveCheckpoint(query, 4, {});
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
  console.log(
    `Model: ${MODEL_CONFIG.provider}:${MODEL_CONFIG.model}   Spend cap: $${capUsd.toFixed(2)}`
  );
  console.log(`Log:   ${logPath}\n`);
}

async function executeStages(
  adapter: ModelAdapter,
  tracker: CostTracker,
  query: string,
  cp: Checkpoint | null,
  results: StageResult[],
  mcpClient: SupabaseMcpClient | null
): Promise<void> {
  // Stage 0: Reformulate
  let researchQuery: string;
  if (cp?.completedStages.includes(0) && cp.reformulatedQuery !== null) {
    researchQuery = cp.reformulatedQuery;
    logger.debug("stage 0 skipped (checkpoint)");
    console.log(`[checkpoint] reformulate → "${researchQuery}"\n`);
  } else {
    researchQuery = await runReformulateStage(adapter, tracker, query, results);
  }

  // Supabase cache check — skip the pipeline if a report already exists for this query
  if (mcpClient !== null) {
    const existing = await mcpClient.findResearchResult(query);
    if (existing?.report) {
      const outDir = join(process.cwd(), "output");
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, "report.md"), existing.report, "utf-8");
      console.log(`[supabase] Existing report found — written to ./output/report.md\n`);
      logger.info("existing report found in Supabase, skipping pipeline");
      return;
    }
  }

  // Stage 1: Search & Fetch
  let sources: Source[];
  if (cp?.completedStages.includes(1) && cp.sources !== null) {
    sources = cp.sources;
    logger.debug("stage 1 skipped (checkpoint)");
    console.log(`[checkpoint] search → ${sources.length} sources\n`);
  } else {
    const result = await stageSearch(adapter, tracker, researchQuery);
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
    const result = await stageAnalyse(adapter, tracker, researchQuery, sources);
    results.push(result);
    assertStageSuccess(result, 2);
    analysis = result.data;
    logger.info("stage 2 complete");
    await saveCheckpoint(query, 2, { analysis });
  }

  // Stage 3: Synthesise & Write
  if (cp?.completedStages.includes(3)) {
    logger.debug("stage 3 skipped (checkpoint)");
    console.log(`[checkpoint] synthesize\n`);
  } else {
    const result = await stageSynthesize(adapter, tracker, researchQuery, sources, analysis);
    results.push(result);
    assertStageSuccess(result, 3);
    logger.info("stage 3 complete");
    await saveCheckpoint(query, 3, {});
  }

  // Stage 4: Persist
  await runPersistStage(cp, mcpClient, query, sources, analysis, results);
}

async function runResearchPipeline(query: string): Promise<void> {
  const adapter = createModelAdapter();

  const capUsd = Number(process.env.MAX_SPEND_USD ?? "2.50");
  if (!Number.isFinite(capUsd) || capUsd <= 0)
    throw new Error(`Invalid MAX_SPEND_USD: ${process.env.MAX_SPEND_USD}`);
  const tracker = new CostTracker(
    `${MODEL_CONFIG.provider}:${MODEL_CONFIG.model}`,
    capUsd,
    MODEL_PRICING
  );
  const cp = await loadCheckpoint(query);

  printBanner(query, cp, capUsd);

  let mcpClient: SupabaseMcpClient | null = null;
  try {
    mcpClient = await createMcpClient(process.env.MCP_SERVER_URL);
  } catch (err) {
    logger.warn({ err }, "MCP server unreachable — stage 4 (persist) will be skipped");
  }

  const results: StageResult[] = [];
  try {
    await executeStages(adapter, tracker, query, cp, results, mcpClient);
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

const query = process.argv[2] ?? "the current state of AI agent langchain framework";
runResearchPipeline(query).catch(console.error);
