"use client";

// The patient tile — one bento cell of the station (CLAUDE.md §8).
//
// The figure is the ONLY 3D thing in it. Everything behind him is CSS: a soft
// studio wash, a barely-there grid, a floor pool and a vignette. That is a
// deliberate trade — the old version modelled a wall, a floor, a bed, a cabinet
// and a drip stand in three.js, which cost draw calls, boxed the camera in, and
// still looked like grey blocks. A gradient reads better and costs nothing.
//
// The tile must NEVER be an empty black rectangle. There are exactly three
// states and all of them are composed:
//   · canvas live      — the portrait, plus the nameplate and view controls;
//   · canvas loading   — the same background with a quiet status line;
//   · no canvas        — 3D switched off, WebGL missing, or the model failed to
//                        load: a monogram card carrying the patient's details,
//                        which is the information the station actually needs.
//
// Pointer events are scoped tightly: the canvas takes drags (that is how the
// orbit works), the nameplate is inert, and only the controls sit above it as
// real buttons. Nothing here is `fixed`, so the transcript, composer, HUD and
// overlays elsewhere in the grid are untouched.

import { useCallback, useState } from "react";
import { PatientPlate } from "./patient-plate";
import { WardStage, type ModelStatus } from "./ward-stage";

export interface PatientTileProps {
  name: string;
  /** e.g. "54F". */
  detail: string | null;
  speaking: boolean;
  /** The patient line playing right now, if any. */
  line: string | null;
  /** The 3D preference — false means she turned it off, or it is unsupported. */
  enabled: boolean;
  reducedMotion: boolean;
  className?: string;
}

/** Reason copy for the fallback card — never a bare empty state. */
function fallbackNote(enabled: boolean, status: ModelStatus): string {
  if (status === "failed") return "3D patient unavailable — the station is unaffected.";
  return enabled ? "Preparing the patient…" : "3D patient off.";
}

export function PatientTile({
  name,
  detail,
  speaking,
  line,
  enabled,
  reducedMotion,
  className = "",
}: PatientTileProps) {
  const [status, setStatus] = useState<ModelStatus>("loading");
  const [resetToken, setResetToken] = useState(0);

  const handleStatus = useCallback((next: ModelStatus) => setStatus(next), []);

  const canvasLive = enabled && status !== "failed";
  const showCard = !canvasLive || status === "loading";

  return (
    <section
      aria-label="Patient"
      className={`no-print relative isolate overflow-hidden rounded-xl border border-neutral-800/60 bg-neutral-950 ${className}`}
    >
      {/* ---- background: all CSS, no geometry ---- */}
      {/* studio wash behind the figure */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(115%_85%_at_50%_22%,rgba(56,92,145,0.30)_0%,rgba(23,32,48,0.55)_45%,rgba(8,10,15,0.9)_100%)]"
      />
      {/* barely-there grid — texture, not decoration; invisible unless you look */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.055]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgb(148 163 184) 1px, transparent 1px), linear-gradient(to bottom, rgb(148 163 184) 1px, transparent 1px)",
          backgroundSize: "34px 34px",
        }}
      />
      {/* floor pool: seats him instead of leaving him hovering in a void */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-2/5 bg-[radial-gradient(60%_100%_at_50%_100%,rgba(96,140,205,0.18)_0%,transparent_70%)]"
      />
      {/* vignette */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(125%_100%_at_50%_42%,transparent_30%,rgba(3,6,12,0.72)_100%)]"
      />

      {/* ---- the portrait ---- */}
      {canvasLive && (
        <div className="absolute inset-0">
          <WardStage
            patientSpeaking={speaking}
            reducedMotion={reducedMotion}
            resetToken={resetToken}
            onStatusChange={handleStatus}
          />
        </div>
      )}

      {/* ---- fallback / loading card ---- */}
      {showCard && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
          <div className="pointer-events-auto flex flex-col items-center">
            <PatientPlate name={name} detail={detail} speaking={speaking} line={line} variant="card" />
            <p className="mt-4 max-w-[16rem] text-center text-[11px] leading-relaxed text-neutral-600">
              {fallbackNote(enabled, status)}
            </p>
          </div>
        </div>
      )}

      {/* ---- overlays ---- */}
      {canvasLive && status === "ready" && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
            <PatientPlate
              name={name}
              detail={detail}
              speaking={speaking}
              line={null}
              className="max-w-[70%] rounded-lg border border-neutral-800/60 bg-neutral-950/70 px-2.5 py-2 backdrop-blur-sm"
            />
          </div>

          {/* the live line, captioned under the figure where the eye already is */}
          {speaking && line && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
              <p className="mx-auto max-h-24 overflow-hidden rounded-lg border border-neutral-800/60 bg-neutral-950/80 px-3 py-2 text-xs leading-relaxed text-neutral-200 backdrop-blur-sm">
                {line}
              </p>
            </div>
          )}

          <div className="absolute right-3 top-3 flex flex-col items-end gap-1.5">
            <button
              type="button"
              onClick={() => setResetToken((token) => token + 1)}
              title="Ease the camera back to the default framing"
              className="rounded-lg border border-neutral-800/60 bg-neutral-950/70 px-2 py-1 text-[11px] text-neutral-400 backdrop-blur-sm transition-colors hover:border-neutral-700 hover:text-neutral-100"
            >
              ⟲ Reset view
            </button>
            <span className="hidden text-[10px] text-neutral-600 sm:block">drag to look</span>
          </div>
        </>
      )}
    </section>
  );
}
