import { CostTracker } from "../cost-tracker.js";
import { logger } from "../logger.js";
import type { ModelAdapter } from "../model-adapters/types.js";
import type { StageResult } from "../types.js";

const SYSTEM_PROMPT = `You are a research query specialist. Take the user's query and rewrite it to be more specific, precise, and well-suited for web research.

Today is ${new Date().toISOString().split('T')[0]}.

A good research query:
- Uses precise terminology over vague phrases
- Focuses the scope so a search engine returns relevant results
- Avoids ambiguous pronouns or references

Return ONLY the improved query as plain text — no explanation, no preamble, no quotes. If the query is already well-formed, return it unchanged.`;

export async function stageReformulate(
  adapter: ModelAdapter,
  tracker: CostTracker,
  query: string
): Promise<StageResult> {
  const log = logger.child({ stage: "0 · Reformulate" });
  log.info("stage start");

  tracker.preflight();

  const response = await adapter.sendMessage({
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Reformulate this research query: "${query}"` }],
    maxTokens: 256,
    stageName: "0 · Reformulate",
  });

  if (response.stopReason === "max_tokens") {
    throw new Error(`Stage "0 · Reformulate" hit max_tokens. Increase max_tokens or reduce work.`);
  }
  if (response.stopReason === "tool_use") {
    throw new Error(`Stage "0 · Reformulate" unexpectedly attempted tool use`);
  }

  tracker.record(response.usage);

  const reformulated = response.text.trim() || query;

  log.info({ original: query, reformulated }, "stage complete");

  return { stage: "reformulate", success: true, data: reformulated };
}
