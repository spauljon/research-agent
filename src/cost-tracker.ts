import type Anthropic from "@anthropic-ai/sdk";
import { PRICING } from "./pricing.js";
import { logger } from "./logger.js";

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
    private readonly model: string,
    private readonly capUsd: number
  ) {
    if (!PRICING[model]) {
      throw new Error(
        `No pricing entry for model "${model}". Add it to PRICING or pick a known model.`
      );
    }
  }

  // Throw if the current spend already exceeds the cap. Call before each API request.
  preflight(): void {
    if (this.totalUsd >= this.capUsd) {
      throw new SpendCapExceeded(this.totalUsd, this.capUsd);
    }
  }

  // Record actual usage from a completed API response.
  record(usage: Anthropic.Usage): void {
    const price = PRICING[this.model]!;
    const inputCost  = (usage.input_tokens                        / 1_000_000) * price.input;
    const outputCost = (usage.output_tokens                       / 1_000_000) * price.output;
    const writeCost  = ((usage.cache_creation_input_tokens ?? 0)  / 1_000_000) * price.cacheWrite;
    const readCost   = ((usage.cache_read_input_tokens     ?? 0)  / 1_000_000) * price.cacheRead;
    const callCost   = inputCost + outputCost + writeCost + readCost;

    this.totalUsd += callCost;
    this.callCount++;

    logger.info(
      {
        callCost: Number(callCost.toFixed(4)),
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalUsd: Number(this.totalUsd.toFixed(4)),
        capUsd: this.capUsd,
      },
      "api call cost"
    );
  }

  summary(): string {
    return `${this.callCount} API call${this.callCount === 1 ? "" : "s"}, $${this.totalUsd.toFixed(4)} spent (cap $${this.capUsd.toFixed(2)})`;
  }
}
