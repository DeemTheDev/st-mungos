"use client";

// The patient's nameplate — the counterpart to the examiner card.
//
// It used to be an unlabelled chip that appeared between the transcript and the
// input only while the patient was talking, which read as a stray circle
// floating in the corner. It is now a deliberate, permanent plate that captions
// the figure it belongs to: overlaid on the patient tile, or sitting inside the
// tile's fallback card when there is no canvas to overlay.
//
// Positioning is the CALLER's job — this only ever lays out its own two columns.

export interface PatientPlateProps {
  name: string;
  /** e.g. "54F" — the identity line an OSCE station always states up front. */
  detail?: string | null;
  speaking: boolean;
  /** The line she is hearing right now, if any. */
  line?: string | null;
  /** "plate" overlays the canvas; "card" is the larger centred fallback form. */
  variant?: "plate" | "card";
  className?: string;
}

export function PatientPlate({
  name,
  detail,
  speaking,
  line,
  variant = "plate",
  className = "",
}: PatientPlateProps) {
  const card = variant === "card";
  const initial = name.trim().slice(0, 1).toUpperCase() || "P";

  return (
    <div
      className={`no-print flex min-w-0 ${card ? "flex-col items-center text-center" : "items-center"} gap-2.5 ${className}`}
    >
      <span
        className={`relative flex shrink-0 items-center justify-center rounded-full border font-semibold transition-colors duration-300 ${
          card ? "h-20 w-20 text-2xl" : "h-9 w-9 text-xs"
        } ${
          speaking
            ? "border-sky-400/70 bg-sky-950 text-sky-200 shadow-[0_0_20px_-4px_rgba(56,189,248,0.7)]"
            : "border-neutral-700/70 bg-neutral-900/80 text-neutral-400"
        }`}
        title={detail ? `${name}, ${detail}` : name}
      >
        {speaking && <span className="absolute inset-0 animate-ping rounded-full bg-sky-500/20" aria-hidden />}
        <span className="relative">{initial}</span>
      </span>

      <div className={`min-w-0 ${card ? "" : "flex-1"}`}>
        <p className="truncate text-[11px] font-semibold tracking-wide text-neutral-200">{name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-neutral-500">
          {detail && <span className="tabular-nums">{detail}</span>}
          {detail && <span aria-hidden className="text-neutral-700">·</span>}
          <span className={speaking ? "text-sky-400" : ""}>{speaking ? "speaking" : "patient"}</span>
        </p>
        {card && line && speaking && (
          <p className="mx-auto mt-3 max-w-xs text-xs leading-relaxed text-neutral-300">{line}</p>
        )}
      </div>
    </div>
  );
}
