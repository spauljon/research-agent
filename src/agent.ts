import Anthropic from "@anthropic-ai/sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Source {
  url: string;
  title: string;
  content: string;
  fetchedAt: string;
}

interface PipelineState {
  query: string;
  sources: Source[];
  analysis: string;
  report: string;
}

interface StageResult {
  stage: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Tavily client ────────────────────────────────────────────────────────────
//
// Two endpoints:
//   /search   → returns a list of results, each with a short `content` snippet
//   /extract  → takes a URL (or list of URLs) and returns full `raw_content`
//
// We deliberately use raw fetch instead of a Tavily SDK so you can see the
// actual HTTP shape. In production you might prefer the official SDK.

const TAVILY_BASE = "https://api.tavily.com";

interface TavilySearchResult {
  url: string;
  title: string;
  content: string;
  score: number;
  raw_content?: string | null;
}

interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  response_time: number;
}

interface TavilyExtractResult {
  url: string;
  raw_content: string;
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failed_results: { url: string; error: string }[];
  response_time: number;
}

async function tavilySearch(
  query: string,
  maxResults: number
): Promise<TavilySearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY environment variable is not set");

  const response = await fetch(`${TAVILY_BASE}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: Math.min(maxResults, 5),
      search_depth: "basic",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily search failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<TavilySearchResponse>;
}

async function tavilyExtract(url: string): Promise<TavilyExtractResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY environment variable is not set");

  const response = await fetch(`${TAVILY_BASE}/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      urls: [url],
      extract_depth: "basic",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily extract failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<TavilyExtractResponse>;
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_web",
    description:
      "Search the web for sources relevant to a query. Returns a list of URLs, titles, and short snippets. " +
      "Use this first to discover candidate sources, then call fetch_url for the ones you want full content from.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        num_results: {
          type: "number",
          description: "How many results to return (max 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch the full text content of a single URL. Use this after search_web to get the complete article body for sources you want to analyse in depth.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "write_report",
    description:
      "Save the final research report to disk as a markdown file. Call this once analysis is complete.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string",
          description: "Output filename (e.g. report.md)",
        },
        content: {
          type: "string",
          description: "Full markdown content of the report",
        },
      },
      required: ["filename", "content"],
    },
  },
];

// ─── Tool handlers ─────────────────────────────────────────────────────────────

async function handleSearchWeb(input: {
  query: string;
  num_results?: number;
}): Promise<string> {
  console.log(`  [tool] search_web: "${input.query}"`);
  const data = await tavilySearch(input.query, input.num_results ?? 3);

  const slim = data.results.map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.content,
  }));
  return JSON.stringify(slim);
}

async function handleFetchUrl(input: { url: string }): Promise<string> {
  console.log(`  [tool] fetch_url: ${input.url}`);
  const data = await tavilyExtract(input.url);

  if (data.failed_results.length > 0) {
    const failure = data.failed_results[0];
    return JSON.stringify({
      url: input.url,
      error: failure?.error ?? "Unknown extraction error",
    });
  }

  const result = data.results[0];
  if (!result) {
    return JSON.stringify({ url: input.url, error: "No content extracted" });
  }

  // Trim long pages so we don't blow the context window
  const MAX_CHARS = 12000;
  const content =
    result.raw_content.length > MAX_CHARS
      ? result.raw_content.slice(0, MAX_CHARS) + "\n\n[...truncated]"
      : result.raw_content;

  return JSON.stringify({
    url: result.url,
    content,
  });
}

async function handleWriteReport(input: {
  filename: string;
  content: string;
}): Promise<string> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const outputPath = path.join(process.cwd(), "output", input.filename);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, input.content, "utf-8");
  console.log(`  [tool] write_report → ${outputPath}`);
  return JSON.stringify({ success: true, path: outputPath });
}

// ─── Tool dispatcher ────────────────────────────────────────────────────────

async function dispatchTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "search_web":
      return handleSearchWeb(input as { query: string; num_results?: number });
    case "fetch_url":
      return handleFetchUrl(input as { url: string });
    case "write_report":
      return handleWriteReport(input as { filename: string; content: string });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────
//
// Runs Claude with the given tools until it stops calling them.
//
// Design note — captureFetched:
// When Claude calls fetch_url, we store the returned content in this Map so
// the pipeline has it directly. Claude only needs to acknowledge the URL was
// fetched; it doesn't need to echo the content back through the model in its
// final JSON. This avoids round-tripping tens of thousands of characters
// through the API (which previously caused max_tokens overruns).

interface AgentLoopResult {
  finalText: string;
  fetchedContent: Map<string, string>; // url → raw extracted text
}

async function runAgentLoop(
  client: Anthropic,
  systemPrompt: string,
  userMessage: string,
  stageName: string
): Promise<AgentLoopResult> {
  console.log(`\n── Stage: ${stageName} ──`);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];
  const fetchedContent = new Map<string, string>();

  while (true) {
    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 8192, // bumped from 4096 to give stages more room
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    // Defensive stop_reason handling — fail loudly on anything unexpected
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return {
        finalText: textBlock ? textBlock.text : "",
        fetchedContent,
      };
    }

    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `Stage "${stageName}" hit max_tokens. Increase max_tokens or reduce work per stage.`
      );
    }

    if (response.stop_reason !== "tool_use") {
      throw new Error(
        `Unexpected stop_reason in stage "${stageName}": ${response.stop_reason}`
      );
    }

    // Build tool results — and capture fetched content into the Map as a side effect
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      try {
        const result = await dispatchTool(
          block.name,
          block.input as Record<string, unknown>
        );

        // If this was a fetch_url call that succeeded, stash the content
        if (block.name === "fetch_url") {
          try {
            const parsed = JSON.parse(result);
            if (parsed.content && parsed.url) {
              fetchedContent.set(parsed.url, parsed.content);
            }
          } catch {
            // ignore — non-JSON or malformed result
          }
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    // Belt-and-braces: never push empty content — that triggers a 400 from the API
    if (toolResults.length === 0) {
      throw new Error(
        `No tool results to send back in stage "${stageName}" — Claude indicated tool_use but produced no tool_use blocks`
      );
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// ─── Pipeline stages ───────────────────────────────────────────────────────────

async function stageSearch(
  client: Anthropic,
  query: string
): Promise<StageResult> {
  const systemPrompt = `You are a research assistant in the first stage of a multi-stage pipeline.
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

  const result = await runAgentLoop(
    client,
    systemPrompt,
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
        console.warn(
          `  ⚠ Skipping ${cs.url} — Claude listed it but no content was captured`
        );
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

async function stageAnalyse(
  client: Anthropic,
  query: string,
  sources: Source[]
): Promise<StageResult> {
  const systemPrompt = `You are a research analyst in the second stage of a multi-stage pipeline.
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

  const userMessage = `Query: "${query}"

Sources:
${sources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content}`).join("\n\n---\n\n")}

Analyse these sources and return structured JSON.`;

  const result = await runAgentLoop(
    client,
    systemPrompt,
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

async function stageSynthesize(
  client: Anthropic,
  query: string,
  sources: Source[],
  analysis: unknown
): Promise<StageResult> {
  const systemPrompt = `You are a research writer in the third stage of a multi-stage pipeline.
You receive a query, raw sources, and a structured analysis. Your job is to write a clear,
well-structured research report in markdown, then save it using the write_report tool.

The report must include:
- Executive summary (2-3 sentences)
- Key findings (one section per theme from the analysis)
- Contradictions and open questions
- Citations (inline [1], [2] etc. with a references section)
- A confidence rating (High / Medium / Low) with justification

After calling write_report, confirm the filename and briefly summarise what was written.`;

  const userMessage = `Query: "${query}"

Analysis:
${JSON.stringify(analysis, null, 2)}

Sources for citation:
${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n")}

Write the report and save it as report.md.`;

  const result = await runAgentLoop(
    client,
    systemPrompt,
    userMessage,
    "3 · Synthesise & write"
  );

  return { stage: "synthesize", success: true, data: result.finalText };
}

// ─── Main pipeline ─────────────────────────────────────────────────────────────

async function runResearchPipeline(query: string): Promise<void> {
  const client = new Anthropic();

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Research Agent — Multi-stage Pipeline   ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`Query: "${query}"\n`);

  const state: Partial<PipelineState> = { query };
  const results: StageResult[] = [];

  const searchResult = await stageSearch(client, query);
  results.push(searchResult);
  if (!searchResult.success) {
    console.error(`\n✗ Pipeline aborted at stage 1: ${searchResult.error}`);
    return;
  }
  state.sources = searchResult.data as Source[];
  console.log(`✓ Fetched ${state.sources.length} sources`);

  const analyseResult = await stageAnalyse(client, query, state.sources);
  results.push(analyseResult);
  if (!analyseResult.success) {
    console.error(`\n✗ Pipeline aborted at stage 2: ${analyseResult.error}`);
    return;
  }
  state.analysis = analyseResult.data as string;
  console.log(`✓ Analysis complete`);

  const synthResult = await stageSynthesize(
    client,
    query,
    state.sources,
    state.analysis
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
  console.log(`Output: ./output/report.md\n`);
}

// ─── Entry point ───────────────────────────────────────────────────────────────

const query = process.argv[2] ?? "the current state of AI agent frameworks";
runResearchPipeline(query).catch(console.error);
