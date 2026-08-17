"use client";

// /library — the whole pipeline on one page, in the order it actually runs:
//
//   ┌ 1 upload a guide ───────────┬ 3 generate stations ────────┐
//   │ drag-drop, live job progress│ system · count · commonness │
//   ├─────────────────────────────┴─────────────────────────────┤
//   │ your study guides (per-doc progress, what the KB gained)   │
//   │ 2 what the app has learned — KB topics by system + source  │
//   └───────────────────────────────────────────────────────────┘
//
// Both jobs are ROWS, not modals: every poll loop lives in a ref-held
// AbortController, so uploading a second guide, reading the KB or kicking off a
// generation all stay possible while another job ticks. Polling mirrors the
// flashcards home page exactly — POST one step per tick, ~600ms apart.
//
// Generation is manual by design (CLAUDE.md §5d): it spends API credit and
// creates review work, so it happens when she presses the button, never on its
// own. A 402 back from the server is a budget cap doing its job — rendered as a
// calm notice, never as an error.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BudgetError,
  LibraryApiError,
  LibraryUnavailableError,
  SYSTEMS,
  generateCases,
  getDocs,
  getTopics,
  isDocProcessing,
  pollDocJob,
  pollGenJob,
  systemLabel,
  timeAgo,
  uploadGuide,
  type Commonness,
  type DocStatus,
  type DocStep,
  type GenStep,
  type KbTopicInfo,
  type SourceDocInfo,
} from "./api";
import { Chip, LABEL, Notice, ProgressBar, TILE } from "./ui";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ACCEPTED = [".pdf", ".md", ".docx"];
const GEN_JOB_KEY = "st-mungos:library-genjob";

const DOC_TONE: Record<DocStatus, string> = {
  uploaded: "bg-neutral-800 text-neutral-300",
  extracting: "bg-sky-950 text-sky-300",
  distilling: "bg-sky-950 text-sky-300",
  ready: "bg-emerald-950 text-emerald-300",
  failed: "bg-red-950 text-red-300",
};

const DOC_LABEL: Record<DocStatus, string> = {
  uploaded: "queued",
  extracting: "reading pages",
  distilling: "distilling",
  ready: "in the knowledge base",
  failed: "stalled",
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

interface DocLive {
  step?: DocStep;
  error?: string;
  /** KB topics that appeared once this document finished — the §5d summary. */
  added?: string[];
}

interface GenLive {
  jobId: string;
  step?: GenStep;
  producedIds: string[];
  error?: string;
  budgetMessage?: string;
  finished: boolean;
}

// sessionStorage, not state alone: a refresh mid-generation would otherwise
// orphan a job that is still costing money server-side.
function readStoredJob(): string | null {
  try {
    return window.sessionStorage.getItem(GEN_JOB_KEY);
  } catch {
    return null;
  }
}
function writeStoredJob(jobId: string | null) {
  try {
    if (jobId) window.sessionStorage.setItem(GEN_JOB_KEY, jobId);
    else window.sessionStorage.removeItem(GEN_JOB_KEY);
  } catch {
    /* private mode — the in-memory job still polls fine */
  }
}

function PipelineStrip() {
  const steps: Array<[string, string]> = [
    ["Upload", "a study guide, PDF · Word · Markdown"],
    ["Distil", "the app reads it into KB topics"],
    ["Generate", "topics become draft stations"],
    ["You approve", "nothing is playable until you say so"],
  ];
  return (
    <ol className={`${TILE} mb-3 flex flex-col gap-3 p-4 sm:flex-row sm:items-stretch`}>
      {steps.map(([title, body], i) => (
        <li key={title} className="flex flex-1 items-start gap-3">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-[11px] font-semibold text-neutral-400">
            {i + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-neutral-200">{title}</span>
            <span className="block text-xs text-neutral-500">{body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function LibraryClient() {
  const [docsState, setDocsState] = useState<LoadState>({ kind: "loading" });
  const [docs, setDocs] = useState<SourceDocInfo[]>([]);
  const [docLive, setDocLive] = useState<Record<string, DocLive>>({});

  const [topicsState, setTopicsState] = useState<LoadState>({ kind: "loading" });
  const [topics, setTopics] = useState<KbTopicInfo[]>([]);
  const [topicFilter, setTopicFilter] = useState("");

  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const [system, setSystem] = useState<string>("resp");
  const [count, setCount] = useState(3);
  const [commonness, setCommonness] = useState<Commonness>("common");
  const [gen, setGen] = useState<GenLive | null>(null);
  const [genError, setGenError] = useState("");
  const [starting, setStarting] = useState(false);

  const docPollsRef = useRef(new Map<string, AbortController>());
  const genPollRef = useRef<AbortController | null>(null);
  const topicsRef = useRef<KbTopicInfo[]>([]);
  const genSectionRef = useRef<HTMLDivElement | null>(null);
  const systemSelectRef = useRef<HTMLSelectElement | null>(null);

  // Abort every loop on unmount.
  useEffect(() => {
    const polls = docPollsRef.current;
    return () => {
      polls.forEach((ctl) => ctl.abort());
      polls.clear();
      genPollRef.current?.abort();
    };
  }, []);

  // Promise-chain style on purpose (same reason as the flashcards home page):
  // setState only ever runs inside async callbacks, so calling these from an
  // effect can't cascade renders.
  const loadDocs = useCallback(
    () =>
      getDocs()
        .then((list) => {
          setDocs(list);
          setDocsState({ kind: "ready" });
        })
        .catch((err: unknown) => {
          setDocsState(
            err instanceof LibraryUnavailableError
              ? { kind: "unavailable" }
              : { kind: "error", message: err instanceof Error ? err.message : String(err) },
          );
        }),
    [],
  );

  const loadTopics = useCallback(
    (): Promise<KbTopicInfo[]> =>
      getTopics()
        .then((list) => {
          topicsRef.current = list;
          setTopics(list);
          setTopicsState({ kind: "ready" });
          return list;
        })
        .catch((err: unknown) => {
          setTopicsState(
            err instanceof LibraryUnavailableError
              ? { kind: "unavailable" }
              : { kind: "error", message: err instanceof Error ? err.message : String(err) },
          );
          return topicsRef.current;
        }),
    [],
  );

  useEffect(() => {
    void loadDocs();
    void loadTopics();
  }, [loadDocs, loadTopics]);

  const startDocPolling = useCallback(
    (docId: string) => {
      if (docPollsRef.current.has(docId)) return;
      const ctl = new AbortController();
      docPollsRef.current.set(docId, ctl);
      // No setState before the first await: this is also called from an effect.
      void (async () => {
        try {
          const before = new Set(topicsRef.current.map((t) => t.slug));
          const final = await pollDocJob(docId, (step) => setDocLive((prev) => ({ ...prev, [docId]: { step } })), {
            signal: ctl.signal,
          });
          if (final?.status === "ready") {
            const [after] = await Promise.all([loadTopics(), loadDocs()]);
            const added = after.filter((t) => !before.has(t.slug)).map((t) => t.title);
            setDocLive((prev) => ({ ...prev, [docId]: { ...prev[docId], added } }));
          }
        } catch (err) {
          if (ctl.signal.aborted) return;
          const message =
            err instanceof BudgetError
              ? err.message
              : err instanceof LibraryUnavailableError
                ? "The processing endpoint isn't reachable yet — the backend may still be deploying. Retry in a moment."
                : err instanceof Error
                  ? err.message
                  : String(err);
          setDocLive((prev) => ({ ...prev, [docId]: { ...prev[docId], error: message } }));
        } finally {
          docPollsRef.current.delete(docId);
        }
      })();
    },
    [loadDocs, loadTopics],
  );

  // Anything the server says is mid-pipeline gets a loop. Idempotent per id.
  useEffect(() => {
    for (const doc of docs) {
      if (isDocProcessing(doc.status)) startDocPolling(doc.id);
    }
  }, [docs, startDocPolling]);

  const startGenPolling = useCallback(
    (jobId: string) => {
      if (genPollRef.current) return;
      const ctl = new AbortController();
      genPollRef.current = ctl;
      void (async () => {
        try {
          const final = await pollGenJob(
            jobId,
            (step) =>
              setGen((prev) => ({
                jobId,
                step,
                producedIds: step.producedIds ?? prev?.producedIds ?? [],
                finished: false,
              })),
            { signal: ctl.signal },
          );
          if (ctl.signal.aborted) return;
          if (final) {
            writeStoredJob(null);
            setGen((prev) => ({
              jobId,
              step: final,
              producedIds: final.producedIds ?? prev?.producedIds ?? [],
              finished: true,
              error: final.status === "failed" ? (final.message ?? "The run stopped early.") : undefined,
            }));
          }
        } catch (err) {
          if (ctl.signal.aborted) return;
          writeStoredJob(null);
          const budget = err instanceof BudgetError;
          setGen((prev) => ({
            jobId,
            step: prev?.step,
            producedIds: prev?.producedIds ?? [],
            finished: true,
            budgetMessage: budget ? err.message : undefined,
            error: budget
              ? undefined
              : err instanceof LibraryUnavailableError
                ? "The generation endpoint isn't reachable — the backend may still be deploying."
                : err instanceof Error
                  ? err.message
                  : String(err),
          }));
        } finally {
          genPollRef.current = null;
        }
      })();
    },
    [],
  );

  // Resume a generation job that outlived a refresh.
  useEffect(() => {
    const stored = readStoredJob();
    if (stored) {
      setGen({ jobId: stored, producedIds: [], finished: false });
      startGenPolling(stored);
    }
  }, [startGenPolling]);

  const handleFiles = useCallback(
    async (files: FileList | null | undefined) => {
      const file = files?.[0];
      if (!file || uploading) return;
      const name = file.name.toLowerCase();
      if (!ACCEPTED.some((ext) => name.endsWith(ext))) {
        setUploadError("PDF, Word (.docx) or Markdown (.md) — those are the three it can read.");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploadError("Over the 25 MB cap — split the guide and send the halves.");
        return;
      }
      setUploadError("");
      setUploading(file.name);
      try {
        const { docId } = await uploadGuide(file);
        setDocs((prev) => [
          {
            id: docId,
            filename: file.name,
            status: "uploaded",
            progress: { done: 0, total: 0 },
            createdAt: new Date().toISOString(),
          },
          ...prev.filter((d) => d.id !== docId),
        ]);
        startDocPolling(docId);
      } catch (err) {
        setUploadError(
          err instanceof LibraryUnavailableError
            ? "The upload endpoint isn't live yet — the backend is still being wired in."
            : err instanceof BudgetError
              ? err.message
              : err instanceof LibraryApiError
                ? err.message
                : "Upload failed — try that again.",
        );
      } finally {
        setUploading(null);
      }
    },
    [startDocPolling, uploading],
  );

  const startGeneration = useCallback(async () => {
    if (starting || (gen && !gen.finished)) return;
    setGenError("");
    setStarting(true);
    try {
      const { jobId } = await generateCases({ system, count, commonness });
      writeStoredJob(jobId);
      setGen({ jobId, producedIds: [], finished: false });
      startGenPolling(jobId);
    } catch (err) {
      if (err instanceof BudgetError) {
        setGen({ jobId: "", producedIds: [], finished: true, budgetMessage: err.message });
      } else {
        setGenError(
          err instanceof LibraryUnavailableError
            ? "The generator isn't live yet — the backend is still being wired in."
            : err instanceof Error
              ? err.message
              : String(err),
        );
      }
    } finally {
      setStarting(false);
    }
  }, [commonness, count, gen, starting, system, startGenPolling]);

  const focusGenerator = useCallback((forSystem: string) => {
    setSystem(forSystem);
    genSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    systemSelectRef.current?.focus();
  }, []);

  // ---------------------------------------------------------------------
  // derived

  const backendMissing = docsState.kind === "unavailable" && topicsState.kind === "unavailable";
  const filter = topicFilter.trim().toLowerCase();
  const visibleTopics = filter
    ? topics.filter((t) =>
        [t.title, t.slug, t.system, t.sourceRef ?? ""].some((field) => field.toLowerCase().includes(filter)),
      )
    : topics;
  const groupOrder = [...SYSTEMS, ...Array.from(new Set(topics.map((t) => t.system))).filter((s) => !SYSTEMS.includes(s))];
  const grouped = groupOrder
    .map((sys) => [sys, visibleTopics.filter((t) => t.system === sys)] as const)
    .filter(([, list]) => list.length > 0);
  const running = Boolean(gen && !gen.finished);
  const genStatus = gen?.step?.status;

  return (
    <div>
      <PipelineStrip />

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ---------------------------------------------------- 1. upload */}
        <section className={`${TILE} p-4`}>
          <div className="flex items-baseline justify-between gap-2">
            <h2 className={LABEL}>1 · Add a study guide</h2>
            <span className="text-xs text-neutral-600">25 MB max</span>
          </div>
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
              accept=".pdf,.md,.docx"
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
                <span className="text-sm text-neutral-200">Drop a guide here</span>
                <span className="text-xs text-neutral-500">or tap to pick · PDF, .docx or .md</span>
              </>
            )}
          </label>
          {uploadError && <p className="mt-2 text-xs text-amber-300">{uploadError}</p>}
          <p className="mt-3 text-xs text-neutral-500">
            It gets read page by page, then distilled into knowledge-base topics. Your file stays private — it is
            never handed to anyone but you.
          </p>
        </section>

        {/* ------------------------------------------------- 3. generate */}
        <section className={`${TILE} p-4`} ref={genSectionRef}>
          <div className="flex items-baseline justify-between gap-2">
            <h2 className={LABEL}>3 · Generate stations</h2>
            <span className="text-xs text-neutral-600">manual, on purpose</span>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-500">System</span>
              <select
                ref={systemSelectRef}
                value={system}
                onChange={(e) => setSystem(e.target.value)}
                className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-2 text-sm text-neutral-200 focus:border-neutral-500 focus:outline-none"
              >
                {SYSTEMS.map((s) => (
                  <option key={s} value={s}>
                    {systemLabel(s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-500">How many</span>
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-2 text-sm text-neutral-200 focus:border-neutral-500 focus:outline-none"
              >
                {[1, 2, 3, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} station{n === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="mt-3">
            <legend className="mb-1 text-xs text-neutral-500">How often you&apos;d meet it</legend>
            <div className="flex gap-2">
              {(["common", "uncommon"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={commonness === value}
                  onClick={() => setCommonness(value)}
                  className={`flex-1 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    commonness === value
                      ? "border-emerald-700 bg-emerald-950/40 text-emerald-200"
                      : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
                  }`}
                >
                  {value === "common" ? "Bread and butter" : "The odd one out"}
                </button>
              ))}
            </div>
          </fieldset>

          <button
            type="button"
            onClick={() => void startGeneration()}
            disabled={starting || running || topics.length === 0}
            className="mt-3 w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-emerald-50 transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {starting
              ? "Starting…"
              : running
                ? "Working on it…"
                : `Generate ${count} ${commonness === "common" ? "common" : "uncommon"} station${count === 1 ? "" : "s"}`}
          </button>
          <p className="mt-2 text-xs text-neutral-500">
            {topics.length === 0
              ? "Nothing to generate from yet — upload a guide first and let it distil."
              : "Costs a little API credit and lands in your review queue as drafts. It only ever runs when you press this."}
          </p>

          {genError && <p className="mt-2 text-xs text-amber-300">{genError}</p>}

          {gen && (
            <div className="mt-3" aria-live="polite">
              {!gen.finished && (
                <>
                  <ProgressBar progress={gen.step?.progress} />
                  <p className="mt-1.5 text-xs text-neutral-500">
                    {gen.step?.message ??
                      (gen.step && gen.step.progress.total > 0
                        ? `station ${gen.step.progress.done} of ${gen.step.progress.total}`
                        : genStatus === "queued"
                          ? "queued…"
                          : "writing the first station…")}
                  </p>
                </>
              )}
              {gen.budgetMessage && (
                <Notice kind="budget" title="That's the spending cap for now">
                  {gen.budgetMessage}
                  {gen.producedIds.length > 0 && " Whatever finished before the cap is still waiting in review."}
                </Notice>
              )}
              {gen.finished && gen.error && (
                <Notice kind="warning" title="The run stopped early">
                  {gen.error}
                  {gen.producedIds.length > 0 && " Anything it finished first is still in the queue."}
                </Notice>
              )}
              {gen.finished && !gen.error && !gen.budgetMessage && (
                <Notice kind="success" title={`${gen.producedIds.length || "New"} draft${gen.producedIds.length === 1 ? "" : "s"} ready`}>
                  Nothing is playable until you have read it.{" "}
                  <Link href="/review" className="font-medium underline underline-offset-4">
                    Review them now →
                  </Link>
                </Notice>
              )}
              {gen.finished && (gen.error || gen.budgetMessage) && gen.producedIds.length > 0 && (
                <p className="mt-2 text-xs">
                  <Link href="/review" className="text-neutral-400 underline underline-offset-4 hover:text-neutral-200">
                    Go to the review queue →
                  </Link>
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      {/* ------------------------------------------------- your guides */}
      <section className="mt-8">
        <h2 className={`mb-3 ${LABEL}`}>Your study guides</h2>
        {docsState.kind === "loading" ? (
          <p className="text-sm text-neutral-600">Looking for your guides…</p>
        ) : docsState.kind === "error" ? (
          <Notice kind="warning" title="Couldn't list your guides">
            {docsState.message}
          </Notice>
        ) : docs.length === 0 ? (
          <div className={`${TILE} p-6 text-center`}>
            <p className="text-sm text-neutral-300">Nothing uploaded yet.</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
              {backendMissing
                ? "Once the backend is connected, everything you upload will be tracked here while it processes."
                : "Drop your first study guide above. It reads the pages, then distils them into topics it can build stations from."}
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {docs.map((doc) => {
              const live = docLive[doc.id];
              const status = live?.step?.status ?? doc.status;
              const progress = live?.step?.progress ?? doc.progress ?? undefined;
              const message = live?.step?.message;
              const active = isDocProcessing(status) && !live?.error;
              const failure = live?.error ?? (status === "failed" ? (doc.error ?? message) : null);
              return (
                <li key={doc.id} className={`${TILE} p-3`}>
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-neutral-200">{doc.filename}</p>
                      <p className="mt-0.5 text-xs text-neutral-600">{timeAgo(doc.createdAt)}</p>
                    </div>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${DOC_TONE[status] ?? DOC_TONE.uploaded}`}>
                      {DOC_LABEL[status] ?? status}
                    </span>
                  </div>
                  {active && (
                    <div className="mt-2.5">
                      <ProgressBar progress={progress} />
                      <p className="mt-1.5 text-xs text-neutral-500" aria-live="polite">
                        {message ??
                          (progress && progress.total > 0
                            ? `step ${progress.done} of ${progress.total}`
                            : "working…")}
                      </p>
                    </div>
                  )}
                  {live?.added && live.added.length > 0 && (
                    <p className="mt-2 text-xs text-emerald-300">
                      Added to the knowledge base: {live.added.join(", ")}.
                    </p>
                  )}
                  {live?.added && live.added.length === 0 && (
                    <p className="mt-2 text-xs text-neutral-500">
                      Read and filed — it overlapped topics you already had, so nothing new was added.
                    </p>
                  )}
                  {failure && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-red-300">{failure} Your original file is untouched.</p>
                      <button
                        type="button"
                        onClick={() => {
                          setDocLive((prev) => ({ ...prev, [doc.id]: { step: prev[doc.id]?.step } }));
                          startDocPolling(doc.id);
                        }}
                        className="rounded-lg border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100"
                      >
                        Pick up where it stopped
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ----------------------------------------- 2. what it has learned */}
      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className={LABEL}>2 · What the app has learned</h2>
          <span className="text-xs tabular-nums text-neutral-600">
            {topicsState.kind === "ready" ? `${topics.length} topic${topics.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>

        {topics.length > 6 && (
          <div className={`${TILE} mb-3 flex items-center gap-2 px-3 py-2`}>
            <span aria-hidden className="text-neutral-600">
              ⌕
            </span>
            <label className="sr-only" htmlFor="kb-filter">
              Filter topics
            </label>
            <input
              id="kb-filter"
              type="search"
              value={topicFilter}
              onChange={(e) => setTopicFilter(e.target.value)}
              placeholder="Filter topics…"
              className="w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
            />
          </div>
        )}

        {topicsState.kind === "loading" ? (
          <p className="text-sm text-neutral-600">Reading the knowledge base…</p>
        ) : topicsState.kind === "unavailable" ? (
          <div className={`${TILE} p-6 text-center`}>
            <p className="text-sm text-neutral-200">The knowledge base isn&apos;t connected yet.</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-neutral-500">
              The backend is still being wired in. Once it lands, every topic distilled from your guides shows up
              here with the pages it came from.
            </p>
          </div>
        ) : topicsState.kind === "error" ? (
          <Notice kind="warning" title="Couldn't read the knowledge base">
            {topicsState.message}
          </Notice>
        ) : topics.length === 0 ? (
          <div className={`${TILE} p-6 text-center`}>
            <p className="text-sm text-neutral-300">Empty for now.</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
              Everything a station knows comes from here — upload a guide and watch the topics appear.
            </p>
          </div>
        ) : grouped.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing matches “{topicFilter}”.</p>
        ) : (
          <div className="space-y-5">
            {grouped.map(([sys, list]) => (
              <div key={sys}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-neutral-300">
                    {systemLabel(sys)}{" "}
                    <span className="text-xs tabular-nums text-neutral-600">
                      · {list.length} topic{list.length === 1 ? "" : "s"}
                    </span>
                  </h3>
                  {SYSTEMS.includes(sys) && (
                    <button
                      type="button"
                      onClick={() => focusGenerator(sys)}
                      className="rounded-lg border border-neutral-800 px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
                    >
                      Make stations from this
                    </button>
                  )}
                </div>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {list.map((t) => (
                    <li key={t.slug} className={`${TILE} p-3`}>
                      <p className="text-sm text-neutral-100">{t.title}</p>
                      <p className="mt-1 text-xs text-neutral-500">
                        {t.sourceRef ? (
                          <>From {t.sourceRef}</>
                        ) : (
                          <span className="text-neutral-600">Source not recorded</span>
                        )}
                      </p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-neutral-600">
                        <Chip>{t.slug}</Chip>
                        {t.tokenCount > 0 && <span className="tabular-nums">≈{t.tokenCount.toLocaleString()} tokens</span>}
                        {t.updatedAt && <span>· {timeAgo(t.updatedAt)}</span>}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
