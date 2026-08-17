"use client";

// The review player — where she actually lives during study. One card centred,
// tap (or Space) to reveal, four grade buttons (keyboard 1–4), advance
// immediately. Phone-first: the grade bar sits at the thumb end of the screen,
// targets are ≥56px tall, and nothing depends on hover. The reveal is a fast
// (~180ms total) perspective flip — swap at 90° so variable card heights never
// show a mirrored back face — and prefers-reduced-motion swaps instantly.
//
// Retrieval practice rule (docs/FLASHCARDS.md §5): the answer is NEVER visible
// until she commits — reveal is an explicit act, then she grades herself.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  FlashcardsUnavailableError,
  formatPages,
  reviewGrade,
  reviewNext,
  reviewReveal,
  type ReviewCard,
  type ReviewGrade,
} from "./api";
import { QuestionBody } from "./question-body";

const TILE = "rounded-xl border border-neutral-800/60 bg-neutral-900/40";

type Phase =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "question"; card: ReviewCard; remaining: number }
  | { kind: "revealed"; card: ReviewCard; remaining: number; answer: string; sourcePages: number[] }
  | { kind: "complete" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

const GRADES: Array<{ grade: ReviewGrade; label: string; hint: string; cls: string }> = [
  {
    grade: "again",
    label: "Again",
    hint: "1",
    cls: "border border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800",
  },
  {
    grade: "hard",
    label: "Hard",
    hint: "2",
    cls: "border border-neutral-600 bg-neutral-800 text-neutral-100 hover:bg-neutral-700",
  },
  {
    grade: "good",
    label: "Good",
    hint: "3",
    cls: "border border-emerald-900 bg-emerald-950 text-emerald-200 hover:bg-emerald-900",
  },
  {
    grade: "easy",
    label: "Easy",
    hint: "4",
    cls: "border border-emerald-600 bg-emerald-700 text-emerald-50 hover:bg-emerald-600",
  },
];

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True when the key event landed in a typing control. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(
    el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable),
  );
}

export function ReviewClient({ topic }: { topic: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [reviewed, setReviewed] = useState(0);
  const [againCount, setAgainCount] = useState(0);
  const [busy, setBusy] = useState(false); // a reveal or grade round-trip is in flight
  const [flipping, setFlipping] = useState(false);

  // Mirrors `reviewed` for use inside loadNext without re-creating the
  // callback per card. Maintained in grade()/restart() — never during render.
  const reviewedRef = useRef(0);
  const flipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (flipTimer.current) clearTimeout(flipTimer.current);
  }, []);

  /** Swap card content mid-flip: rotate to 90°, swap, rotate back. */
  const swapWithFlip = useCallback((apply: () => void) => {
    if (prefersReducedMotion()) {
      apply();
      return;
    }
    setFlipping(true);
    flipTimer.current = setTimeout(() => {
      apply();
      setFlipping(false);
    }, 90);
  }, []);

  const loadNext = useCallback(
    async (opts: { flip: boolean }) => {
      try {
        const next = await reviewNext(topic ?? undefined);
        const apply = () => {
          if (!next.card) {
            setPhase(reviewedRef.current > 0 ? { kind: "complete" } : { kind: "empty" });
          } else {
            setPhase({ kind: "question", card: next.card, remaining: Math.max(next.remaining, 1) });
          }
        };
        if (opts.flip) swapWithFlip(apply);
        else apply();
      } catch (err) {
        if (err instanceof FlashcardsUnavailableError) setPhase({ kind: "unavailable" });
        else setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    },
    [swapWithFlip, topic],
  );

  useEffect(() => {
    void loadNext({ flip: false });
  }, [loadNext]);

  const reveal = useCallback(async () => {
    if (phase.kind !== "question" || busy) return;
    setBusy(true);
    try {
      const { answer, sourcePages } = await reviewReveal(phase.card.id);
      swapWithFlip(() =>
        setPhase({ kind: "revealed", card: phase.card, remaining: phase.remaining, answer, sourcePages }),
      );
    } catch (err) {
      if (err instanceof FlashcardsUnavailableError) setPhase({ kind: "unavailable" });
      else setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [busy, phase, swapWithFlip]);

  const grade = useCallback(
    async (g: ReviewGrade) => {
      if (phase.kind !== "revealed" || busy) return;
      setBusy(true);
      try {
        await reviewGrade(phase.card.id, g);
        setReviewed((n) => n + 1);
        reviewedRef.current += 1;
        if (g === "again") setAgainCount((n) => n + 1);
        await loadNext({ flip: true });
      } catch (err) {
        if (err instanceof FlashcardsUnavailableError) setPhase({ kind: "unavailable" });
        else setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(false);
      }
    },
    [busy, loadNext, phase],
  );

  // Space reveals, 1–4 grade. Never while typing in a control.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.key === " " && phase.kind === "question") {
        e.preventDefault();
        void reveal();
        return;
      }
      if (phase.kind === "revealed") {
        const idx = ["1", "2", "3", "4"].indexOf(e.key);
        if (idx >= 0) {
          e.preventDefault();
          void grade(GRADES[idx].grade);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grade, phase.kind, reveal]);

  const restart = useCallback(() => {
    setReviewed(0);
    setAgainCount(0);
    reviewedRef.current = 0;
    setPhase({ kind: "loading" });
    void loadNext({ flip: false });
  }, [loadNext]);

  // ------------------------------------------------------------------ render

  const cardShown = phase.kind === "question" || phase.kind === "revealed";
  const remaining = cardShown ? phase.remaining : 0;
  const total = reviewed + remaining;
  const pages = phase.kind === "revealed" ? formatPages(phase.sourcePages) : null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {/* header line: progress + topic + exit */}
      <div className="flex items-center justify-between gap-3 text-sm">
        <p className="tabular-nums text-neutral-400" aria-live="polite">
          {cardShown ? (
            <>
              {reviewed + 1} of {total} due
            </>
          ) : (
            " "
          )}
        </p>
        <div className="flex items-center gap-2">
          {topic && (
            <span className="max-w-40 truncate rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-300">
              {topic}
            </span>
          )}
          <Link
            href="/flashcards"
            className="rounded-lg border border-neutral-800 px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
          >
            Exit
          </Link>
        </div>
      </div>

      {/* thin progress bar */}
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-neutral-800/80">
        <div
          className="h-full rounded-full bg-emerald-700 transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: total > 0 ? `${Math.round((reviewed / total) * 100)}%` : "0%" }}
        />
      </div>

      {/* the card */}
      <div className="flex flex-1 flex-col justify-center py-6">
        {phase.kind === "loading" && (
          <div className={`${TILE} p-8 text-center text-sm text-neutral-500`}>Shuffling the deck…</div>
        )}

        {phase.kind === "unavailable" && (
          <div className={`${TILE} p-8 text-center`}>
            <p className="text-sm text-neutral-200">The flashcard engine isn&apos;t connected yet.</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-neutral-500">
              The backend is still being wired in — once it lands, your due cards will be waiting right here.
            </p>
            <Link
              href="/flashcards"
              className="mt-5 inline-block rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-900"
            >
              Back to flashcards
            </Link>
          </div>
        )}

        {phase.kind === "error" && (
          <div className={`${TILE} p-8 text-center`}>
            <p className="text-sm text-amber-300">Something went sideways: {phase.message}</p>
            <button
              type="button"
              onClick={restart}
              className="mt-5 rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-900"
            >
              Try again
            </button>
          </div>
        )}

        {phase.kind === "empty" && (
          <div className={`${TILE} p-8 text-center`}>
            <p className="text-base text-neutral-100">Nothing due{topic ? ` in “${topic}”` : ""} 🎉</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-neutral-500">
              Add documents or come back tomorrow — the scheduler resurfaces each card exactly when
              forgetting is about to win.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/flashcards"
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 transition-colors hover:bg-emerald-600"
              >
                Back to flashcards
              </Link>
              {topic && (
                <Link
                  href="/flashcards/review"
                  className="text-sm text-neutral-500 underline-offset-4 hover:text-neutral-300 hover:underline"
                >
                  Review every topic instead
                </Link>
              )}
            </div>
          </div>
        )}

        {phase.kind === "complete" && (
          <div className={`${TILE} p-8 text-center`}>
            <p className="text-xs font-semibold tracking-widest text-emerald-400 uppercase">Session complete</p>
            <p className="mt-3 text-3xl font-semibold tabular-nums text-neutral-100">{reviewed}</p>
            <p className="mt-1 text-sm text-neutral-400">
              card{reviewed === 1 ? "" : "s"} reviewed
              {againCount > 0 ? ` · ${againCount} marked “again” — they'll be back soon` : " · nothing tripped you up"}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/flashcards"
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 transition-colors hover:bg-emerald-600"
              >
                Back
              </Link>
              <button
                type="button"
                onClick={restart}
                className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-900"
              >
                Check for more
              </button>
            </div>
          </div>
        )}

        {cardShown && (
          <div
            className={`transition-transform duration-100 ease-in motion-reduce:transition-none ${
              flipping ? "[transform:perspective(1200px)rotateY(90deg)]" : "[transform:perspective(1200px)rotateY(0deg)]"
            }`}
          >
            {phase.kind === "question" ? (
              <button
                type="button"
                onClick={() => void reveal()}
                disabled={busy}
                className={`${TILE} block w-full p-5 text-left transition-colors hover:border-neutral-700 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:outline-none sm:p-8 ${
                  busy ? "opacity-70" : ""
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-300">
                    {phase.card.topic}
                  </span>
                </div>
                <div className="mt-4">
                  <QuestionBody question={phase.card.question} />
                </div>
                <p className="mt-6 text-center text-xs text-neutral-600">
                  {busy ? "revealing…" : "tap to reveal · Space"}
                </p>
              </button>
            ) : (
              <div className={`${TILE} p-5 sm:p-8`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-300">
                    {phase.card.topic}
                  </span>
                  {pages && (
                    <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-400">{pages}</span>
                  )}
                </div>
                <div className="mt-4">
                  <QuestionBody question={phase.card.question} compact />
                </div>
                <hr className="my-4 border-neutral-800" />
                <div aria-live="polite">
                  <p className="text-xs font-semibold tracking-widest text-emerald-400 uppercase">Answer</p>
                  <p className="mt-2 text-base whitespace-pre-wrap text-neutral-100 sm:text-lg">
                    {phase.answer || "(no answer text — check the source pages)"}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* footer: grade bar (revealed) or hint (question) — fixed-height area so
          nothing jumps under her thumb */}
      <div className="min-h-16">
        {phase.kind === "revealed" && (
          <div className="grid grid-cols-4 gap-2">
            {GRADES.map((g) => (
              <button
                key={g.grade}
                type="button"
                onClick={() => void grade(g.grade)}
                disabled={busy}
                className={`min-h-14 rounded-lg px-1 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none disabled:opacity-50 ${g.cls}`}
              >
                <span className="block">{g.label}</span>
                <span className="mt-0.5 hidden text-[10px] opacity-50 sm:block">{g.hint}</span>
              </button>
            ))}
          </div>
        )}
        {phase.kind === "question" && (
          <p className="pt-4 text-center text-xs text-neutral-700">grade yourself after the reveal — Again · Hard · Good · Easy</p>
        )}
      </div>
    </main>
  );
}
