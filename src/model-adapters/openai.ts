import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { logger } from "../logger.js";
import type { ModelAdapter, ModelMessage, ModelRequest, ModelResponse, ToolDefinition } from "./types.js";

function toOpenAiTool(tool: ToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toOpenAiMessages(systemPrompt: string, messages: ModelMessage[]): ChatCompletionMessageParam[] {
  const converted: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const message of messages) {
    if (message.role === "user") {
      converted.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const assistantMessage: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: message.content.length > 0 ? message.content : null,
      };
      const toolCalls = message.toolCalls;
      if (toolCalls && toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input),
          },
        }));
      }
      converted.push(assistantMessage);
      continue;
    }

    const toolMessage: ChatCompletionToolMessageParam = {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
    converted.push(toolMessage);
  }

  return converted;
}

function parseRetryAfter(headers: unknown): number | null {
  if (headers instanceof Headers) {
    return Number(headers.get("retry-after")) || null;
  }
  if (headers && typeof headers === "object") {
    const retryAfter = (headers as Record<string, string | null | undefined>)["retry-after"];
    return Number(retryAfter) || null;
  }
  return null;
}

export class OpenAiAdapter implements ModelAdapter {
  readonly provider = "openai";

  constructor(
    private readonly client: OpenAI,
    readonly model: string
  ) {}

  async sendMessage(request: ModelRequest): Promise<ModelResponse> {
    const MAX_RETRY_AFTER_SECONDS = 900;

    const attemptOnce = async () => {
      const params: ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        max_tokens: request.maxTokens,
        messages: toOpenAiMessages(request.systemPrompt, request.messages),
      };
      if (request.tools && request.tools.length > 0) {
        params.tools = request.tools.map(toOpenAiTool);
        params.tool_choice = "auto";
      }
      return this.client.chat.completions.create(params);
    };

    let response;
    try {
      response = await attemptOnce();
    } catch (err) {
      const status = typeof err === "object" && err && "status" in err ? err.status : undefined;
      if (status !== 429) throw err;

      const retryAfterSec =
        parseRetryAfter(typeof err === "object" && err && "headers" in err ? err.headers : undefined) ??
        30;

      if (retryAfterSec > MAX_RETRY_AFTER_SECONDS) {
        throw new Error(
          `Stage "${request.stageName}" rate-limited with retry-after ${retryAfterSec}s ` +
            `(exceeds ${MAX_RETRY_AFTER_SECONDS}s threshold). ` +
            `Consider reducing prompt size, switching provider, or using a different model.`
        );
      }

      logger.warn(
        { stage: request.stageName, retryAfterSec },
        "rate limited — waiting before final retry"
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000));
      response = await attemptOnce();
    }

    const choice = response.choices[0];
    if (!choice) {
      throw new Error(`Stage "${request.stageName}" returned no choices`);
    }

    const finishReason = choice.finish_reason;
    const stopReason =
      finishReason === "tool_calls"
        ? "tool_use"
        : finishReason === "length"
          ? "max_tokens"
          : "end_turn";

    return {
      stopReason,
      text: choice.message.content ?? "",
      toolCalls: (choice.message.tool_calls ?? []).map((toolCall) => {
        if (toolCall.type !== "function") {
          throw new Error(`Unsupported tool call type: ${toolCall.type}`);
        }

        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch (err) {
          throw new Error(
            `Invalid JSON arguments for tool "${toolCall.function.name}": ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }

        return {
          id: toolCall.id,
          name: toolCall.function.name,
          input,
        };
      }),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
