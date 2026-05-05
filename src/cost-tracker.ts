import type { NormalizedUsage } from "./model-adapters/types.js";
import { logger } from "./logger.js";
import type { ModelPricing } from "./pricing.js";

export class SpendCapExceeded extends Error {
  constructor(public spent: number, public cap: number) {
    super(
      `Spend cap exceeded: $${spent.toFixed(4)} > $${cap.toFixed(2)}. ` +
      `Pipeline halted. Increase MAX_SPEND_USD to continue.`
    );
    this.name = "SpendCapExceeded";
  }
}

export class CostTracker {
  private totalUsd = 0;
  private callCount = 0;

  constructor(
    private readonly modelLabel: string,
    private readonly capUsd: number,
    private readonly pricing: ModelPricing | null
  ) {
    if (this.pricing === null) {
      logger.warn(
        { model: this.modelLabel },
        "no pricing configured for model; spend cap enforcement disabled"
      );
    }
  }

  // Throw if the current spend already exceeds the cap. Call before each API request.
  preflight(): void {
    if (this.pricing === null) return;
    if (this.totalUsd >= this.capUsd) {
      throw new SpendCapExceeded(this.totalUsd, this.capUsd);
    }
  }

  // Record actual usage from a completed API response.
  record(usage: NormalizedUsage): void {
    this.callCount++;

    if (this.pricing === null) {
      logger.info(
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          model: this.modelLabel,
        },
        "api call usage"
      );
      return;
    }

    const inputCost  = (usage.inputTokens                        / 1_000_000) * this.pricing.input;
    const outputCost = (usage.outputTokens                       / 1_000_000) * this.pricing.output;
    const writeCost  = ((usage.cacheCreationInputTokens ?? 0)    / 1_000_000) * this.pricing.cacheWrite;
    const readCost   = ((usage.cacheReadInputTokens ?? 0)        / 1_000_000) * this.pricing.cacheRead;
    const callCost   = inputCost + outputCost + writeCost + readCost;

    this.totalUsd += callCost;

    logger.info(
      {
        callCost: Number(callCost.toFixed(4)),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalUsd: Number(this.totalUsd.toFixed(4)),
        capUsd: this.capUsd,
      },
      "api call cost"
    );
  }

  summary(): string {
    if (this.pricing === null) {
      return `${this.callCount} API call${this.callCount === 1 ? "" : "s"}, spend unavailable for ${this.modelLabel}`;
    }
    return `${this.callCount} API call${this.callCount === 1 ? "" : "s"}, $${this.totalUsd.toFixed(4)} spent (cap $${this.capUsd.toFixed(2)})`;
  }
}
