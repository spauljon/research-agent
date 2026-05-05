import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { MODEL_CONFIG } from "../config.js";
import type { ModelAdapter } from "./types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAiAdapter } from "./openai.js";

export function createModelAdapter(): ModelAdapter {
  switch (MODEL_CONFIG.provider) {
    case "anthropic":
      return new AnthropicAdapter(
        new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 }),
        MODEL_CONFIG.model
      );
    case "openai":
      return new OpenAiAdapter(
        new OpenAI({
          apiKey: process.env.OPENAI_API_KEY ?? "dummy",
          baseURL: MODEL_CONFIG.baseUrl,
          maxRetries: 5,
        }),
        MODEL_CONFIG.model
      );
  }
}
