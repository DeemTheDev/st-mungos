// Anthropic plumbing for the flashcard pipeline: client creation, the
// structured-outputs call shape (same pattern as scripts/gen-common.ts), and
// per-call cost accounting. Extraction is transcription-shaped work —
// Haiku 4.5, thinking disabled, instructions cached across windows
// (docs/FLASHCARDS.md §3).

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";

export const FC_MODEL = "claude-haiku-4-5-20251001";

// Haiku 4.5 list pricing, $ per million tokens.
const USD_PER_MTOK_INPUT = 1.0;
const USD_PER_MTOK_OUTPUT = 5.0;
const USD_PER_MTOK_CACHE_WRITE = 1.25;
const USD_PER_MTOK_CACHE_READ = 0.1;

export class BudgetExceededError extends Error {
  constructor(spentUsd: number, maxUsd: number) {
    super(`flashcard pipeline budget exceeded: $${spentUsd.toFixed(4)} spent of $${maxUsd.toFixed(2)} max`);
    this.name = "BudgetExceededError";
  }
}

/** Accumulates token usage + running cost; logs a line after every call. */
export class CostTracker {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheWriteTokens = 0;
  cacheReadTokens = 0;

  constructor(private readonly maxUsd?: number) {}

  get totalUsd(): number {
    return (
      (this.inputTokens * USD_PER_MTOK_INPUT +
        this.outputTokens * USD_PER_MTOK_OUTPUT +
        this.cacheWriteTokens * USD_PER_MTOK_CACHE_WRITE +
        this.cacheReadTokens * USD_PER_MTOK_CACHE_READ) /
      1_000_000
    );
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens + this.cacheWriteTokens + this.cacheReadTokens;
  }

  /** Throws before a call would push spend past the hard cap. */
  assertBudget(): void {
    if (this.maxUsd != null && this.totalUsd >= this.maxUsd) {
      throw new BudgetExceededError(this.totalUsd, this.maxUsd);
    }
  }

  add(label: string, usage: Anthropic.Usage): void {
    this.calls += 1;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const callUsd =
      (input * USD_PER_MTOK_INPUT +
        output * USD_PER_MTOK_OUTPUT +
        cacheWrite * USD_PER_MTOK_CACHE_WRITE +
        cacheRead * USD_PER_MTOK_CACHE_READ) /
      1_000_000;
    this.inputTokens += input;
    this.outputTokens += output;
    this.cacheWriteTokens += cacheWrite;
    this.cacheReadTokens += cacheRead;
    console.log(
      `[fc-cost] ${label}: in=${input} out=${output} cacheWrite=${cacheWrite} cacheRead=${cacheRead} ` +
        `→ $${callUsd.toFixed(4)} this call, $${this.totalUsd.toFixed(4)} running total`,
    );
  }
}

export function createFcAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — the flashcard pipeline cannot call the model.");
  }
  return new Anthropic();
}

export interface FcCallOptions<T> {
  client: Anthropic;
  cost: CostTracker;
  /** Static instruction block — byte-identical across calls so the cache breakpoint hits. */
  system: string;
  user: string;
  schema: ZodType<T>;
  maxTokens: number;
  label: string;
}

/**
 * One structured-outputs call: shape enforced API-side via output_config.format
 * (client.messages.parse + zodOutputFormat), thinking disabled, instruction
 * block cached with cache_control ephemeral. Note Haiku 4.5's minimum cacheable
 * prefix is 4096 tokens (DECISIONS.md 2026-08-12) — shorter instruction blocks
 * silently won't cache, which only costs pennies here.
 */
export async function fcStructuredCall<T>(opts: FcCallOptions<T>): Promise<T> {
  opts.cost.assertBudget();
  const response = await opts.client.messages.parse({
    model: FC_MODEL,
    max_tokens: opts.maxTokens,
    thinking: { type: "disabled" },
    output_config: { format: zodOutputFormat(opts.schema) },
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.user }],
  });

  opts.cost.add(opts.label, response.usage);

  if (response.stop_reason === "refusal") {
    throw new Error(`${opts.label}: model declined the request (stop_reason: refusal)`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`${opts.label}: response truncated at ${opts.maxTokens} tokens (stop_reason: max_tokens)`);
  }
  if (response.parsed_output == null) {
    throw new Error(`${opts.label}: model returned no structured output`);
  }
  return response.parsed_output;
}
