"use client";

// The examiner (CLAUDE.md §8): a monogram presence that animates while he is
// talking and captions the line she is hearing.
//
// It used to pin itself `fixed` to the viewport, which left a circle floating
// over whatever happened to be underneath. It now has a real home — its own
// bento tile beside the patient — so it reads as the second person in the room
// rather than a stray badge. Positioning is still the CALLER's job.
//
// It is driven by whatever the station hands it, so it behaves identically in
// both modes: in voice mode that is the TTS SpeakingEvent stream, in text-only
// mode it is a short cue the station raises when a new examiner line lands.

import type { VoiceRole } from "@/lib/ports";

// It shrinks to a single row below `lg` rather than switching component
// variants: a phone's vertical budget belongs to the transcript, and a prop that
// only ever tracks a breakpoint is a prop that goes stale.

export interface ExaminerBubbleProps {
  /** The line currently being spoken/shown, or null when nobody is talking. */
  speaking: { role: VoiceRole; text: string } | null;
  className?: string;
}

export function ExaminerBubble({ speaking, className = "" }: ExaminerBubbleProps) {
  const active = speaking?.role === "examiner";

  return (
    <section
      aria-label="Examiner"
      className={`no-print flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2 transition-colors duration-300 lg:items-start lg:py-2.5 ${
        active ? "border-amber-700/50 bg-amber-950/25" : "border-neutral-800/60 bg-neutral-900/40"
      } ${className}`}
    >
      <div className="relative shrink-0">
        {active && <span className="absolute inset-0 animate-ping rounded-full bg-amber-500/25" aria-hidden />}
        <span
          className={`relative flex h-9 w-9 items-center justify-center rounded-full border text-[11px] font-semibold tracking-widest transition-colors duration-300 ${
            active
              ? "border-amber-400/70 bg-amber-950 text-amber-200 shadow-[0_0_20px_-4px_rgba(245,158,11,0.7)]"
              : "border-neutral-700/70 bg-neutral-900/80 text-neutral-500"
          }`}
        >
          EX
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-neutral-500">
          <span className={active ? "text-amber-400" : "text-neutral-400"}>Examiner</span>
          <span aria-hidden className="text-neutral-700">·</span>
          <span className={active ? "text-amber-500" : ""}>{active ? "speaking" : "observing"}</span>
        </p>
        {/* aria-live sits on a wrapper that is always mounted — announcing from
            a node that mounts with the text would re-announce on every render. */}
        <div aria-live="polite" className="min-w-0">
          {active && speaking ? (
            <p className="mt-1 truncate text-xs italic leading-relaxed text-amber-200 lg:mt-1.5 lg:max-h-28 lg:overflow-y-auto lg:whitespace-normal">
              {speaking.text}
            </p>
          ) : (
            <p className="mt-1.5 hidden text-xs leading-relaxed text-neutral-600 lg:block">
              He interrupts when he wants your reasoning. Address him directly to present.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
