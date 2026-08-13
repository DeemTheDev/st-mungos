"use client";

// Examiner bubble (CLAUDE.md §8): a corner monogram avatar that animates while
// the examiner is talking and captions the line she is hearing.
//
// It is driven by whatever the station hands it, so it behaves identically in
// both modes: in voice mode that is the TTS SpeakingEvent stream, in text-only
// mode it is a short cue the station raises when a new examiner line lands.
// Left corner on purpose — the HUD's quit/voice controls own the right one.

import type { VoiceRole } from "@/lib/ports";

export interface ExaminerBubbleProps {
  /** The line currently being spoken/shown, or null when nobody is talking. */
  speaking: { role: VoiceRole; text: string } | null;
}

export function ExaminerBubble({ speaking }: ExaminerBubbleProps) {
  const active = speaking?.role === "examiner";

  return (
    <div className="no-print pointer-events-none fixed left-3 top-[4.5rem] z-20 flex max-w-[min(22rem,calc(100vw-1.5rem))] items-start gap-2 sm:left-4 sm:top-20">
      <div className="relative shrink-0">
        {active && (
          <span className="absolute inset-0 animate-ping rounded-full bg-amber-500/30" aria-hidden />
        )}
        <span
          className={`relative flex h-11 w-11 items-center justify-center rounded-full border text-xs font-semibold tracking-widest transition-colors duration-300 ${
            active
              ? "border-amber-400 bg-amber-950 text-amber-200 shadow-[0_0_18px_-2px_rgba(245,158,11,0.7)]"
              : "border-neutral-700 bg-neutral-900/80 text-neutral-500"
          }`}
          title="Examiner"
        >
          EX
        </span>
      </div>

      <div aria-live="polite" className="min-w-0">
        <p
          className={`text-[10px] font-semibold uppercase tracking-widest transition-colors duration-300 ${
            active ? "text-amber-400" : "text-neutral-600"
          }`}
        >
          Examiner
        </p>
        {active && speaking && (
          <p className="mt-1 max-h-32 overflow-hidden rounded border border-amber-900/70 bg-neutral-950/85 px-2.5 py-1.5 text-xs italic leading-relaxed text-amber-200 backdrop-blur-sm">
            {speaking.text}
          </p>
        )}
      </div>
    </div>
  );
}
