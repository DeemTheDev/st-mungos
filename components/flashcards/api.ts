// Typed client for the flashcards backend (contract: docs/FLASHCARDS.md).
// The backend is being built CONCURRENTLY with this UI, so every helper must
// distinguish "the endpoint isn't wired up yet" (FlashcardsUnavailableError —
// pages degrade to friendly empty states) from a real failure
// (FlashcardsApiError — pages show the message). That distinction is permanent:
// a fresh deploy without the API routes must never render a red error wall.

export type DocumentStatus =
  | "uploaded"
  | "surveying"
  | "extracting"
  | "reconciling"
  | "ready"
  | "failed";

export interface JobProgress {
  done: number;
  total: number;
}

/** One tick of POST /api/flashcards/job/[id]/step — each call advances one step. */
export interface JobStep {
  status: DocumentStatus;
  progress: JobProgress;
  message?: string;
  cardCount?: number;
}

export interface DocumentInfo {
  id: string;
  filename: string;
  status: DocumentStatus;
  progress?: JobProgress | null;
  cardCount?: number | null;
  createdAt?: string;
}

export interface DeckTopic {
  topic: string;
  count: number;
  dueToday: number;
  /** Never studied. Counted separately because a due count alone reads as 0 on a
   *  brand-new deck, which is exactly when she has the most to do. */
  newCards: number;
}

export interface DecksResponse {
  topics: DeckTopic[];
  documents: DocumentInfo[];
}

export type CardStatus = "auto" | "needs_review";

export interface CardInfo {
  id: string;
  topic: string;
  /** The governing vignette. Front-of-card content — shown WITH the question. */
  context?: string;
  question: string;
  answer: string;
  sourcePages: number[];
  status: CardStatus;
}

export interface CardsResponse {
  cards: CardInfo[];
  total: number;
}

export interface ReviewCard {
  id: string;
  topic: string;
  /**
   * The governing vignette, when this card is one sub-question of a case.
   * Rendered ABOVE the question at the same moment — never behind the reveal.
   */
  context?: string;
  /** May embed MCQ options as lines — see parseMcq in question-body.tsx. */
  question: string;
}

export type ReviewGrade = "again" | "hard" | "good" | "easy";

/** The backend route doesn't exist (yet) — show a friendly "not wired up" state. */
export class FlashcardsUnavailableError extends Error {
  constructor() {
    super("The flashcards backend isn't connected yet.");
    this.name = "FlashcardsUnavailableError";
  }
}

/** The backend exists and said no — show its message. */
export class FlashcardsApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FlashcardsApiError";
    this.status = status;
  }
}

export function isProcessing(status: DocumentStatus): boolean {
  return (
    status === "uploaded" ||
    status === "surveying" ||
    status === "extracting" ||
    status === "reconciling"
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    // AbortError must surface as an abort, never as "backend missing".
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new FlashcardsUnavailableError();
  }
  // 404/405/501 = the route isn't implemented/deployed yet.
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    throw new FlashcardsUnavailableError();
  }
  if (res.status === 401 || res.status === 403) {
    throw new FlashcardsApiError("Your login has expired — reload the page to sign in again.", res.status);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // An HTML body on a JSON endpoint means the route isn't really there
      // (e.g. a catch-all page answered) — treat it as absent, not broken.
      if (res.ok) throw new FlashcardsUnavailableError();
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `Request failed (${res.status})`;
    throw new FlashcardsApiError(message, res.status);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// endpoints

export async function uploadDocument(file: File): Promise<{ documentId: string }> {
  const body = new FormData();
  body.append("file", file);
  return request<{ documentId: string }>("/api/flashcards/upload", { method: "POST", body });
}

export interface RebuildPreview {
  /** null when the caller only asked what a rebuild would cost. */
  applied: boolean;
  filename: string;
  cardCount: number;
  /** Cards with FSRS scheduling that a rebuild destroys. */
  reviewCount: number;
}

/**
 * Rebuild one document's cards from the already-stored file. `apply: false`
 * (the default) only reports what would be lost — the UI shows that first so a
 * destructive rebuild is never one tap away.
 */
export async function rebuildDocument(documentId: string, apply: boolean): Promise<RebuildPreview> {
  return request<RebuildPreview>(`/api/flashcards/documents/${encodeURIComponent(documentId)}/rebuild`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apply }),
  });
}

export async function stepJob(documentId: string, signal?: AbortSignal): Promise<JobStep> {
  return request<JobStep>(`/api/flashcards/job/${encodeURIComponent(documentId)}/step`, {
    method: "POST",
    signal,
  });
}

export async function getDocuments(signal?: AbortSignal): Promise<DocumentInfo[]> {
  // The route answers { documents: [...] }, not a bare array.
  const data = await request<{ documents?: DocumentInfo[] } | DocumentInfo[]>("/api/flashcards/documents", {
    signal,
  });
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.documents) ? data.documents : [];
}

/** The decks route's per-topic row, which uses fuller field names than the UI. */
interface DeckTopicRow {
  topic: string;
  cardCount?: number;
  dueCount?: number;
  newCount?: number;
  count?: number;
  dueToday?: number;
}

export async function getDecks(signal?: AbortSignal): Promise<DecksResponse> {
  // Decks and documents are separate endpoints; the home page wants both, and
  // the document rows are what carry the rebuild control.
  const [decks, documents] = await Promise.all([
    request<{ topics?: DeckTopicRow[] }>("/api/flashcards/decks", { signal }),
    getDocuments(signal).catch(() => [] as DocumentInfo[]),
  ]);
  const rows = Array.isArray(decks?.topics) ? decks.topics : [];
  return {
    topics: rows.map((t) => ({
      topic: t.topic,
      count: t.cardCount ?? t.count ?? 0,
      dueToday: t.dueCount ?? t.dueToday ?? 0,
      newCards: t.newCount ?? 0,
    })),
    documents,
  };
}

export interface CardsQuery {
  query?: string;
  topic?: string;
  documentId?: string;
  status?: CardStatus | "";
}

export async function getCards(params: CardsQuery, signal?: AbortSignal): Promise<CardsResponse> {
  const search = new URLSearchParams();
  if (params.query) search.set("query", params.query);
  if (params.topic) search.set("topic", params.topic);
  if (params.documentId) search.set("documentId", params.documentId);
  if (params.status) search.set("status", params.status);
  const qs = search.toString();
  const data = await request<Partial<CardsResponse>>(`/api/flashcards/cards${qs ? `?${qs}` : ""}`, { signal });
  return {
    cards: Array.isArray(data?.cards) ? data.cards : [],
    total: typeof data?.total === "number" ? data.total : Array.isArray(data?.cards) ? data.cards.length : 0,
  };
}

export async function reviewNext(topic?: string): Promise<{ card: ReviewCard | null; remaining: number }> {
  const data = await request<{ card?: ReviewCard | null; remaining?: number }>("/api/flashcards/review/next", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(topic ? { topic } : {}),
  });
  return { card: data?.card ?? null, remaining: typeof data?.remaining === "number" ? data.remaining : 0 };
}

export async function reviewReveal(cardId: string): Promise<{ answer: string; sourcePages: number[] }> {
  const data = await request<{ answer?: string; sourcePages?: number[] }>("/api/flashcards/review/reveal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cardId }),
  });
  return {
    answer: typeof data?.answer === "string" ? data.answer : "",
    sourcePages: Array.isArray(data?.sourcePages) ? data.sourcePages : [],
  };
}

export async function reviewGrade(cardId: string, grade: ReviewGrade): Promise<{ nextDueAt: string | null }> {
  const data = await request<{ nextDueAt?: string }>("/api/flashcards/review/grade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cardId, grade }),
  });
  return { nextDueAt: typeof data?.nextDueAt === "string" ? data.nextDueAt : null };
}

// ---------------------------------------------------------------------------
// poll loop — each step call advances the job one step server-side; ~600ms
// spacing keeps us under any sane rate limit while feeling live. Resolves with
// the terminal step, or null if aborted. Errors propagate to the caller.

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

export async function pollDocumentJob(
  documentId: string,
  onStep: (step: JobStep) => void,
  opts: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<JobStep | null> {
  const { signal, intervalMs = 600 } = opts;
  for (;;) {
    if (signal?.aborted) return null;
    const step = await stepJob(documentId, signal);
    if (signal?.aborted) return null;
    onStep(step);
    if (step.status === "ready" || step.status === "failed") return step;
    await sleep(intervalMs, signal);
  }
}

// ---------------------------------------------------------------------------
// small display helpers shared by the pages

/** [3,4,5,9] → "pp. 3–5, 9"; [7] → "p. 7"; [] → null. */
export function formatPages(pages: number[] | null | undefined): string | null {
  if (!pages || pages.length === 0) return null;
  const sorted = Array.from(new Set(pages)).sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  return `${sorted.length === 1 ? "p." : "pp."} ${ranges.join(", ")}`;
}
