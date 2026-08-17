// The money guardrail for the server-side library pipeline (Phase 6).
//
// WHY a hard stop and not a warning: distillation and generation now run with
// no human in the loop — she uploads a guide from her phone and the browser
// polls the job to completion. A runaway (a model that keeps failing
// validation, a 300-page PDF that splits into 60 chapters) would spend real
// money from a small prepaid balance with nobody watching. So every model call
// in lib/library asks this module for permission BEFORE the call and writes a
// ledger row AFTER it — the ledger is the only source of truth for both caps.
//
// This module also owns the pipeline's error taxonomy, because "what does the
// user see when this fails" is the same question as "what did it cost".

import type Anthropic from "@anthropic-ai/sdk";

import { BudgetExceededError, type Budget, type SpendEntry, type SpendLedger } from "./types";

// ---------------------------------------------------------------------------
// errors

/**
 * An error whose message is SAFE to show the user verbatim — written by us, in
 * plain language, containing no vendor payloads. Everything else that escapes
 * the pipeline is reported as a bare status code (CLAUDE.md §2.4: Supabase and
 * Anthropic error bodies never reach the client).
 */
export class LibraryUserError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "LibraryUserError";
  }
}

/** A document that can never succeed (a scan, an unsupported type) — terminal. */
export class UnprocessableDocumentError extends LibraryUserError {
  constructor(message: string) {
    super(message, 415);
    this.name = "UnprocessableDocumentError";
  }
}

// ---------------------------------------------------------------------------
// pricing

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function usageOf(usage: Anthropic.Usage): CallUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

interface Price {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
}

// Same table as scripts/gen-common.ts and lib/kb-pipeline/distill.ts: Sonnet 5
// intro pricing through 2026-08-31, Haiku 4.5 list. Cache write is 1.25x input,
// cache read 0.1x input for both.
const PRICES: Record<string, Price> = {
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};
const DEFAULT_PRICE: Price = PRICES["claude-sonnet-5"];

export function estimateUsd(model: string, usage: CallUsage): number {
  const price = PRICES[model] ?? DEFAULT_PRICE;
  return (
    (usage.inputTokens * price.in +
      usage.cacheWriteTokens * price.in * 1.25 +
      usage.cacheReadTokens * price.in * 0.1 +
      usage.outputTokens * price.out) /
    1_000_000
  );
}

// Cents for real money, four places for the tiny caps a test or a nervous
// evening might set — "$0.00" as a stated limit reads like a bug.
const usd = (n: number): string => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

// ---------------------------------------------------------------------------
// the guard

/**
 * What every model call in the pipeline talks to. Two implementations: the
 * real `BudgetGuard` (API routes — ledger-backed, hard stop) and
 * `consoleSpendSink()` (the CLIs — log-only, so `pnpm gen:cases` keeps behaving
 * exactly as it did before the server pipeline existed).
 */
export interface SpendSink {
  /** Throws BudgetExceededError when the next call must not happen. */
  assertWithinBudget(): Promise<void>;
  /** Records one completed call; returns what it cost. */
  record(kind: SpendEntry["kind"], model: string, usage: CallUsage): Promise<number>;
}

export class BudgetGuard implements SpendSink {
  constructor(
    private readonly spend: SpendLedger,
    private readonly budget: Budget,
    /** Null for work that isn't part of a job (only the monthly ceiling applies). */
    private readonly jobId: string | null,
  ) {}

  async assertWithinBudget(): Promise<void> {
    if (this.jobId) {
      const jobSpent = await this.spend.jobTotal(this.jobId);
      if (jobSpent >= this.budget.perJobUsd) {
        throw new BudgetExceededError(
          `This job has already spent ${usd(jobSpent)} and the limit for one job is ${usd(this.budget.perJobUsd)}, ` +
            `so I stopped before the next model call. Everything finished so far is saved — start a fresh job to carry on, ` +
            `or raise LIBRARY_JOB_BUDGET_USD.`,
          "job",
          jobSpent,
          this.budget.perJobUsd,
        );
      }
    }
    const monthSpent = await this.spend.monthTotal();
    if (monthSpent >= this.budget.perMonthUsd) {
      throw new BudgetExceededError(
        `Model spending this month is ${usd(monthSpent)} and the monthly ceiling is ${usd(this.budget.perMonthUsd)}, ` +
          `so I stopped before the next model call. Nothing was lost — this resets next month, ` +
          `or raise LIBRARY_MONTH_BUDGET_USD.`,
        "month",
        monthSpent,
        this.budget.perMonthUsd,
      );
    }
  }

  async record(kind: SpendEntry["kind"], model: string, usage: CallUsage): Promise<number> {
    const cost = estimateUsd(model, usage);
    await this.spend.record({
      jobId: this.jobId,
      kind,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      usd: cost,
    });
    return cost;
  }
}

export function createBudgetGuard(
  library: { spend: SpendLedger; budget: Budget },
  jobId: string | null,
): BudgetGuard {
  return new BudgetGuard(library.spend, library.budget, jobId);
}

/**
 * The CLI sink: no cap (a human is watching the terminal), but the same
 * per-call usage line the generators have always printed, with a running total.
 */
export function consoleSpendSink(indent = "        "): SpendSink {
  let runTotal = 0;
  return {
    async assertWithinBudget() {},
    async record(kind, model, usage) {
      const cost = estimateUsd(model, usage);
      runTotal += cost;
      console.log(
        `${indent}[usage] in ${usage.inputTokens} | cache write ${usage.cacheWriteTokens} read ${usage.cacheReadTokens} | ` +
          `out ${usage.outputTokens} | $${cost.toFixed(4)} (run total $${runTotal.toFixed(4)})`,
      );
      return cost;
    },
  };
}
