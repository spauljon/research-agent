# Research Agent — Multi-stage Pipeline (Tavily-backed)

A TypeScript agent that coordinates three sequential stages using the Anthropic
SDK's tool use API and the Tavily search/extract APIs. No LangChain, no
abstractions — raw SDK and raw `fetch()` so you can see exactly what's
happening at every layer.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
export TAVILY_API_KEY=tvly-...
npm start "your research query here"
```

Get a free Tavily API key at https://tavily.com — generous free tier (1,000
credits/month at time of writing).

Output is written to `./output/report.md`.

## Architecture

```
Query
  │
  ▼
Stage 1 — Search & Fetch          (tools: search_web, fetch_url)
  │  Claude calls Tavily /search to find URLs.
  │  Then calls Tavily /extract for each chosen URL to get full content.
  │  Returns a typed Source[] array.
  │
  ▼
Stage 2 — Analyse                 (no tools — pure reasoning)
  │  Claude reads all sources and extracts themes, contradictions, gaps.
  │  Returns structured JSON: { themes, contradictions, gaps, topSources }
  │
  ▼
Stage 3 — Synthesise & Write      (tool: write_report)
  │  Claude writes a full markdown report, then saves it via tool call.
  │  Confirms filename and summary.
  │
  ▼
./output/report.md
```

## Why two tools instead of one?

Tavily's `/search` endpoint already returns short content snippets — for many
use cases you could skip `fetch_url` entirely. We keep them as separate tools
on purpose, because:

1. The two-step pattern (discover → fetch) generalises to APIs that DON'T
   bundle content with search results
2. It teaches the agent to make a real choice — pick the best 3 of 5 results
   rather than blindly using everything
3. It shows the agentic loop handling multiple tool calls per stage, which is
   the realistic production pattern

## Key concepts to understand

### The agentic loop (`runAgentLoop`)
Claude may call tools multiple times before returning a final answer.
The loop handles this by:
1. Sending messages to Claude
2. If `stop_reason === "tool_use"`, dispatch each tool call
3. Add results back to message history as `tool_result` blocks
4. Repeat until `stop_reason === "end_turn"`

This is the core pattern for ALL tool-using agents.

### Why separate stages?
Each stage has a focused system prompt and a clear output contract (JSON shape).
This makes failures easier to catch and debug — if Stage 2 returns garbage,
you know exactly which prompt and which JSON schema to fix.

### Error handling in tools
Tool errors are returned TO Claude (as `is_error: true` tool results) rather
than thrown. This lets Claude adapt — it might retry with a different URL or
explain the problem in its final response. Only crash the pipeline on
unrecoverable errors (bad API key, network down, etc.).

### Content truncation
`handleFetchUrl` trims pages to 12,000 characters before returning them to
Claude. Real-world web pages can be huge — without this, a single big article
could blow your context window or run up token costs.

## What to watch for on your first run

- **Look at the tool call sequence in the logs.** You'll see `search_web` once,
  then `fetch_url` 2-3 times. That's the agent thinking: "search broadly, then
  drill into the best results."
- **Tavily extraction can fail** for sites with bot protection (Cloudflare,
  paywalls). The agent handles this gracefully — failed URLs come back with an
  error and the agent can pick a different one.
- **The final report quality is bounded by source quality.** If your query
  returns thin or low-quality sources, the report will reflect that. This is a
  good time to start thinking about Stage 0 — query reformulation.

## Extending this

- Add a Stage 0 that reformulates the query before searching
- Add retry logic per stage with exponential backoff
- Persist stage outputs to disk so a crashed pipeline can resume
  (this is exactly what Track 3 of the learning plan covers)
- Add a confidence score to the final report based on source quality
