import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { SupabaseMcpClient } from "../mcp-client.js";
import type { Source, StageResult } from "../types.js";
import { logger } from "../logger.js";

export async function stagePersist(
  mcpClient: SupabaseMcpClient,
  query: string,
  sources: Source[],
  analysis: unknown
): Promise<StageResult> {
  const reportPath = join(process.cwd(), "output", "report.md");
  try {
    const report = await readFile(reportPath, "utf-8");
    const result = await mcpClient.insertResearchResult({ query, sources, analysis, report });
    logger.info({ id: result.id }, "stage 4 complete");
    return { stage: "persist", success: true, data: { id: result.id } };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, "stage 4 failed");
    return { stage: "persist", success: false, error };
  }
}
