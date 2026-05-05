import { CostTracker } from "./cost-tracker.js";
import type { ModelAdapter, ModelMessage, ModelResponse, ToolCall } from "./model-adapters/types.js";
import { TOOLS, dispatchTool } from "./tools/index.js";
import { logger } from "./logger.js";
import type { Logger } from "./logger.js";
import type { AgentLoopResult } from "./types.js";

// Internal to this module — nothing outside needs to know the loop's decision type.
type StopInterpretation =
  | { kind: "done"; finalText: string }
  | { kind: "continue" };

function interpretStopReason(
  response: ModelResponse,
  stageName: string
): StopInterpretation {
  if (response.stopReason === "end_turn") {
    return { kind: "done", finalText: response.text };
  }

  if (response.stopReason === "max_tokens") {
    throw new Error(
      `Stage "${stageName}" hit max_tokens. Increase max_tokens or reduce work per stage.`
    );
  }

  if (response.stopReason !== "tool_use") {
    throw new Error(`Unexpected stop_reason in stage "${stageName}": ${response.stopReason}`);
  }

  return { kind: "continue" };
}

async function processToolUseBlock(
  block: ToolCall,
  fetchedContent: Map<string, string>,
  log: Logger
): Promise<{
  role: "tool";
  toolCallId: string;
  content: string;
  isError?: boolean;
}> {
  log.debug({ tool: block.name, input: block.input }, "tool call");
  try {
    const result = await dispatchTool(block.name, block.input);

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
    return { role: "tool", toolCallId: block.id, content: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ tool: block.name, toolUseId: block.id, err: message }, "tool result error");
    return {
      role: "tool",
      toolCallId: block.id,
      content: `Error: ${message}`,
      isError: true,
    };
  }
}

async function executeToolCalls(
  toolCalls: ToolCall[],
  fetchedContent: Map<string, string>,
  log: Logger
): Promise<
  {
    role: "tool";
    toolCallId: string;
    content: string;
    isError?: boolean;
  }[]
> {
  const results: {
    role: "tool";
    toolCallId: string;
    content: string;
    isError?: boolean;
  }[] = [];
  for (const toolCall of toolCalls) {
    results.push(await processToolUseBlock(toolCall, fetchedContent, log));
  }
  return results;
}

export async function runAgentLoop(
  adapter: ModelAdapter,
  tracker: CostTracker,
  systemPrompt: string,
  userMessage: string,
  stageName: string
): Promise<AgentLoopResult> {
  const log = logger.child({ stage: stageName });
  log.info("stage start");

  const messages: ModelMessage[] = [
    { role: "user", content: userMessage },
  ];
  const fetchedContent = new Map<string, string>();
  let iteration = 0;

  while (true) {
    tracker.preflight();
    iteration++;

    // Full message history logged at debug — goes to the run log file, not stdout.
    log.debug({ iteration, messageCount: messages.length, messages }, "claude request");

    const response = await adapter.sendMessage({
      systemPrompt,
      messages,
      tools: TOOLS,
      maxTokens: 8192,
      stageName,
    });

    tracker.record(response.usage);
    log.debug(
      { iteration, usage: response.usage, stopReason: response.stopReason },
      "model response"
    );

    const assistantMessage: ModelMessage =
      response.toolCalls.length > 0
        ? { role: "assistant", content: response.text, toolCalls: response.toolCalls }
        : { role: "assistant", content: response.text };
    messages.push(assistantMessage);

    const next = interpretStopReason(response, stageName);
    if (next.kind === "done") {
      log.info({ iterations: iteration }, "stage complete");
      return { finalText: next.finalText, fetchedContent };
    }

    const toolResults = await executeToolCalls(response.toolCalls, fetchedContent, log);
    if (toolResults.length === 0) {
      throw new Error(
        `No tool results to send back in stage "${stageName}" — Claude indicated tool_use but produced no tool_use blocks`
      );
    }
    messages.push(
      ...toolResults.map((toolResult) =>
        toolResult.isError === undefined
          ? {
              role: "tool" as const,
              toolCallId: toolResult.toolCallId,
              content: toolResult.content,
            }
          : {
              role: "tool" as const,
              toolCallId: toolResult.toolCallId,
              content: toolResult.content,
              isError: toolResult.isError,
            }
      )
    );
  }
}
