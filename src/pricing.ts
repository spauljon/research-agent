// Prices correct as of 2026-04-29 — verify against https://www.anthropic.com/pricing
// when changing models.

export interface ModelPricing {
  input: number;      // USD per million input tokens
  output: number;     // USD per million output tokens
  cacheWrite: number; // USD per million cache-write tokens
  cacheRead: number;  // USD per million cache-read tokens
}

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7":   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-opus-4-6":   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-opus-4-5":   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-haiku-4-5":  { input: 1, output:  5, cacheWrite: 1.25, cacheRead: 0.10 },
};
