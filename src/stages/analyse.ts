import Anthropic from "@anthropic-ai/sdk";
import { CostTracker } from "../cost-tracker.js";
import { runAgentLoop } from "../agent-loop.js";
import type { Source, StageResult } from "../types.js";

const SYSTEM_PROMPT = `You are a research analyst in the second stage of a multi-stage pipeline.
You receive a query and a set of source documents. Your job is to:
1. Identify the 3-5 most important themes or findings across the sources
2. Note any contradictions or gaps
3. Flag which sources are most credible/relevant
4. Return a structured analysis in JSON

Return ONLY JSON in this shape:
{
  "themes": [{ "title": "...", "summary": "...", "sources": ["url1", ...] }],
  "contradictions": ["..."],
  "gaps": ["..."],
  "topSources": ["url1", "url2"]
}

Do not call any tools — pure reasoning over the provided sources.`;

export async function stageAnalyse(
  client: Anthropic,
  tracker: CostTracker,
  query: string,
  sources: Source[]
): Promise<StageResult> {
  const userMessage = `Query: "${query}"

Sources:
${sources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content}`).join("\n\n---\n\n")}

Analyse these sources and return structured JSON.`;

  const result = await runAgentLoop(
    client,
    tracker,
    SYSTEM_PROMPT,
    userMessage,
    "2 · Analyse"
  );

  try {
    const jsonMatch = result.finalText.match(/\{[\s\S]*\}/);
    const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    return { stage: "analyse", success: true, data: analysis };
  } catch {
    return {
      stage: "analyse",
      success: false,
      error: "Failed to parse analysis JSON",
    };
  }
}
