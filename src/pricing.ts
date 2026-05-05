import type { ModelProvider } from "./config.js";

// Prices correct as of 2026-04-29 — verify against provider pricing pages when
// changing models. For non-Anthropic providers, prefer env overrides because
// hosted/open-source deployments often have deployment-specific economics.

export interface ModelPricing {
  input: number;      // USD per million input tokens
  output: number;     // USD per million output tokens
  cacheWrite: number; // USD per million cache-write tokens
  cacheRead: number;  // USD per million cache-read tokens
}

export const PRICING: Record<string, ModelPricing> = {
  "anthropic:claude-opus-4-7":   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "anthropic:claude-opus-4-6":   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "anthropic:claude-opus-4-5":   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "anthropic:claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "anthropic:claude-haiku-4-5":  { input: 1, output:  5, cacheWrite: 1.25, cacheRead: 0.10 },
};

export function pricingKey(provider: ModelProvider, model: string): string {
  return `${provider}:${model}`;
}

function readEnvNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined) return null;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

export function resolveModelPricing(provider: ModelProvider, model: string): ModelPricing | null {
  const input = readEnvNumber("MODEL_INPUT_COST_USD_PER_MTOK");
  const output = readEnvNumber("MODEL_OUTPUT_COST_USD_PER_MTOK");

  if (input !== null || output !== null) {
    if (input === null || output === null) {
      throw new Error(
        "MODEL_INPUT_COST_USD_PER_MTOK and MODEL_OUTPUT_COST_USD_PER_MTOK must be set together"
      );
    }

    return {
      input,
      output,
      cacheWrite: readEnvNumber("MODEL_CACHE_WRITE_COST_USD_PER_MTOK") ?? 0,
      cacheRead: readEnvNumber("MODEL_CACHE_READ_COST_USD_PER_MTOK") ?? 0,
    };
  }

  return PRICING[pricingKey(provider, model)] ?? null;
}
