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
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
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

// ─── Cost tracking ────────────────────────────────────────────────────────────
//
// Tracks token usage across all API calls in a pipeline run, computes USD
// cost from a model price table, and halts the pipeline before exceeding a
// configurable cap.
//
// Two-layer cost discipline:
//   1. This in-code tracker — per-run cap, advisory but immediate
//   2. Anthropic console limits — monthly cap, authoritative safety net
// The console limit should be set well above the in-code limit so it only
// fires if something is genuinely broken.
//
// Prices below were correct on 2026-04-29 — verify against
// https://www.anthropic.com/pricing if you change models.

interface ModelPricing {
  input: number;       // USD per million input tokens
  output: number;      // USD per million output tokens
  cacheWrite: number;  // USD per million cache-write tokens
  cacheRead: number;   // USD per million cache-read tokens
}

const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7":   { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-opus-4-6":   { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-opus-4-5":   { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-sonnet-4-6": { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-haiku-4-5":  { input: 1,  output:  5, cacheWrite: 1.25, cacheRead: 0.10 },
};

class SpendCapExceeded extends Error {
  constructor(public spent: number, public cap: number) {
    super(
      `Spend cap exceeded: $${spent.toFixed(4)} > $${cap.toFixed(2)}. ` +
      `Pipeline halted. Increase MAX_SPEND_USD to continue.`
    );
    this.name = "SpendCapExceeded";
  }
}

class CostTracker {
  private totalUsd = 0;
  private callCount = 0;

  constructor(
    private readonly model: string,
    private readonly capUsd: number
  ) {
    if (!PRICING[model]) {
      throw new Error(
        `No pricing entry for model "${model}". Add it to PRICING or pick a known model.`
      );
    }
  }

  /** Throw if the current spend already exceeds the cap. Call before each API request. */
  preflight(): void {
    if (this.totalUsd >= this.capUsd) {
      throw new SpendCapExceeded(this.totalUsd, this.capUsd);
    }
  }

  /** Record actual usage from a completed API response. */
  record(usage: Anthropic.Usage): void {
    const price = PRICING[this.model]!;
    const inputCost  = (usage.input_tokens                   / 1_000_000) * price.input;
    const outputCost = (usage.output_tokens                  / 1_000_000) * price.output;
    const writeCost  = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * price.cacheWrite;
    const readCost   = ((usage.cache_read_input_tokens     ?? 0) / 1_000_000) * price.cacheRead;
    const callCost   = inputCost + outputCost + writeCost + readCost;

    this.totalUsd += callCost;
    this.callCount++;

    console.log(
      `  [cost] +$${callCost.toFixed(4)} ` +
      `(in:${usage.input_tokens} out:${usage.output_tokens}) ` +
      `→ run total $${this.totalUsd.toFixed(4)} / $${this.capUsd.toFixed(2)}`
    );
  }

  summary(): string {
    return `${this.callCount} API call${this.callCount === 1 ? "" : "s"}, $${this.totalUsd.toFixed(4)} spent (cap $${this.capUsd.toFixed(2)})`;
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

const MODEL = "claude-haiku-4-5";

interface AgentLoopResult {
  finalText: string;
  fetchedContent: Map<string, string>; // url → raw extracted text
}

/**
 * Wraps client.messages.create with:
 *   1. One additional explicit retry on 429 that respects the Retry-After header
 *      (the SDK already auto-retries via maxRetries; this is a final safety net
 *      with full visibility — you SEE the wait, you don't just get a slow call)
 *   2. Logging of remaining rate-limit budget when it drops below a threshold,
 *      so you can spot pressure building before you hit a wall
 */
async function callClaudeWithBackoff(
  client: Anthropic,
  request: Anthropic.MessageCreateParamsNonStreaming,
  stageName: string
): Promise<Anthropic.Message> {
  const MAX_RETRY_AFTER_SECONDS = 90; // refuse waits longer than this — bail with a clear error

  const attemptOnce = async () => {
    // .withResponse() returns both the parsed message and the raw HTTP response,
    // so we can read the rate-limit headers
    const { data, response } = await client.messages
      .create(request)
      .withResponse();

    const reqRemaining = Number(
      response.headers.get("anthropic-ratelimit-requests-remaining") ?? -1
    );
    const itpmRemaining = Number(
      response.headers.get("anthropic-ratelimit-input-tokens-remaining") ?? -1
    );

    // Warn when we're getting close — values of -1 mean header not present
    if (reqRemaining >= 0 && reqRemaining <= 2) {
      console.log(`  [rate] ⚠ requests remaining this minute: ${reqRemaining}`);
    }
    if (itpmRemaining >= 0 && itpmRemaining < 5000) {
      console.log(`  [rate] ⚠ input tokens remaining this minute: ${itpmRemaining}`);
    }

    return data;
  };

  try {
    return await attemptOnce();
  } catch (err) {
    // The SDK throws RateLimitError specifically for 429s
    if (!(err instanceof Anthropic.RateLimitError)) throw err;

    // Read the Retry-After header — it can be in seconds or as an HTTP date
    const retryAfterRaw = err.headers?.["retry-after"];
    const retryAfterSec = Number(retryAfterRaw) || 30; // fallback to 30s

    if (retryAfterSec > MAX_RETRY_AFTER_SECONDS) {
      throw new Error(
        `Stage "${stageName}" rate-limited with retry-after ${retryAfterSec}s ` +
        `(exceeds ${MAX_RETRY_AFTER_SECONDS}s threshold). ` +
        `Consider reducing prompt size, switching tier, or using a different model.`
      );
    }

    console.log(
      `  [rate] 429 received in stage "${stageName}". ` +
      `Waiting ${retryAfterSec}s per Retry-After header before final attempt...`
    );
    await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000));

    // One more attempt — if THIS one 429s, let it propagate
    return attemptOnce();
  }
}

// What `interpretStopReason` returns. The loop uses this to decide whether to
// return a final result, throw, or keep going.
type StopInterpretation =
  | { kind: "done"; finalText: string }
  | { kind: "continue" };

/**
 * Inspects a response's stop_reason and decides how the loop should react.
 * Throws on anything unexpected — that's our "fail loud" defence against silent
 * weirdness like `max_tokens` overruns or unknown reasons from future API versions.
 */
function interpretStopReason(
  response: Anthropic.Message,
  stageName: string
): StopInterpretation {
  if (response.stop_reason === "end_turn") {
    const textBlock = response.content.find((b) => b.type === "text");
    return { kind: "done", finalText: textBlock ? textBlock.text : "" };
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

  return { kind: "continue" };
}

/**
 * Processes a single tool_use block: calls the tool, captures any side-effect
 * state (currently: fetched URL content into the Map), and returns the result
 * block to send back to Claude. Errors from the tool are converted into
 * `is_error: true` tool results so Claude can adapt rather than the loop crashing.
 */
async function processToolUseBlock(
  block: Anthropic.ToolUseBlock,
  fetchedContent: Map<string, string>
): Promise<Anthropic.ToolResultBlockParam> {
  try {
    const result = await dispatchTool(
      block.name,
      block.input as Record<string, unknown>
    );

    // Side effect: stash fetched content keyed by URL so the pipeline can read
    // it directly without round-tripping through Claude.
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

    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: result,
    };
  } catch (err) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

/**
 * Iterates the tool_use blocks in a response and produces the corresponding
 * tool_result blocks to send back. Non-tool_use blocks are skipped silently
 * (they're typically text blocks Claude adds alongside its tool calls).
 */
async function executeToolCalls(
  response: Anthropic.Message,
  fetchedContent: Map<string, string>
): Promise<Anthropic.ToolResultBlockParam[]> {
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    results.push(await processToolUseBlock(block, fetchedContent));
  }
  return results;
}

async function runAgentLoop(
  client: Anthropic,
  tracker: CostTracker,
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
    tracker.preflight();

    const response = await callClaudeWithBackoff(
      client,
      {
        model: MODEL,
        max_tokens: 8192,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      },
      stageName
    );

    tracker.record(response.usage);
    messages.push({ role: "assistant", content: response.content });

    const next = interpretStopReason(response, stageName);
    if (next.kind === "done") {
      return { finalText: next.finalText, fetchedContent };
    }

    const toolResults = await executeToolCalls(response, fetchedContent);
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
  tracker: CostTracker,
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
    tracker,
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
  tracker: CostTracker,
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
    tracker,
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
  tracker: CostTracker,
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
    tracker,
    systemPrompt,
    userMessage,
    "3 · Synthesise & write"
  );

  return { stage: "synthesize", success: true, data: result.finalText };
}

// ─── Main pipeline ─────────────────────────────────────────────────────────────

async function runResearchPipeline(query: string): Promise<void> {
  // maxRetries: SDK auto-retries 429/529 with exponential backoff.
  // Default is 2; we bump to 5 for agentic workloads where short bursts
  // can briefly exceed per-minute limits even on a paid tier.
  const client = new Anthropic({ maxRetries: 5 });

  // Spend cap configurable via env, defaults to $2.50 per pipeline run
  const capUsd = Number(process.env.MAX_SPEND_USD ?? "2.50");
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(`Invalid MAX_SPEND_USD: ${process.env.MAX_SPEND_USD}`);
  }
  const tracker = new CostTracker(MODEL, capUsd);

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Research Agent — Multi-stage Pipeline   ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`Query: "${query}"`);
  console.log(`Model: ${MODEL}   Spend cap: $${capUsd.toFixed(2)}\n`);

  const state: Partial<PipelineState> = { query };
  const results: StageResult[] = [];

  try {
    const searchResult = await stageSearch(client, tracker, query);
    results.push(searchResult);
    if (!searchResult.success) {
      console.error(`\n✗ Pipeline aborted at stage 1: ${searchResult.error}`);
      return;
    }
    state.sources = searchResult.data as Source[];
    console.log(`✓ Fetched ${state.sources.length} sources`);

    const analyseResult = await stageAnalyse(client, tracker, query, state.sources);
    results.push(analyseResult);
    if (!analyseResult.success) {
      console.error(`\n✗ Pipeline aborted at stage 2: ${analyseResult.error}`);
      return;
    }
    state.analysis = analyseResult.data as string;
    console.log(`✓ Analysis complete`);

    const synthResult = await stageSynthesize(
      client,
      tracker,
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
    console.log(`Cost:    ${tracker.summary()}`);
    console.log(`Output:  ./output/report.md\n`);
  } catch (err) {
    if (err instanceof SpendCapExceeded) {
      console.error(`\n💰 ${err.message}`);
      console.error(`Stages completed before halt: ${results.filter((r) => r.success).length}`);
      console.error(`Cost: ${tracker.summary()}`);
      console.error(`Tip: re-run with MAX_SPEND_USD=<higher> to continue.\n`);
      return;
    }
    throw err;
  }
}

// ─── Entry point ───────────────────────────────────────────────────────────────

const query = process.argv[2] ?? "the current state of AI agent frameworks";
runResearchPipeline(query).catch(console.error);
