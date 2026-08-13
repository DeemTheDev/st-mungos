"use client";

// Stimulus viewer (CLAUDE.md §8) — the overlay the interpretation stations are
// built around. Two code paths:
//
//   abg       → a clinical values card. Numbers in monospace, units labelled,
//               and NOTHING else: no reference ranges, no high/low arrows, no
//               colour coding. Deciding what is abnormal IS the station.
//   ecg | cxr → a dark zoom/pan image panel (wheel + pinch zoom, drag pan,
//               reset). No reviewed images exist yet, so a missing or broken
//               imagePath renders an honest empty state rather than a fake.

import { useCallback, useEffect, useRef, useState } from "react";
import type { StimulusView } from "@/lib/ports";

const MIN_SCALE = 0.5;
const MAX_SCALE = 8;

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// ABG values card

type AbgValues = NonNullable<StimulusView["values"]>;

const ABG_FIELDS: Array<{ key: keyof AbgValues; label: string; unit: string }> = [
  { key: "pH", label: "pH", unit: "" },
  { key: "pCO2_kPa", label: "pCO₂", unit: "kPa" },
  { key: "pO2_kPa", label: "pO₂", unit: "kPa" },
  { key: "HCO3", label: "HCO₃⁻", unit: "mmol/L" },
  { key: "BE", label: "Base excess", unit: "mmol/L" },
  { key: "Na", label: "Na⁺", unit: "mmol/L" },
  { key: "Cl", label: "Cl⁻", unit: "mmol/L" },
  { key: "K", label: "K⁺", unit: "mmol/L" },
  { key: "lactate", label: "Lactate", unit: "mmol/L" },
];

function formatValue(key: keyof AbgValues, value: number): string {
  return key === "pH" ? value.toFixed(2) : String(value);
}

function AbgCard({ values }: { values: AbgValues }) {
  const present = ABG_FIELDS.filter((f) => typeof values[f.key] === "number");

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/80">
      <div className="flex items-baseline justify-between border-b border-neutral-800 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-neutral-100">Arterial blood gas</h3>
        <span className="text-[10px] uppercase tracking-widest text-neutral-500">Results</span>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-neutral-800 sm:grid-cols-3">
        {present.map((field) => (
          <div key={String(field.key)} className="bg-neutral-900 px-4 py-3">
            {/* deliberately NOT uppercased — "pH" and "pCO₂" must read as written */}
            <dt className="text-[11px] tracking-wider text-neutral-500">{field.label}</dt>
            <dd className="mt-0.5 font-mono text-xl text-neutral-100">
              {formatValue(field.key, values[field.key] as number)}
              {field.unit && <span className="ml-1 font-sans text-xs text-neutral-500">{field.unit}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ECG / CXR image panel

function ImagePanel({ src, alt }: { src: string | null; alt: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const tfRef = useRef<Transform>(IDENTITY);
  const [tf, setTf] = useState<Transform>(IDENTITY);
  const [failed, setFailed] = useState(false);
  // Live pointers → 1 = drag pan, 2 = pinch zoom.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  const commit = useCallback((next: Transform) => {
    tfRef.current = next;
    setTf(next);
  }, []);

  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      const current = tfRef.current;
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
      const k = scale / current.scale;
      commit({ scale, x: px - (px - current.x) * k, y: py - (py - current.y) * k });
    },
    [commit],
  );

  // React marks wheel listeners passive at the root, so preventDefault only
  // works from an explicitly non-passive listener.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !src || failed) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      zoomAt(
        Math.exp(-event.deltaY * 0.0015),
        event.clientX - rect.left - rect.width / 2,
        event.clientY - rect.top - rect.height / 2,
      );
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [zoomAt, src, failed]);

  if (!src || failed) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-700 bg-neutral-900/60 px-6 py-10 text-center">
        <p className="text-sm text-neutral-300">Stimulus image not available</p>
        <p className="max-w-sm text-xs text-neutral-500">
          No reviewed image has been promoted for this station yet. Work from the vignette — the
          examiner can still probe your systematic approach.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        ref={frameRef}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerMove={(event) => {
          const live = pointers.current;
          const previous = live.get(event.pointerId);
          if (!previous) return;
          live.set(event.pointerId, { x: event.clientX, y: event.clientY });

          if (live.size === 1) {
            pinch.current = null;
            const current = tfRef.current;
            commit({
              ...current,
              x: current.x + (event.clientX - previous.x),
              y: current.y + (event.clientY - previous.y),
            });
            return;
          }

          const [a, b] = [...live.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (!pinch.current) {
            pinch.current = { dist, scale: tfRef.current.scale };
            return;
          }
          commit({
            ...tfRef.current,
            scale: clamp(pinch.current.scale * (dist / pinch.current.dist), MIN_SCALE, MAX_SCALE),
          });
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          pinch.current = null;
        }}
        onDoubleClick={() => commit(IDENTITY)}
        style={{ touchAction: "none" }}
        className="relative h-[52vh] w-full cursor-grab touch-none overflow-hidden rounded-lg border border-neutral-800 bg-black active:cursor-grabbing"
      >
        <div
          className="flex h-full w-full items-center justify-center"
          style={{
            transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.scale})`,
            transformOrigin: "center center",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- transform-driven zoom/pan, not a layout image */}
          <img
            src={src}
            alt={alt}
            draggable={false}
            onError={() => setFailed(true)}
            className="max-h-full max-w-full select-none object-contain"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-neutral-400">
        <button
          onClick={() => zoomAt(1 / 1.25, 0, 0)}
          className="rounded bg-neutral-800 px-2.5 py-1 text-neutral-200 hover:bg-neutral-700"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          onClick={() => zoomAt(1.25, 0, 0)}
          className="rounded bg-neutral-800 px-2.5 py-1 text-neutral-200 hover:bg-neutral-700"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          onClick={() => commit(IDENTITY)}
          className="rounded bg-neutral-800 px-2.5 py-1 text-neutral-200 hover:bg-neutral-700"
        >
          Reset
        </button>
        <span className="font-mono">{Math.round(tf.scale * 100)}%</span>
        <span className="hidden sm:inline">scroll or pinch to zoom · drag to pan · double-click resets</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const KIND_LABEL: Record<StimulusView["kind"], string> = {
  abg: "Arterial blood gas",
  ecg: "12-lead ECG",
  cxr: "Chest X-ray",
};

export interface StimulusViewerProps {
  stimulus: StimulusView;
  onClose: () => void;
}

export function StimulusViewer({ stimulus, onClose }: StimulusViewerProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${KIND_LABEL[stimulus.kind]} stimulus`}
      className="no-print fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-neutral-950/92 px-3 py-6 backdrop-blur-sm sm:px-6"
    >
      <div className="w-full max-w-3xl space-y-3">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-sky-400">
              {KIND_LABEL[stimulus.kind]}
            </p>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-neutral-200">{stimulus.vignette}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
          >
            Close
          </button>
        </header>

        {stimulus.kind === "abg" && stimulus.values ? (
          <AbgCard values={stimulus.values} />
        ) : stimulus.kind === "abg" ? (
          <p className="rounded border border-dashed border-neutral-700 bg-neutral-900/60 px-4 py-6 text-center text-sm text-neutral-400">
            This gas has no values attached — tell the examiner and work from the vignette.
          </p>
        ) : (
          <ImagePanel src={stimulus.imagePath} alt={`${KIND_LABEL[stimulus.kind]} for this station`} />
        )}
      </div>
    </div>
  );
}
