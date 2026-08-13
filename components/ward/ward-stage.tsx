"use client";

// The backdrop layer the station sits on top of.
//
// This is the ONLY place ./ward-scene is imported, and it is imported with
// next/dynamic + { ssr:false }: three.js never reaches the server bundle, never
// rides in the station's initial chunk, and never blocks text mode. Whether the
// scene is loading, disabled or broken, this component always paints the same
// plain dark room-lit background — so there is never a white flash.

import dynamic from "next/dynamic";

const WardScene = dynamic(() => import("./ward-scene"), {
  ssr: false,
  // The backdrop below is already painted underneath — nothing to swap in.
  loading: () => null,
});

export interface WardStageProps {
  enabled: boolean;
  patientSpeaking: boolean;
  reducedMotion: boolean;
}

export function WardStage({ enabled, patientSpeaking, reducedMotion }: WardStageProps) {
  return (
    <div aria-hidden className="no-print pointer-events-none fixed inset-0 z-0 bg-neutral-950">
      {enabled && (
        <div className="absolute inset-0">
          <WardScene patientSpeaking={patientSpeaking} reducedMotion={reducedMotion} />
        </div>
      )}
      {/* Scrim: the transcript has to stay the most readable thing on screen. */}
      <div className="absolute inset-0 bg-gradient-to-b from-neutral-950/85 via-neutral-950/45 to-neutral-950/90" />
    </div>
  );
}
