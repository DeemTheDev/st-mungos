// Pure voice-selection + SSML logic — no SDK, no browser APIs, so it runs (and
// is smoke-tested) under plain Node: scripts/smoke-speech-logic.ts.
import type { VoiceRole } from "../ports";

export const VOICE_FEMALE = "en-ZA-LeahNeural";
export const VOICE_MALE = "en-ZA-LukeNeural";

/**
 * CLAUDE.md §3: patient voice follows the case patient's sex (F→Leah, M→Luke);
 * the examiner always takes the OTHER voice so the two are never confusable.
 * Interpretation stations have no patient (sex null) — examiner defaults to
 * Luke, matching the female-patient default.
 */
export function voicesForPatientSex(sex: "M" | "F" | null | undefined): Record<VoiceRole, string> {
  if (sex === "M") return { patient: VOICE_MALE, examiner: VOICE_FEMALE };
  return { patient: VOICE_FEMALE, examiner: VOICE_MALE };
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** One utterance, one voice — the queue guarantees they never overlap. */
export function buildSsml(text: string, voiceName: string): string {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-ZA">` +
    `<voice name="${voiceName}">${escapeXml(text)}</voice>` +
    `</speak>`
  );
}
