import { resolveModelPricing } from "./pricing.js";

export type ModelProvider = "anthropic" | "openai";

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  baseUrl?: string;
  defaultMaxTokens: number;
}

function parseProvider(raw: string | undefined): ModelProvider {
  const provider = (raw ?? "anthropic").toLowerCase();
  if (provider === "anthropic" || provider === "openai") return provider;
  throw new Error(`Unsupported MODEL_PROVIDER: ${raw}`);
}

const provider = parseProvider(process.env.MODEL_PROVIDER);
const model =
  process.env.MODEL_NAME ??
  (provider === "anthropic" ? "claude-haiku-4-5" : "gpt-4.1-mini");

export const MODEL_CONFIG: ModelConfig = {
  provider,
  model,
  defaultMaxTokens: Number(process.env.MODEL_MAX_TOKENS ?? "8192"),
};

if (provider === "openai" && process.env.OPENAI_BASE_URL) {
  MODEL_CONFIG.baseUrl = process.env.OPENAI_BASE_URL;
}

if (!Number.isFinite(MODEL_CONFIG.defaultMaxTokens) || MODEL_CONFIG.defaultMaxTokens <= 0) {
  throw new Error(`Invalid MODEL_MAX_TOKENS: ${process.env.MODEL_MAX_TOKENS}`);
}

export const MODEL_PRICING = resolveModelPricing(MODEL_CONFIG.provider, MODEL_CONFIG.model);
