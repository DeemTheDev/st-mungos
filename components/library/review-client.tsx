"use client";

// /review — the clinical safety gate, built for HER rather than for an admin.
//
// Two panes: a skimmable queue (what's waiting, which system, common or not)
// and the case itself, read top to bottom, ending in a sticky decision bar.
// At <1024px the queue and the case swap places instead of squeezing together —
// a 375px screen has room for one of them, and reading the case is the job.
//
// Approve is the moment a case becomes playable, so it takes two taps and says
// so; reject takes one (it just doesn't get dealt to her). Both accept a note,
// because "why did I bin this" is the useful half of a review.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BudgetError,
  LibraryUnavailableError,
  getCase,
  getCases,
  reviewCase,
  systemLabel,
  timeAgo,
  type CaseDetail,
  type CaseSummaryInfo,
  type ReviewAction,
} from "./api";
import { CaseBody, CaseHeadline } from "./case-detail";
import { Chip, LABEL, Notice, TILE } from "./ui";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

type DetailState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; detail: CaseDetail }
  | { kind: "error"; message: string };

interface Verdict {
  action: ReviewAction;
  diagnosis: string;
}

function QueueRow({
  summary,
  selected,
  onSelect,
}: {
  summary: CaseSummaryInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={`w-full rounded-xl border p-3 text-left transition-colors ${
          selected
            ? "border-emerald-800/70 bg-emerald-950/20"
            : "border-neutral-800/60 bg-neutral-900/40 hover:border-neutral-700 hover:bg-neutral-900/70"
        }`}
      >
        <p className="text-sm font-medium text-neutral-100">{summary.diagnosis}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Chip>{systemLabel(summary.discipline)}</Chip>
          {summary.commonness === "uncommon" && <Chip tone="amber">uncommon</Chip>}
          {summary.stationType === "interpretation" && <Chip tone="sky">interpretation</Chip>}
        </p>
        <p className="mt-1.5 truncate text-xs text-neutral-600">
          {summary.kbSource ? `from ${summary.kbSource}` : "source not recorded"}
          {summary.createdAt && ` · ${timeAgo(summary.createdAt)}`}
        </p>
      </button>
    </li>
  );
}

export function ReviewClient() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [drafts, setDrafts] = useState<CaseSummaryInfo[]>([]);
  const [bankCount, setBankCount] = useState<number | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: "idle" });

  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState<ReviewAction | null>(null);
  const [actionError, setActionError] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  const [systemFilter, setSystemFilter] = useState("");

  const cacheRef = useRef(new Map<string, CaseDetail>());
  const detailFetchRef = useRef<AbortController | null>(null);
  const detailTopRef = useRef<HTMLDivElement | null>(null);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setNote("");
    setNoteOpen(false);
    setConfirming(false);
    setActionError("");
    const cached = cacheRef.current.get(id);
    if (cached) {
      setDetail({ kind: "ready", detail: cached });
      return;
    }
    setDetail({ kind: "loading" });
    detailFetchRef.current?.abort();
    const ctl = new AbortController();
    detailFetchRef.current = ctl;
    getCase(id, ctl.signal)
      .then((full) => {
        cacheRef.current.set(id, full);
        setDetail({ kind: "ready", detail: full });
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setDetail({
          kind: "error",
          message:
            err instanceof LibraryUnavailableError
              ? "That case couldn't be fetched — the backend may still be deploying."
              : err instanceof Error
                ? err.message
                : String(err),
        });
      });
  }, []);

  // The initial load. Promise-chain style, like the flashcards home page: every
  // setState runs inside an async callback, so nothing here cascades renders.
  useEffect(() => {
    const ctl = new AbortController();
    getCases("draft", ctl.signal)
      .then((list) => {
        setDrafts(list);
        setState({ kind: "ready" });
        // On a wide screen the queue and the case sit side by side, so opening
        // the first one costs nothing. On a phone it would hide the queue she
        // just asked for, so there it stays closed until she picks.
        if (list.length > 0 && window.matchMedia("(min-width: 1024px)").matches) {
          select(list[0].id);
        }
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setState(
          err instanceof LibraryUnavailableError
            ? { kind: "unavailable" }
            : { kind: "error", message: err instanceof Error ? err.message : String(err) },
        );
      });
    // Context, not critical: how many are already playable.
    getCases("bank", ctl.signal)
      .then((list) => setBankCount(list.length))
      .catch(() => {
        /* the queue works without it */
      });
    return () => {
      ctl.abort();
      detailFetchRef.current?.abort();
    };
  }, [select]);

  const submit = useCallback(
    async (action: ReviewAction) => {
      if (!selectedId || submitting) return;
      setSubmitting(action);
      setActionError("");
      const current = drafts.find((d) => d.id === selectedId);
      try {
        await reviewCase(selectedId, action, note.trim() || undefined);
        cacheRef.current.delete(selectedId);
        const remaining = drafts.filter((d) => d.id !== selectedId);
        setDrafts(remaining);
        if (action === "approve") setBankCount((prev) => (prev == null ? prev : prev + 1));
        setVerdict({ action, diagnosis: current?.diagnosis ?? "That case" });
        setNote("");
        setNoteOpen(false);
        setConfirming(false);
        const next = remaining[0];
        if (next) {
          select(next.id);
          detailTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          setSelectedId(null);
          setDetail({ kind: "idle" });
        }
      } catch (err) {
        setActionError(
          err instanceof BudgetError
            ? err.message
            : err instanceof LibraryUnavailableError
              ? "The review endpoint isn't reachable — nothing was changed."
              : err instanceof Error
                ? err.message
                : String(err),
        );
      } finally {
        setSubmitting(null);
      }
    },
    [drafts, note, select, selectedId, submitting],
  );

  // -----------------------------------------------------------------------

  const systemsPresent = Array.from(new Set(drafts.map((d) => d.discipline))).sort();
  const visible = systemFilter ? drafts.filter((d) => d.discipline === systemFilter) : drafts;
  const showQueueOnMobile = !selectedId;

  if (state.kind === "loading") {
    return <p className="text-sm text-neutral-600">Opening the queue…</p>;
  }

  if (state.kind === "unavailable") {
    return (
      <div className={`${TILE} p-8 text-center`}>
        <p className="text-sm text-neutral-200">The case library isn&apos;t connected yet.</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
          The backend is still being wired in. Once it lands, every station generated in the{" "}
          <Link href="/library" className="underline underline-offset-4 hover:text-neutral-300">
            library
          </Link>{" "}
          waits here for you before anyone can be examined on it.
        </p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <Notice kind="warning" title="Couldn't open the queue">
        {state.message}
      </Notice>
    );
  }

  return (
    <div>
      {verdict && (
        <div className="mb-3" aria-live="polite">
          <Notice
            kind={verdict.action === "approve" ? "success" : "info"}
            title={verdict.action === "approve" ? "In the bank" : "Left out of the bank"}
          >
            {verdict.action === "approve" ? (
              <>
                “{verdict.diagnosis}” can be dealt to you now.{" "}
                <Link href="/session" className="font-medium underline underline-offset-4">
                  Practise a station →
                </Link>
              </>
            ) : (
              <>“{verdict.diagnosis}” won&apos;t be dealt to you. Nothing else changed.</>
            )}
          </Notice>
        </div>
      )}

      <div className="lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:items-start lg:gap-4">
        {/* --------------------------------------------------------- queue */}
        <div className={`${showQueueOnMobile ? "block" : "hidden lg:block"} lg:sticky lg:top-4`}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className={LABEL}>Waiting on you</h2>
            <span className="text-xs tabular-nums text-neutral-500">
              {drafts.length} draft{drafts.length === 1 ? "" : "s"}
              {bankCount != null && ` · ${bankCount} playable`}
            </span>
          </div>

          {systemsPresent.length > 1 && (
            <label className="mb-2 block">
              <span className="sr-only">Filter the queue by system</span>
              <select
                value={systemFilter}
                onChange={(e) => setSystemFilter(e.target.value)}
                className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-300 focus:border-neutral-500 focus:outline-none"
              >
                <option value="">All systems ({drafts.length})</option>
                {systemsPresent.map((s) => (
                  <option key={s} value={s}>
                    {systemLabel(s)} ({drafts.filter((d) => d.discipline === s).length})
                  </option>
                ))}
              </select>
            </label>
          )}

          {drafts.length === 0 ? (
            <div className={`${TILE} p-6 text-center`}>
              <p className="text-sm text-neutral-200">Queue&apos;s clear.</p>
              <p className="mt-1 text-sm text-neutral-500">
                Nothing is waiting on you. Make more in the{" "}
                <Link href="/library" className="underline underline-offset-4 hover:text-neutral-300">
                  library
                </Link>
                , or go and{" "}
                <Link href="/session" className="underline underline-offset-4 hover:text-neutral-300">
                  take a station
                </Link>
                .
              </p>
            </div>
          ) : visible.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing waiting in that system.</p>
          ) : (
            <ul className="space-y-2 lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto lg:pr-1">
              {visible.map((summary) => (
                <QueueRow
                  key={summary.id}
                  summary={summary}
                  selected={summary.id === selectedId}
                  onSelect={() => select(summary.id)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* -------------------------------------------------------- detail */}
        <div className={`${showQueueOnMobile ? "hidden lg:block" : "block"} mt-4 lg:mt-0`} ref={detailTopRef}>
          {detail.kind === "idle" && drafts.length > 0 && (
            <div className={`${TILE} hidden p-8 text-center lg:block`}>
              <p className="text-sm text-neutral-400">Pick a case on the left to read it through.</p>
            </div>
          )}

          {detail.kind === "loading" && <p className="text-sm text-neutral-600">Fetching the case…</p>}

          {detail.kind === "error" && (
            <Notice kind="warning" title="Couldn't open that case">
              {detail.message}
            </Notice>
          )}

          {detail.kind === "ready" && (
            <>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(null);
                  setDetail({ kind: "idle" });
                }}
                className="mb-3 rounded-lg border border-neutral-800 px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200 lg:hidden"
              >
                ← Back to the queue
              </button>

              <div className={`${TILE} p-4 sm:p-5`}>
                <CaseHeadline
                  diagnosis={detail.detail.diagnosis}
                  stationType={detail.detail.stationType}
                  discipline={detail.detail.discipline}
                  commonness={detail.detail.commonness}
                  difficulty={detail.detail.difficulty}
                />
                <dl className="mt-3 space-y-1 text-xs text-neutral-500">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-neutral-600">Written from</dt>
                    <dd className="text-neutral-400">
                      {detail.detail.kbSource ? (
                        detail.detail.kbSource
                      ) : (
                        <span className="text-amber-300/80">
                          no source topic recorded — read it twice as carefully
                        </span>
                      )}
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-neutral-600">Drafted</dt>
                    <dd className="text-neutral-400">{timeAgo(detail.detail.createdAt) || "just now"}</dd>
                  </div>
                </dl>
                <p className="mt-3 border-t border-neutral-800/70 pt-3 text-sm text-neutral-400">
                  A machine wrote this from your notes. Read it as if a colleague handed it to you — if anything is
                  wrong, out of date for KZN, or unfair to mark someone on, send it back.
                </p>
              </div>

              <div className="mt-3">
                <CaseBody osceCase={detail.detail.data} />
              </div>

              {/* decision bar — sticky so it is always one tap away */}
              <div className="sticky bottom-0 z-10 mt-3 rounded-xl border border-neutral-800 bg-neutral-950/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/80">
                {actionError && <p className="mb-2 text-xs text-amber-300">{actionError}</p>}

                {noteOpen && (
                  <div className="mb-2">
                    <label className="sr-only" htmlFor="review-note">
                      Note about this case
                    </label>
                    <textarea
                      id="review-note"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={2}
                      placeholder="What's wrong with it, or what made it good…"
                      className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
                    />
                  </div>
                )}

                {confirming ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="w-full text-sm text-neutral-300 sm:w-auto sm:flex-1">
                      This puts it in the bank — you can be examined on it from then on.
                    </p>
                    <button
                      type="button"
                      onClick={() => void submit("approve")}
                      disabled={submitting !== null}
                      className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 transition-colors hover:bg-emerald-600 disabled:opacity-60"
                    >
                      {submitting === "approve" ? "Approving…" : "Yes, approve it"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      disabled={submitting !== null}
                      className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100"
                    >
                      Not yet
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirming(true)}
                      disabled={submitting !== null}
                      className="flex-1 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 transition-colors hover:bg-emerald-600 disabled:opacity-60 sm:flex-none"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void submit("reject")}
                      disabled={submitting !== null}
                      className="flex-1 rounded-lg border border-red-900 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-950/60 disabled:opacity-60 sm:flex-none"
                    >
                      {submitting === "reject" ? "Sending back…" : "Reject"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setNoteOpen((open) => !open)}
                      aria-expanded={noteOpen}
                      className="rounded-lg border border-neutral-800 px-3 py-2 text-sm text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
                    >
                      {noteOpen ? "Hide note" : note ? "Note added" : "Add a note"}
                    </button>
                    <span className="ml-auto hidden text-xs text-neutral-600 sm:inline">
                      Approving makes it playable.
                    </span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
