"use client";

// /flashcards home — a bento in the station's design language (one radius
// scale, border-neutral-800/60, emerald primary, amber accents):
//
//   ┌────────── due-today hero ──────────┬── upload tile ──┐
//   │ big number + Start review          │ drag-drop/pick  │
//   ├────────────────── search bar ──────┴─────────────────┤
//   │ deck tiles (topic · count · due badge)               │
//   │ documents (status chip · live progress · retry)      │
//   └──────────────────────────────────────────────────────┘
//
// Processing documents poll POST /job/[id]/step (~600ms spacing, one poll loop
// per document) WITHOUT blocking anything else on the page — the loops live in
// a ref-held map of AbortControllers, and a document reaching `ready` triggers
// one decks refresh so the topic tiles pick up the new cards. The backend is
// being built concurrently: every fetch failure degrades to a friendly state.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FlashcardsApiError,
  FlashcardsUnavailableError,
  getDecks,
  isProcessing,
  pollDocumentJob,
  uploadDocument,
  type DeckTopic,
  type DocumentInfo,
  type DocumentStatus,
  type JobStep,
} from "./api";

const TILE = "rounded-xl border border-neutral-800/60 bg-neutral-900/40";
const LABEL = "text-xs font-semibold tracking-widest text-neutral-500 uppercase";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const STATUS_TONE: Record<DocumentStatus, string> = {
  uploaded: "bg-neutral-800 text-neutral-300",
  surveying: "bg-sky-950 text-sky-300",
  extracting: "bg-sky-950 text-sky-300",
  reconciling: "bg-sky-950 text-sky-300",
  ready: "bg-emerald-950 text-emerald-300",
  failed: "bg-red-950 text-red-300",
};

const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploaded: "queued",
  surveying: "surveying",
  extracting: "extracting",
  reconciling: "reconciling",
  ready: "ready",
  failed: "failed",
};

type DeckState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

interface DocLive {
  step?: JobStep;
  error?: string;
}

function ProgressBar({ progress }: { progress?: { done: number; total: number } }) {
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  if (total <= 0) {
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-emerald-700" />
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
      <div className="h-full rounded-full bg-emerald-600 transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function HomeClient() {
  const router = useRouter();

  const [deckState, setDeckState] = useState<DeckState>({ kind: "loading" });
  const [topics, setTopics] = useState<DeckTopic[]>([]);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [docLive, setDocLive] = useState<Record<string, DocLive>>({});

  const [uploading, setUploading] = useState<string | null>(null); // filename while in flight
  const [uploadError, setUploadError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [search, setSearch] = useState("");

  const pollsRef = useRef(new Map<string, AbortController>());

  // Abort every poll loop when the page unmounts.
  useEffect(() => {
    const polls = pollsRef.current;
    return () => {
      polls.forEach((ctl) => ctl.abort());
      polls.clear();
    };
  }, []);

  // Promise-chain style on purpose: setState only ever runs inside async
  // callbacks, so calling refresh() from an effect can't cascade renders.
  const refresh = useCallback(
    () =>
      getDecks()
        .then((decks) => {
          setTopics(decks.topics);
          setDocuments(decks.documents);
          setDeckState({ kind: "ready" });
        })
        .catch((err: unknown) => {
          if (err instanceof FlashcardsUnavailableError) {
            setDeckState({ kind: "unavailable" });
          } else {
            setDeckState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
          }
        }),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startPolling = useCallback(
    (documentId: string) => {
      if (pollsRef.current.has(documentId)) return;
      const ctl = new AbortController();
      pollsRef.current.set(documentId, ctl);
      // No setState before the first await: startPolling is also called from an
      // effect, and a synchronous setState there would cascade renders. Stale
      // errors are cleared by retryDocument (an event handler) and overwritten
      // by the first poll tick regardless.
      void (async () => {
        try {
          const final = await pollDocumentJob(
            documentId,
            (step) => setDocLive((prev) => ({ ...prev, [documentId]: { step } })),
            { signal: ctl.signal },
          );
          if (final?.status === "ready") await refresh();
        } catch (err) {
          if (ctl.signal.aborted) return;
          const message =
            err instanceof FlashcardsUnavailableError
              ? "The processing endpoint isn't reachable yet — the backend may still be deploying. Retry in a moment."
              : err instanceof Error
                ? err.message
                : String(err);
          setDocLive((prev) => ({ ...prev, [documentId]: { ...prev[documentId], error: message } }));
        } finally {
          pollsRef.current.delete(documentId);
        }
      })();
    },
    [refresh],
  );

  // Any document the server says is mid-pipeline gets a poll loop. startPolling
  // is idempotent per id, so re-runs after refresh() are harmless.
  useEffect(() => {
    for (const doc of documents) {
      if (isProcessing(doc.status)) startPolling(doc.id);
    }
  }, [documents, startPolling]);

  const handleFiles = useCallback(
    async (files: FileList | null | undefined) => {
      const file = files?.[0];
      if (!file || uploading) return;
      const name = file.name.toLowerCase();
      if (!name.endsWith(".pdf") && !name.endsWith(".docx")) {
        setUploadError("PDF or Word (.docx) only — that's what the extractor can read.");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploadError("Over the 25 MB cap — split the document and upload the halves.");
        return;
      }
      setUploadError("");
      setUploading(file.name);
      try {
        const { documentId } = await uploadDocument(file);
        setDocuments((prev) => [
          {
            id: documentId,
            filename: file.name,
            status: "uploaded",
            progress: { done: 0, total: 0 },
            cardCount: null,
            createdAt: new Date().toISOString(),
          },
          ...prev.filter((d) => d.id !== documentId),
        ]);
        startPolling(documentId);
      } catch (err) {
        setUploadError(
          err instanceof FlashcardsUnavailableError
            ? "The upload endpoint isn't live yet — the backend is still being wired in."
            : err instanceof FlashcardsApiError
              ? err.message
              : "Upload failed — try again.",
        );
      } finally {
        setUploading(null);
      }
    },
    [startPolling, uploading],
  );

  const retryDocument = useCallback(
    (documentId: string) => {
      setDocLive((prev) => ({ ...prev, [documentId]: { step: prev[documentId]?.step } }));
      startPolling(documentId);
    },
    [startPolling],
  );

  const dueToday = topics.reduce((sum, t) => sum + (t.dueToday || 0), 0);
  const totalCards = topics.reduce((sum, t) => sum + (t.count || 0), 0);
  const backendMissing = deckState.kind === "unavailable";

  return (
    <div>
      {/* hero + upload */}
      <div className="grid gap-3 lg:grid-cols-3">
        <section className={`${TILE} flex flex-col justify-between p-6 lg:col-span-2`}>
          <div>
            <p className={LABEL}>Due today</p>
            <p className="mt-2 text-5xl font-semibold tabular-nums text-neutral-100 sm:text-6xl">
              {deckState.kind === "loading" ? (
                <span className="text-neutral-700">…</span>
              ) : deckState.kind === "ready" ? (
                dueToday
              ) : (
                <span className="text-neutral-700">—</span>
              )}
            </p>
            <p className="mt-2 text-sm text-neutral-500">
              {backendMissing
                ? "The card store isn't connected yet — decks will appear here once the backend lands."
                : deckState.kind === "error"
                  ? `Couldn't load the decks: ${deckState.message}`
                  : totalCards > 0
                    ? `across ${topics.length} topic${topics.length === 1 ? "" : "s"} · ${totalCards} cards in the box`
                    : "cards scheduled for review land here"}
            </p>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/flashcards/review"
              className={
                dueToday > 0
                  ? "rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-medium text-emerald-50 transition-colors hover:bg-emerald-600"
                  : "rounded-lg border border-neutral-700 px-5 py-2.5 text-sm font-medium text-neutral-300 transition-colors hover:border-neutral-500 hover:bg-neutral-900"
              }
            >
              Start review
            </Link>
            <Link
              href="/flashcards/browse"
              className="text-sm text-neutral-500 underline-offset-4 transition-colors hover:text-neutral-300 hover:underline"
            >
              Browse all cards
            </Link>
          </div>
        </section>

        <section className={`${TILE} p-4`}>
          <p className={LABEL}>Add a document</p>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void handleFiles(e.dataTransfer.files);
            }}
            className={`mt-3 flex min-h-32 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
              dragOver
                ? "border-emerald-600 bg-emerald-950/20"
                : "border-neutral-800 hover:border-neutral-600 hover:bg-neutral-900/60"
            }`}
          >
            <input
              type="file"
              accept=".pdf,.docx"
              className="sr-only"
              disabled={Boolean(uploading)}
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {uploading ? (
              <>
                <span className="animate-pulse text-sm text-emerald-300">Uploading…</span>
                <span className="max-w-full truncate text-xs text-neutral-500">{uploading}</span>
              </>
            ) : (
              <>
                <span className="text-sm text-neutral-200">Drop a Q&amp;A PDF or .docx here</span>
                <span className="text-xs text-neutral-500">or tap to pick · 25 MB max</span>
              </>
            )}
          </label>
          {uploadError && <p className="mt-2 text-xs text-amber-300">{uploadError}</p>}
        </section>
      </div>

      {/* search */}
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          const q = search.trim();
          router.push(q ? `/flashcards/browse?query=${encodeURIComponent(q)}` : "/flashcards/browse");
        }}
      >
        <label className="sr-only" htmlFor="fc-search">
          Search cards
        </label>
        <div className={`${TILE} flex items-center gap-2 px-4 py-2.5`}>
          <span aria-hidden className="text-neutral-600">
            ⌕
          </span>
          <input
            id="fc-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search questions, answers or topics…"
            className="w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100"
          >
            Search
          </button>
        </div>
      </form>

      {/* decks */}
      <section className="mt-8">
        <h2 className={`mb-3 ${LABEL}`}>Decks by topic</h2>
        {deckState.kind === "loading" ? (
          <p className="text-sm text-neutral-600">Fetching decks…</p>
        ) : topics.length === 0 ? (
          <div className={`${TILE} p-6 text-center`}>
            <p className="text-sm text-neutral-300">No decks yet.</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
              {backendMissing
                ? "Once the backend is connected, upload a Q&A document and its topics will appear here as decks."
                : "Upload a Q&A document above — the extractor sorts its cards into topic decks automatically."}
            </p>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {topics.map((t) => (
              <li key={t.topic}>
                <Link
                  href={`/flashcards/review?topic=${encodeURIComponent(t.topic)}`}
                  className={`${TILE} block p-4 transition-colors hover:border-neutral-700 hover:bg-neutral-900/70`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 truncate text-sm font-medium text-neutral-100">{t.topic}</p>
                    {t.dueToday > 0 ? (
                      <span className="shrink-0 rounded-full bg-emerald-950 px-2 py-0.5 text-xs tabular-nums text-emerald-300">
                        {t.dueToday} due
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-500">
                        clear
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-neutral-500">
                    {t.count} card{t.count === 1 ? "" : "s"}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* documents */}
      <section className="mt-8">
        <h2 className={`mb-3 ${LABEL}`}>Documents</h2>
        {deckState.kind === "loading" ? (
          <p className="text-sm text-neutral-600">Fetching documents…</p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-neutral-500">
            {backendMissing
              ? "Uploaded documents and their extraction progress will be tracked here."
              : "Nothing uploaded yet — the pipeline surveys each document, extracts cards page-window by page-window, then reconciles orphans."}
          </p>
        ) : (
          <ul className="space-y-2">
            {documents.map((doc) => {
              const live = docLive[doc.id];
              const status = live?.step?.status ?? doc.status;
              const progress = live?.step?.progress ?? doc.progress ?? undefined;
              const cardCount = live?.step?.cardCount ?? doc.cardCount;
              const message = live?.step?.message;
              const active = isProcessing(status) && !live?.error;
              return (
                <li key={doc.id} className={`${TILE} p-3`}>
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-neutral-200">{doc.filename}</p>
                      <p className="mt-0.5 text-xs text-neutral-600">
                        {doc.createdAt ? new Date(doc.createdAt).toLocaleString() : ""}
                        {status === "ready" && typeof cardCount === "number" && (
                          <span className="text-neutral-400"> · {cardCount} cards</span>
                        )}
                      </p>
                    </div>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${STATUS_TONE[status] ?? STATUS_TONE.uploaded}`}>
                      {STATUS_LABEL[status] ?? status}
                    </span>
                  </div>
                  {active && (
                    <div className="mt-2.5">
                      <ProgressBar progress={progress} />
                      <p className="mt-1.5 text-xs text-neutral-500" aria-live="polite">
                        {message ??
                          (progress && progress.total > 0
                            ? `window ${progress.done} of ${progress.total}`
                            : "working…")}
                      </p>
                    </div>
                  )}
                  {(status === "failed" || live?.error) && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-red-300">
                        {live?.error ?? message ?? "Extraction failed — the source pages are unharmed."}
                      </p>
                      <button
                        type="button"
                        onClick={() => retryDocument(doc.id)}
                        className="rounded-lg border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
