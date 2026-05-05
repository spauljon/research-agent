export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type ModelMessage =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      content: string;
      isError?: boolean;
    };

export interface ModelRequest {
  systemPrompt: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  maxTokens: number;
  stageName: string;
}

export interface ModelResponse {
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  text: string;
  toolCalls: ToolCall[];
  usage: NormalizedUsage;
}

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;

  sendMessage(request: ModelRequest): Promise<ModelResponse>;
}
