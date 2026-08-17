// Library selection: STORE=file|supabase, default file — the same env var that
// already picks the session store, the case store and the flashcard store
// (DECISIONS.md 2026-08-13). One variable moves the whole app between "Nadeem's
// laptop" and "production", and every library caller depends on the ports in
// ./types, never on an adapter.

import { FileLibrary } from "../stores/file-library";
import { SupabaseLibrary } from "../stores/supabase-library";
import type { Budget, Library } from "./types";

// Conservative on purpose: this pipeline can spend money with no human present,
// so the caps are a hard stop rather than a warning (lib/library/types.ts).
const DEFAULT_JOB_BUDGET_USD = 2.0;
const DEFAULT_MONTH_BUDGET_USD = 10.0;

function envUsd(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  // A typo'd cap must never read as "unlimited" — fall back loudly instead.
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`(!) ${name}="${raw}" is not a positive number — using $${fallback.toFixed(2)}`);
    return fallback;
  }
  return value;
}

/** LIBRARY_JOB_BUDGET_USD (default 2.00) / LIBRARY_MONTH_BUDGET_USD (10.00). */
export function resolveBudget(): Budget {
  return {
    perJobUsd: envUsd("LIBRARY_JOB_BUDGET_USD", DEFAULT_JOB_BUDGET_USD),
    perMonthUsd: envUsd("LIBRARY_MONTH_BUDGET_USD", DEFAULT_MONTH_BUDGET_USD),
  };
}

export function getLibrary(): Library {
  const kind = (process.env.STORE ?? "file").toLowerCase();
  const budget = resolveBudget();
  if (kind === "supabase") return new SupabaseLibrary(budget);
  if (kind !== "file") {
    console.warn(`(!) Unknown STORE="${process.env.STORE}" — library falling back to file`);
  }
  return new FileLibrary(budget);
}

export * from "./types";
