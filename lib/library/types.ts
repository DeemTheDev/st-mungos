// Phase 6 "library" ports: the pieces that used to be CLI-only (upload a guide,
// distil it into KB topics, generate stations, approve them) expressed as
// storage-agnostic interfaces, so the exact same code path runs against local
// files in dev and Supabase in production — selected by STORE, like everything
// else in this app.
//
// Naming note: `CaseStore` (lib/ports.ts) stays exactly as it is — it is the
// READ side the session engine uses, and it must keep returning bank cases only.
// `CaseLibrary` below is the WRITE/review side. Keeping them separate is what
// guarantees a draft can never be served to a student by accident.
import type { OsceCase } from "../case-schema";

// ---------------------------------------------------------------------------
// Source documents

export type SourceDocStatus = "uploaded" | "extracting" | "distilling" | "ready" | "failed";

export interface SourceDoc {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  storagePath: string | null;
  status: SourceDocStatus;
  /** Progress across the whole job, in whatever unit the current phase uses. */
  progress: { done: number; total: number };
  /** Opaque resume state — extracted pages, chunk plan, per-chunk results. */
  checkpoint: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceDocStore {
  put(doc: SourceDoc): Promise<void>;
  get(id: string): Promise<SourceDoc | null>;
  list(): Promise<SourceDoc[]>;
  /** Raw bytes of the upload — Storage bucket in prod, disk in dev. */
  putBlob(id: string, filename: string, bytes: Uint8Array): Promise<string>;
  getBlob(storagePath: string): Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------------------
// KB topics

export interface KbTopicRecord {
  slug: string;
  title: string;
  /** resp | cardio | gi-hep | endo | neuro | renal | haem | id | rheum | other */
  system: string;
  content: string;
  sourceDoc: string | null;
  /** Human-readable provenance, e.g. "pages 12-40 of Approach to Everything". */
  sourceRef: string | null;
  tokenCount: number;
  updatedAt: string;
}

export interface KbLibrary {
  list(): Promise<KbTopicRecord[]>;
  get(slug: string): Promise<KbTopicRecord | null>;
  upsert(topic: KbTopicRecord): Promise<void>;
  /** Keyword lookup used when grounding a generation run. */
  search(keywords: string[], limit?: number): Promise<KbTopicRecord[]>;
}

// ---------------------------------------------------------------------------
// Cases (the review side)

export type CaseStatus = "draft" | "bank" | "rejected";

export interface CaseRecord {
  id: string;
  status: CaseStatus;
  stationType: "clinical" | "interpretation";
  discipline: string;
  diagnosis: string;
  commonness: "common" | "uncommon";
  difficulty: number;
  data: OsceCase;
  kbSource: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface CaseLibrary {
  list(status?: CaseStatus): Promise<CaseRecord[]>;
  get(id: string): Promise<CaseRecord | null>;
  /** Insert a freshly generated draft. Must reject a duplicate id. */
  put(record: CaseRecord): Promise<void>;
  /**
   * The review gate. Re-validates against OsceCaseSchema on the way to "bank"
   * — a case can be hand-edited between generation and approval, and nothing
   * unvalidated may become playable.
   */
  setStatus(id: string, status: CaseStatus, note?: string | null): Promise<void>;
  /** Diagnoses already taken, so generation never pays for a duplicate. */
  takenDiagnoses(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Spend ledger + guardrails

export interface SpendEntry {
  jobId: string | null;
  kind: "distill" | "generate-case" | "survey" | "extract" | "reconcile";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
}

export interface SpendLedger {
  record(entry: SpendEntry): Promise<void>;
  /** Total spent by one job so far — enforces the per-job cap. */
  jobTotal(jobId: string): Promise<number>;
  /** Month-to-date across everything — enforces the monthly ceiling. */
  monthTotal(): Promise<number>;
}

/**
 * Budget limits. Defaults are deliberately conservative: Nadeem funds this from
 * a small prepaid balance, and an autonomous pipeline that can spend without a
 * human present needs a hard stop, not a warning.
 *
 * Env: LIBRARY_JOB_BUDGET_USD (default 2.00), LIBRARY_MONTH_BUDGET_USD (10.00).
 */
export interface Budget {
  perJobUsd: number;
  perMonthUsd: number;
}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly scope: "job" | "month",
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

// ---------------------------------------------------------------------------
// Generation jobs

export type GenJobStatus = "queued" | "running" | "done" | "failed";

export interface GenJob {
  id: string;
  system: string;
  count: number;
  commonness: "common" | "uncommon";
  status: GenJobStatus;
  progress: { done: number; total: number };
  /** Ids of the drafts written so far — the UI links straight to review. */
  producedIds: string[];
  error: string | null;
  createdAt: string;
}

/** One poll tick = one unit of work. Mirrors the flashcards job contract. */
export interface JobStepResult {
  status: string;
  progress: { done: number; total: number };
  message?: string;
  producedIds?: string[];
}

// ---------------------------------------------------------------------------

export interface Library {
  docs: SourceDocStore;
  kb: KbLibrary;
  cases: CaseLibrary;
  spend: SpendLedger;
  budget: Budget;
}
