// Shared atoms for /library and /review. Deliberately tiny and dependency-free:
// same tokens the flashcards bento and the station already use (one radius
// scale, border-neutral-800/60 tiles, emerald = go, amber = caution, sky =
// information, red = stop), so the two new pages read as the same app.
import type { ReactNode } from "react";

export const TILE = "rounded-xl border border-neutral-800/60 bg-neutral-900/40";
export const LABEL = "text-xs font-semibold tracking-widest text-neutral-500 uppercase";

export type Tone = "neutral" | "amber" | "sky" | "emerald" | "red";

const CHIP_TONES: Record<Tone, string> = {
  neutral: "bg-neutral-800 text-neutral-300",
  amber: "bg-amber-950 text-amber-300",
  sky: "bg-sky-950 text-sky-300",
  emerald: "bg-emerald-950 text-emerald-300",
  red: "bg-red-950 text-red-300",
};

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${CHIP_TONES[tone]}`}>{children}</span>;
}

export function ProgressBar({ progress }: { progress?: { done: number; total: number } | null }) {
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
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.min(done, total)}
    >
      <div className="h-full rounded-full bg-emerald-600 transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * A message that is NOT a crash. `budget` is the HTTP 402 case — the pipeline
 * stopped itself on purpose, so it must read like a receipt, not an incident.
 */
export function Notice({
  kind,
  title,
  children,
}: {
  kind: "budget" | "warning" | "info" | "success";
  title?: string;
  children: ReactNode;
}) {
  const styles = {
    budget: "border-amber-900/60 bg-amber-950/25 text-amber-200",
    warning: "border-amber-900/60 bg-amber-950/25 text-amber-200",
    info: "border-sky-900/60 bg-sky-950/25 text-sky-200",
    success: "border-emerald-900/60 bg-emerald-950/25 text-emerald-200",
  } as const;
  return (
    <div className={`rounded-lg border p-3 text-sm ${styles[kind]}`}>
      {title && <p className="font-medium">{title}</p>}
      <div className={title ? "mt-1 opacity-90" : "opacity-90"}>{children}</div>
    </div>
  );
}
