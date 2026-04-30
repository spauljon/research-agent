import Anthropic from "@anthropic-ai/sdk";
import { CostTracker } from "../cost-tracker.js";
import { runAgentLoop } from "../agent-loop.js";
import type { Source, StageResult } from "../types.js";

const SYSTEM_PROMPT = `You are a research writer in the third stage of a multi-stage pipeline.
You receive a query, raw sources, and a structured analysis. Your job is to write a clear,
well-structured research report in markdown, then save it using the write_report tool.

The report must include:
- Executive summary (2-3 sentences)
- Key findings (one section per theme from the analysis)
- Contradictions and open questions
- Citations (inline [1], [2] etc. with a references section)
- A confidence rating (High / Medium / Low) with justification

After calling write_report, confirm the filename and briefly summarise what was written.`;

export async function stageSynthesize(
  client: Anthropic,
  tracker: CostTracker,
  query: string,
  sources: Source[],
  analysis: unknown
): Promise<StageResult> {
  const userMessage = `Query: "${query}"

Analysis:
${JSON.stringify(analysis, null, 2)}

Sources for citation:
${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n")}

Write the report and save it as report.md.`;

  const result = await runAgentLoop(
    client,
    tracker,
    SYSTEM_PROMPT,
    userMessage,
    "3 · Synthesise & write"
  );

  return { stage: "synthesize", success: true, data: result.finalText };
}
