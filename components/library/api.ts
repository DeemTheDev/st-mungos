// Typed client for the library backend (upload → KB → generate → review).
//
// Same contract discipline as components/flashcards/api.ts, and for the same
// reason: this UI ships alongside a backend being written concurrently, so a
// deploy that lands the pages before the routes must render a friendly
// "not wired up yet" state, never a red error wall. Three failure kinds:
//
//   LibraryUnavailableError — route absent (404/405/501, HTML body, network)
//   LibraryApiError         — route present and said no (show its message)
//   BudgetError             — HTTP 402, a spend cap was hit. NOT a crash: the
//                             pipeline stopped on purpose, so it renders as a
//                             calm notice with the server's plain-text reason.
import type { OsceCase } from "@/lib/case-schema";

// ---------------------------------------------------------------------------
// types (mirroring lib/library/types.ts, which is the backend's own shape)

export type DocStatus = "uploaded" | "extracting" | "distilling" | "ready" | "failed";

export interface JobProgress {
  done: number;
  total: number;
}

/** One tick of POST /api/grounding/job/[id]/step — each call advances one step. */
export interface DocStep {
  status: DocStatus;
  progress: JobProgress;
  message?: string;
}

export interface SourceDocInfo {
  id: string;
  filename: string;
  status: DocStatus;
  progress?: JobProgress | null;
  error?: string | null;
  createdAt?: string;
}

export interface KbTopicInfo {
  slug: string;
  title: string;
  system: string;
  tokenCount: number;
  sourceRef: string | null;
  updatedAt: string;
}

export type GenStatus = "queued" | "running" | "done" | "failed";

/** One tick of POST /api/cases/job/[id]/step. */
export interface GenStep {
  status: GenStatus;
  progress: JobProgress;
  producedIds?: string[];
  message?: string;
}

export type CaseStatus = "draft" | "bank" | "rejected";
export type Commonness = "common" | "uncommon";

export interface CaseSummaryInfo {
  id: string;
  status: CaseStatus;
  stationType: "clinical" | "interpretation";
  discipline: string;
  diagnosis: string;
  commonness: Commonness;
  difficulty: number;
  createdAt?: string;
  /** Provenance, if the summary carries it (the list endpoint may omit it). */
  kbSource?: string | null;
}

export interface CaseDetail extends CaseSummaryInfo {
  data: OsceCase;
  reviewNote?: string | null;
  reviewedAt?: string | null;
}

export type ReviewAction = "approve" | "reject";

// ---------------------------------------------------------------------------
// errors

/** The backend route doesn't exist (yet) — show a friendly "not wired up" state. */
export class LibraryUnavailableError extends Error {
  constructor() {
    super("The library backend isn't connected yet.");
    this.name = "LibraryUnavailableError";
  }
}

/** The backend exists and said no — show its message. */
export class LibraryApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LibraryApiError";
    this.status = status;
  }
}

/** HTTP 402 — a spend cap stopped the work. Deliberate, not broken. */
export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

/** 402 bodies are plain text by contract, but tolerate a JSON envelope too. */
function budgetMessage(body: string): string {
  const text = body.trim();
  if (!text) return "That's the spending cap for now — the work stopped itself before it cost more.";
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        for (const key of ["error", "message"] as const) {
          const value = (parsed as Record<string, unknown>)[key];
          if (typeof value === "string" && value.trim()) return value.trim();
        }
      }
    } catch {
      /* fall through to the raw text */
    }
  }
  // A stray HTML error page would be unreadable as a notice.
  if (text.startsWith("<")) return "That's the spending cap for now — the work stopped itself before it cost more.";
  return text.slice(0, 400);
}

/** JSON `error`/`message`, else the plain-text body, else the bare status. */
function errorMessage(data: unknown, body: string, status: number): string {
  if (data && typeof data === "object") {
    for (const key of ["error", "message"] as const) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  const text = body.trim();
  if (text && !text.startsWith("<") && !text.startsWith("{")) return text.slice(0, 400);
  return `Request failed (${status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    // AbortError must surface as an abort, never as "backend missing".
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new LibraryUnavailableError();
  }
  // 405/501 = the route isn't implemented/deployed yet.
  //
  // 404 is ambiguous and must NOT be swallowed the same way: these routes
  // legitimately 404 for an unknown case/topic/job id, and rejecting a draft
  // twice 404s the second time (the file adapter deletes on reject). Answering
  // "the library backend isn't connected yet" to a double-click would be a lie
  // that sends Nadeem hunting a deploy problem that doesn't exist. A 404 with a
  // body is the route talking; a bodyless one means nothing answered.
  if (res.status === 405 || res.status === 501) {
    throw new LibraryUnavailableError();
  }
  if (res.status === 404) {
    const body = (await res.text()).trim();
    if (!body || body.startsWith("<")) throw new LibraryUnavailableError();
    let parsed: unknown = null;
    if (body.startsWith("{")) {
      try {
        parsed = JSON.parse(body);
      } catch {
        /* plain text it is */
      }
    }
    throw new LibraryApiError(errorMessage(parsed, body, 404), 404);
  }
  if (res.status === 402) {
    throw new BudgetError(budgetMessage(await res.text()));
  }
  if (res.status === 401 || res.status === 403) {
    throw new LibraryApiError("Your login has expired — reload the page to sign in again.", res.status);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // An HTML body on a JSON endpoint means the route isn't really there
      // (e.g. a catch-all page answered) — treat it as absent, not broken.
      if (res.ok) throw new LibraryUnavailableError();
    }
  }
  if (!res.ok) {
    // These routes answer failures with a written-for-a-human plain-text body
    // ("I can only read .pdf, .md and .docx files."), while the review endpoint
    // answers with JSON carrying `message`. Show whichever it sent — a bare
    // "Request failed (422)" would waste a perfectly good explanation.
    throw new LibraryApiError(errorMessage(data, text, res.status), res.status);
  }
  return data as T;
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// status helpers

const DOC_TERMINAL = new Set<string>(["ready", "failed"]);
const GEN_TERMINAL = new Set<string>(["done", "failed", "ready", "complete", "error", "cancelled"]);

export function isDocProcessing(status: DocStatus): boolean {
  return !DOC_TERMINAL.has(status);
}

/** Unknown/near-miss statuses are treated as still-running rather than crashing. */
export function normaliseGenStatus(status: string): GenStatus {
  if (status === "failed" || status === "error") return "failed";
  if (status === "done" || status === "ready" || status === "complete") return "done";
  if (status === "queued") return "queued";
  return "running";
}

export function isGenTerminal(status: string): boolean {
  return GEN_TERMINAL.has(status);
}

// ---------------------------------------------------------------------------
// endpoints

export async function uploadGuide(file: File): Promise<{ docId: string }> {
  const body = new FormData();
  body.append("file", file);
  const data = await request<{ docId?: string; documentId?: string; id?: string }>("/api/grounding/upload", {
    method: "POST",
    body,
  });
  const docId = data?.docId ?? data?.documentId ?? data?.id;
  if (!docId) throw new LibraryApiError("The upload came back without a document id.", 500);
  return { docId };
}

export async function stepDocJob(docId: string, signal?: AbortSignal): Promise<DocStep> {
  return request<DocStep>(`/api/grounding/job/${encodeURIComponent(docId)}/step`, { method: "POST", signal });
}

export async function getDocs(signal?: AbortSignal): Promise<SourceDocInfo[]> {
  const data = await request<{ docs?: SourceDocInfo[] }>("/api/grounding/docs", { signal });
  return Array.isArray(data?.docs) ? data.docs : [];
}

export async function getTopics(signal?: AbortSignal): Promise<KbTopicInfo[]> {
  const data = await request<{ topics?: KbTopicInfo[] }>("/api/kb/topics", { signal });
  return Array.isArray(data?.topics) ? data.topics : [];
}

export async function generateCases(params: {
  system: string;
  count: number;
  commonness: Commonness;
}): Promise<{ jobId: string }> {
  const data = await request<{ jobId?: string; id?: string }>("/api/cases/generate", jsonPost(params));
  const jobId = data?.jobId ?? data?.id;
  if (!jobId) throw new LibraryApiError("Generation started but didn't return a job id.", 500);
  return { jobId };
}

export async function stepGenJob(jobId: string, signal?: AbortSignal): Promise<GenStep> {
  const step = await request<GenStep>(`/api/cases/job/${encodeURIComponent(jobId)}/step`, { method: "POST", signal });
  return {
    status: normaliseGenStatus(String(step?.status ?? "running")),
    progress: step?.progress ?? { done: 0, total: 0 },
    producedIds: Array.isArray(step?.producedIds) ? step.producedIds : undefined,
    message: step?.message,
  };
}

export async function getCases(status: CaseStatus, signal?: AbortSignal): Promise<CaseSummaryInfo[]> {
  const data = await request<{ cases?: CaseSummaryInfo[] }>(
    `/api/cases?status=${encodeURIComponent(status)}`,
    { signal },
  );
  return Array.isArray(data?.cases) ? data.cases : [];
}

export async function getCase(id: string, signal?: AbortSignal): Promise<CaseDetail> {
  const data = await request<{ case?: CaseDetail }>(`/api/cases/${encodeURIComponent(id)}`, { signal });
  if (!data?.case) throw new LibraryApiError("That case came back empty.", 500);
  return data.case;
}

export async function reviewCase(id: string, action: ReviewAction, note?: string): Promise<{ status: string }> {
  const data = await request<{ status?: string }>(
    `/api/cases/${encodeURIComponent(id)}/review`,
    jsonPost(note ? { action, note } : { action }),
  );
  return { status: data?.status ?? (action === "approve" ? "bank" : "rejected") };
}

// ---------------------------------------------------------------------------
// poll loops — one step per call, ~600ms apart (same spacing as flashcards:
// under any sane rate limit, still feels live). Resolve with the terminal step,
// or null when aborted. Errors propagate to the caller.

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function pollDocJob(
  docId: string,
  onStep: (step: DocStep) => void,
  opts: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<DocStep | null> {
  const { signal, intervalMs = 600 } = opts;
  for (;;) {
    if (signal?.aborted) return null;
    const step = await stepDocJob(docId, signal);
    if (signal?.aborted) return null;
    onStep(step);
    if (!isDocProcessing(step.status)) return step;
    await sleep(intervalMs, signal);
  }
}

export async function pollGenJob(
  jobId: string,
  onStep: (step: GenStep) => void,
  opts: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<GenStep | null> {
  const { signal, intervalMs = 900 } = opts;
  for (;;) {
    if (signal?.aborted) return null;
    const step = await stepGenJob(jobId, signal);
    if (signal?.aborted) return null;
    onStep(step);
    if (isGenTerminal(step.status)) return step;
    await sleep(intervalMs, signal);
  }
}

// ---------------------------------------------------------------------------
// display helpers shared by the library pages

const SYSTEM_LABELS: Record<string, string> = {
  resp: "Respiratory",
  cardio: "Cardiovascular",
  "gi-hep": "GI & hepatology",
  endo: "Endocrine",
  neuro: "Neurology",
  renal: "Renal",
  haem: "Haematology",
  id: "Infectious diseases",
  rheum: "Rheumatology",
  other: "Unfiled",
};

/** The nine OSCE systems (lib/case-schema DisciplineSchema), in teaching order. */
export const SYSTEMS: string[] = ["resp", "cardio", "gi-hep", "endo", "neuro", "renal", "haem", "id", "rheum"];

export function systemLabel(system: string): string {
  return SYSTEM_LABELS[system] ?? system;
}

/** "3 minutes ago" / "yesterday" / a plain date once it stops being news. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}
