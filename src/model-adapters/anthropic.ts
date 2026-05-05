import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";
import type { ModelAdapter, ModelMessage, ModelRequest, ModelResponse, ToolDefinition } from "./types.js";

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function toAnthropicMessages(messages: ModelMessage[]): Anthropic.MessageParam[] {
  const converted: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      converted.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.content.length > 0) {
        content.push({ type: "text", text: message.content });
      }
      for (const toolCall of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        });
      }
      converted.push({ role: "assistant", content });
      continue;
    }

    const block: Anthropic.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
    };
    if (message.isError !== undefined) {
      block.is_error = message.isError;
    }

    const last = converted.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) {
      last.content.push(block);
      continue;
    }

    converted.push({ role: "user", content: [block] });
  }

  return converted;
}

function textFromAnthropicResponse(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = "anthropic";

  constructor(
    private readonly client: Anthropic,
    readonly model: string
  ) {}

  async sendMessage(request: ModelRequest): Promise<ModelResponse> {
    const MAX_RETRY_AFTER_SECONDS = 900;

    const attemptOnce = async () => {
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: this.model,
        max_tokens: request.maxTokens,
        system: request.systemPrompt,
        messages: toAnthropicMessages(request.messages),
      };
      if (request.tools && request.tools.length > 0) {
        params.tools = request.tools.map(toAnthropicTool);
      }

      const { data, response } = await this.client.messages
        .create(params)
        .withResponse();

      const reqRemaining = Number(
        response.headers.get("anthropic-ratelimit-requests-remaining") ?? -1
      );
      const itpmRemaining = Number(
        response.headers.get("anthropic-ratelimit-input-tokens-remaining") ?? -1
      );

      if (reqRemaining >= 0 && reqRemaining <= 2) {
        logger.warn(
          { stage: request.stageName, reqRemaining },
          "rate limit: requests running low"
        );
      }
      if (itpmRemaining >= 0 && itpmRemaining < 5000) {
        logger.warn(
          { stage: request.stageName, itpmRemaining },
          "rate limit: input tokens running low"
        );
      }

      return data;
    };

    let response: Anthropic.Message;
    try {
      response = await attemptOnce();
    } catch (err) {
      if (!(err instanceof Anthropic.RateLimitError)) throw err;

      const retryAfterRaw = err.headers?.["retry-after"];
      const retryAfterSec = Number(retryAfterRaw) || 30;

      if (retryAfterSec > MAX_RETRY_AFTER_SECONDS) {
        throw new Error(
          `Stage "${request.stageName}" rate-limited with retry-after ${retryAfterSec}s ` +
            `(exceeds ${MAX_RETRY_AFTER_SECONDS}s threshold). ` +
            `Consider reducing prompt size, switching tier, or using a different model.`
        );
      }

      logger.warn(
        { stage: request.stageName, retryAfterSec },
        "rate limited — waiting before final retry"
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000));
      response = await attemptOnce();
    }

    if (
      response.stop_reason !== "end_turn" &&
      response.stop_reason !== "tool_use" &&
      response.stop_reason !== "max_tokens"
    ) {
      throw new Error(
        `Unexpected stop_reason in stage "${request.stageName}": ${response.stop_reason}`
      );
    }

    return {
      stopReason: response.stop_reason,
      text: textFromAnthropicResponse(response),
      toolCalls: response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        })),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
