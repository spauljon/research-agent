import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./config.js";
import { CostTracker } from "./cost-tracker.js";
import { TOOLS, dispatchTool } from "./tools/index.js";
import { logger } from "./logger.js";
import type { Logger } from "./logger.js";
import type { AgentLoopResult } from "./types.js";

// Internal to this module — nothing outside needs to know the loop's decision type.
type StopInterpretation =
  | { kind: "done"; finalText: string }
  | { kind: "continue" };

/**
 * Wraps client.messages.create with:
 *   1. One additional explicit retry on 429 that respects the Retry-After header
 *      (the SDK already auto-retries via maxRetries; this is a final safety net
 *      with full visibility — you SEE the wait, you don't just get a slow call)
 *   2. Logging of remaining rate-limit budget when it drops below a threshold,
 *      so you can spot pressure building before you hit a wall
 */
export async function callClaudeWithBackoff(
  client: Anthropic,
  request: Anthropic.MessageCreateParamsNonStreaming,
  stageName: string
): Promise<Anthropic.Message> {
  const MAX_RETRY_AFTER_SECONDS = 900;

  const attemptOnce = async () => {
    const { data, response } = await client.messages
      .create(request)
      .withResponse();

    const reqRemaining = Number(
      response.headers.get("anthropic-ratelimit-requests-remaining") ?? -1
    );
    const itpmRemaining = Number(
      response.headers.get("anthropic-ratelimit-input-tokens-remaining") ?? -1
    );

    if (reqRemaining >= 0 && reqRemaining <= 2) {
      logger.warn({ stage: stageName, reqRemaining }, "rate limit: requests running low");
    }
    if (itpmRemaining >= 0 && itpmRemaining < 5000) {
      logger.warn({ stage: stageName, itpmRemaining }, "rate limit: input tokens running low");
    }

    return data;
  };

  try {
    return await attemptOnce();
  } catch (err) {
    if (!(err instanceof Anthropic.RateLimitError)) throw err;

    const retryAfterRaw = err.headers?.["retry-after"];
    const retryAfterSec = Number(retryAfterRaw) || 30;

    if (retryAfterSec > MAX_RETRY_AFTER_SECONDS) {
      throw new Error(
        `Stage "${stageName}" rate-limited with retry-after ${retryAfterSec}s ` +
        `(exceeds ${MAX_RETRY_AFTER_SECONDS}s threshold). ` +
        `Consider reducing prompt size, switching tier, or using a different model.`
      );
    }

    logger.warn(
      { stage: stageName, retryAfterSec },
      "rate limited — waiting before final retry"
    );
    await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000));

    return attemptOnce();
  }
}

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

async function processToolUseBlock(
  block: Anthropic.ToolUseBlock,
  fetchedContent: Map<string, string>,
  log: Logger
): Promise<Anthropic.ToolResultBlockParam> {
  log.debug({ tool: block.name, input: block.input }, "tool call");
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

    log.debug({ tool: block.name, toolUseId: block.id }, "tool result ok");
    return { type: "tool_result", tool_use_id: block.id, content: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ tool: block.name, toolUseId: block.id, err: message }, "tool result error");
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `Error: ${message}`,
      is_error: true,
    };
  }
}

async function executeToolCalls(
  response: Anthropic.Message,
  fetchedContent: Map<string, string>,
  log: Logger
): Promise<Anthropic.ToolResultBlockParam[]> {
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    results.push(await processToolUseBlock(block, fetchedContent, log));
  }
  return results;
}

export async function runAgentLoop(
  client: Anthropic,
  tracker: CostTracker,
  systemPrompt: string,
  userMessage: string,
  stageName: string
): Promise<AgentLoopResult> {
  const log = logger.child({ stage: stageName });
  log.info("stage start");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];
  const fetchedContent = new Map<string, string>();
  let iteration = 0;

  while (true) {
    tracker.preflight();
    iteration++;

    // Full message history logged at debug — goes to the run log file, not stdout.
    log.debug({ iteration, messageCount: messages.length, messages }, "claude request");

    const response = await callClaudeWithBackoff(
      client,
      { model: MODEL, max_tokens: 8192, system: systemPrompt, tools: TOOLS, messages },
      stageName
    );

    tracker.record(response.usage);
    log.debug(
      { iteration, usage: response.usage, stopReason: response.stop_reason },
      "claude response"
    );

    messages.push({ role: "assistant", content: response.content });

    const next = interpretStopReason(response, stageName);
    if (next.kind === "done") {
      log.info({ iterations: iteration }, "stage complete");
      return { finalText: next.finalText, fetchedContent };
    }

    const toolResults = await executeToolCalls(response, fetchedContent, log);
    if (toolResults.length === 0) {
      throw new Error(
        `No tool results to send back in stage "${stageName}" — Claude indicated tool_use but produced no tool_use blocks`
      );
    }
    messages.push({ role: "user", content: toolResults });
  }
}
