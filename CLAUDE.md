# Research Agent — Multi-stage Pipeline

A learning project building a TypeScript agent with the raw Anthropic SDK,
backed by Tavily for live web search and extraction. Part of a personal
journey to build production-shaped AI agents from first principles, without
leaning on agent frameworks.

This file briefs Claude Code (and future-me) on the project's architecture,
conventions, and current state. Read this first before making changes.

---

## What this project is

A three-stage research pipeline that takes a query, fetches relevant sources
from the web, analyses them, and produces a markdown research report with
citations. The interesting part isn't the deliverable — it's the agentic
machinery underneath: tool use, multi-stage coordination, cost discipline,
rate-limit resilience.

The pipeline:

```
Query
  │
  ▼
Stage 1 — Search & Fetch          tools: search_web, fetch_url
  │  Find URLs, fetch content. Return [{url, title}].
  │  Content is captured by the loop, NOT echoed through Claude.
  │
  ▼
Stage 2 — Analyse                 no tools (pure reasoning)
  │  Extract themes, contradictions, gaps from sources.
  │  Return structured JSON.
  │
  ▼
Stage 3 — Synthesise & Write      tool: write_report
  │  Write a markdown report with citations + confidence rating.
  │
  ▼
./output/report.md
```

---

## Architectural decisions (and why)

These are the deliberate choices. Don't change them without thinking carefully.

**Raw Anthropic SDK, no framework.** No LangChain, LlamaIndex, or similar.
The point of this project is to *see* the agentic loop turn by turn. Frameworks
hide it; learning from frameworks teaches you the framework, not the underlying
patterns.

**Typed JSON contracts between stages.** Each stage's system prompt declares an
exact output shape (`[{url, title}]`, `{themes, contradictions, gaps, ...}`,
etc.). When something breaks, you know which prompt and which schema to fix.

**External state, not round-tripped state.** When Claude calls `fetch_url`, the
agent loop intercepts the result and stashes content in a `Map<url, content>`.
Claude only needs to confirm which URLs to keep — it doesn't have to echo tens
of thousands of characters back through itself. This avoids `max_tokens`
overruns, reduces cost, and reflects a deeper principle: **the model isn't your
storage layer.**

**Errors return to Claude as `is_error: true` tool results, not exceptions.**
This lets the agent adapt — try a different URL, explain the problem in its
final response — rather than the loop crashing on transient failures. Only
genuinely unrecoverable errors (bad API key, exceeded spend cap) propagate.

**Cost cap is enforced in code, before each call.** The `CostTracker` checks
the running total before issuing a request. This is advisory, not authoritative
— set a monthly cap in the Anthropic console as the real safety net. The
in-code cap catches per-run runaway loops; the console cap catches everything
else.

**Two-layer rate-limit defense.** The Anthropic SDK auto-retries 429s with
exponential backoff (`maxRetries: 5`). On top of that, `callClaudeWithBackoff`
does *one more* explicit retry that reads the `Retry-After` header and sleeps
visibly. The two layers protect against different failure modes.

**Native `node --env-file` for config, no dotenv.** Single platform, single
runner — no need for the polyfill. The `npm start` script uses
`tsx --env-file-if-exists=.env` so the same script works locally and in
deployment environments without modification.

---

## Conventions

- **TypeScript strict mode**, ES2022, NodeNext modules.
- **Run via `npm start "your query"`** — the script handles `.env` loading.
- **Output to `./output/`** (gitignored), one `report.md` per run.
- **No secrets in the repo.** `.env` is gitignored; `.env.example` documents
  what's needed.
- **Compile-clean before commit.** Run `npx tsc --noEmit` after any edit.

---

## Current state

**Working end-to-end:**

- Three-stage pipeline runs against live Tavily and produces a real report
- Cost tracking with per-run cap (default $2.50, configurable via
  `MAX_SPEND_USD`)
- SDK auto-retry + explicit Retry-After backoff
- Proactive header monitoring (warns when rate-limit budget gets tight)
- Defensive `stop_reason` handling — fails loudly on `max_tokens` or unknown
  reasons rather than silently corrupting state
- Refactored agent loop into named helpers (`interpretStopReason`,
  `processToolUseBlock`, `executeToolCalls`) to keep cognitive complexity low

**Not yet done (in roughly the order I plan to tackle them):**

- **Multi-module refactor.** Currently everything is in `src/agent.ts`. The
  natural split: `agent-loop.ts`, `cost-tracker.ts`, `pricing.ts`,
  `tools/`, `stages/`, `types.ts`. See "Refactor goal" below.
- **Rigorous logging.** Today's logs are useful but ad-hoc. Want a proper
  logging module that records the full message history at each loop iteration
  for debugging and learning.
- **Stage 0 — query reformulation.** Use Claude to improve a vague user query
  before Stage 1 runs. First taste of agent self-improvement.
- **Checkpointing for resumability.** A crashed pipeline should be able to
  resume from the last completed stage rather than starting over. This is the
  on-ramp to the broader "MEMORY.md / persistent state" pattern.

---

## Refactor goal

Target structure for the multi-module split:

```
src/
  agent.ts                  ← entry point: argv parsing, runResearchPipeline()
  config.ts                 ← MODEL constant, env reading
  pricing.ts                ← PRICING table, ModelPricing type
  cost-tracker.ts           ← CostTracker class, SpendCapExceeded
  agent-loop.ts             ← runAgentLoop, callClaudeWithBackoff,
                              interpretStopReason, processToolUseBlock,
                              executeToolCalls
  tools/
    index.ts                ← TOOLS array, dispatchTool
    search-web.ts           ← handleSearchWeb, Tavily search client
    fetch-url.ts            ← handleFetchUrl, Tavily extract client
    write-report.ts         ← handleWriteReport
  stages/
    search.ts               ← stageSearch
    analyse.ts              ← stageAnalyse
    synthesize.ts           ← stageSynthesize
  types.ts                  ← shared interfaces (Source, StageResult, etc.)
```

Principles for the split:

- Group code by **reason to change**, not by file size or technology layer.
- Modules export **interfaces**, not implementations. Tavily client functions
  stay private to `tools/search-web.ts`; only `handleSearchWeb` is exported.
- Dependency direction must form an **acyclic graph**. `tools/` depends on
  `types.ts`; `stages/` depends on `tools/` and `agent-loop.ts`; `agent.ts`
  depends on `stages/`. No cycles.
- **Resist over-abstraction.** Don't introduce `BaseAgent`, `AbstractTool`,
  `PipelineStrategy`, etc. There's only one of each — abstracting on guess
  rather than need almost always picks the wrong axis. Wait for three concrete
  examples before extracting.
- **Domain-shaped folders, not technology-shaped.** `stages/` and `tools/`,
  not `services/` or `helpers/`.

---

## Setup

```bash
npm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY and TAVILY_API_KEY
npm start "your research query"
```

You'll need:

- **Anthropic API key.** Get one at https://console.anthropic.com. Tier 1
  ($5 of credits) is the practical minimum for this pipeline; the free tier's
  rate limits are too tight for Stage 2's input size.
- **Tavily API key.** Get one at https://tavily.com. The free tier is
  generous (~1,000 credits/month).
- **Optional `MAX_SPEND_USD`** in `.env` to override the default $2.50
  per-run cap.

---

## Working with this codebase

When making changes:

1. Read the relevant section of `agent.ts` (or post-refactor: the relevant
   module). The code is heavily commented because comments are the durable
   record of *why* — the code itself shows *what*.
2. Run `npx tsc --noEmit` to confirm a clean compile.
3. Run `npm start "test query"` to exercise the pipeline end-to-end.
4. Watch the `[cost]` and `[rate]` log lines — they'll tell you immediately
   if a change has cost or rate-limit implications.
5. Commit incrementally with descriptive messages. This repo's git history is
   part of the learning artifact.
6. 