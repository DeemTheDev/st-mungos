"use client";

// The dynamic-import boundary for the 3D patient, and nothing else.
//
// This is the ONLY place ./ward-scene is imported, and it is imported with
// next/dynamic + { ssr:false }: three.js never reaches the server bundle, never
// rides in the station's initial chunk, and never blocks text mode. Everything
// visual — tile background, overlays, the fallback card — lives in
// ./patient-tile.tsx, so this file stays a one-line seam.

import dynamic from "next/dynamic";
import type { ModelStatus } from "./ward-scene";

const WardScene = dynamic(() => import("./ward-scene"), {
  ssr: false,
  // The tile paints its own background underneath — nothing to swap in.
  loading: () => null,
});

export type { ModelStatus };

export interface WardStageProps {
  patientSpeaking: boolean;
  reducedMotion: boolean;
  /** Bumped by the tile's "Reset view" button. */
  resetToken: number;
  onStatusChange?: (status: ModelStatus) => void;
}

export function WardStage(props: WardStageProps) {
  return <WardScene {...props} />;
}
