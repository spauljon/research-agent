import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "../config.js";
import { CostTracker } from "../cost-tracker.js";
import { callClaudeWithBackoff } from "../agent-loop.js";
import { logger } from "../logger.js";
import type { StageResult } from "../types.js";

const SYSTEM_PROMPT = `You are a research query specialist. Take the user's query and rewrite it to be more specific, precise, and well-suited for web research.

Today is ${new Date().toISOString().split('T')[0]}.

A good research query:
- Uses precise terminology over vague phrases
- Focuses the scope so a search engine returns relevant results
- Avoids ambiguous pronouns or references

Return ONLY the improved query as plain text — no explanation, no preamble, no quotes. If the query is already well-formed, return it unchanged.`;

export async function stageReformulate(
  client: Anthropic,
  tracker: CostTracker,
  query: string
): Promise<StageResult> {
  const log = logger.child({ stage: "0 · Reformulate" });
  log.info("stage start");

  tracker.preflight();

  const response = await callClaudeWithBackoff(
    client,
    {
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Reformulate this research query: "${query}"` }],
    },
    "0 · Reformulate"
  );

  tracker.record(response.usage);

  const textBlock = response.content.find((b) => b.type === "text");
  const reformulated = textBlock?.text.trim() ?? query;

  log.info({ original: query, reformulated }, "stage complete");

  return { stage: "reformulate", success: true, data: reformulated };
}
