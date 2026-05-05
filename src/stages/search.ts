import { CostTracker } from "../cost-tracker.js";
import { runAgentLoop } from "../agent-loop.js";
import { logger } from "../logger.js";
import type { ModelAdapter } from "../model-adapters/types.js";
import type { Source, StageResult } from "../types.js";

const SYSTEM_PROMPT = `You are a research assistant in the first stage of a multi-stage pipeline.
Your job is to find 3-5 high-quality sources for the given query.

Workflow:
1. Use search_web to find candidate URLs (start with one search, refine if needed)
2. Pick the 3 most promising results — quality over quantity, max 5
3. For EACH chosen URL, call fetch_url to retrieve its content
4. Once you've fetched the sources you want, return a JSON array listing them

Return ONLY a JSON array in this exact shape — DO NOT include the page content:
[{ "url": "...", "title": "..." }]

The pipeline already has the content from your fetch_url calls — you just need
to confirm which URLs you want to include in the final source list.`;

export async function stageSearch(
  adapter: ModelAdapter,
  tracker: CostTracker,
  query: string
): Promise<StageResult> {
  const result = await runAgentLoop(
    adapter,
    tracker,
    SYSTEM_PROMPT,
    `Find sources for this research query: "${query}"`,
    "1 · Search & fetch"
  );

  try {
    const jsonMatch = result.finalText.match(/\[[\s\S]*\]/);
    const claudeSources: { url: string; title: string }[] = jsonMatch
      ? JSON.parse(jsonMatch[0])
      : [];

    // Assemble full Source objects by joining Claude's URL list with the
    // content captured during the loop. URLs Claude lists but never fetched
    // (or where fetch failed) get skipped with a warning.
    const sources: Source[] = [];
    for (const cs of claudeSources) {
      const content = result.fetchedContent.get(cs.url);
      if (!content) {
        logger.warn({ url: cs.url }, "skipping source — no content captured for this URL");
        continue;
      }
      sources.push({
        url: cs.url,
        title: cs.title,
        content,
        fetchedAt: new Date().toISOString(),
      });
    }

    if (sources.length === 0) {
      return {
        stage: "search",
        success: false,
        error: "No sources successfully assembled (Claude returned URLs but none had captured content)",
      };
    }

    return { stage: "search", success: true, data: sources };
  } catch (err) {
    return {
      stage: "search",
      success: false,
      error: `Failed to parse sources JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
