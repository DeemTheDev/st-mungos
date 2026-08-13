// Pure voice-selection + SSML logic — no SDK, no browser APIs, so it runs (and
// is smoke-tested) under plain Node: scripts/smoke-speech-logic.ts.
//
// Voice NAMES are configuration, not code: the server resolves them from env
// (VOICE_PATIENT_F / VOICE_PATIENT_M / VOICE_EXAMINER) and ships them to the
// browser alongside the speech token, so swapping a voice is a Vercel env
// change plus a token refresh — never a redeploy of this file.
import type { VoiceRole } from "../ports";

/**
 * Shipped defaults. Both confirmed present in the configured region by
 * `pnpm voices:list` (region eastus: 774 voices, en-ZA has exactly these two,
 * both plain `Neural`, both `StyleList: none`).
 */
export const VOICE_FEMALE = "en-ZA-LeahNeural";
export const VOICE_MALE = "en-ZA-LukeNeural";

/** Used when a hand-typed voice name has no parseable locale prefix. */
const FALLBACK_LOCALE = "en-ZA";

// ---------------------------------------------------------------------------
// configuration

export interface VoiceConfig {
  /** Voice for a female case patient. */
  patientF: string;
  /** Voice for a male case patient. */
  patientM: string;
  /** null = not pinned by env; the examiner then takes the OTHER patient voice
   *  so the two speakers are never confusable. A set value always wins. */
  examiner: string | null;
}

export const DEFAULT_VOICES: VoiceConfig = {
  patientF: VOICE_FEMALE,
  patientM: VOICE_MALE,
  examiner: null,
};

const clean = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * SERVER-side env → VoiceConfig. Pure (the env bag is a parameter), so it is
 * smoke-testable and safe to keep in this client-reachable module — nothing
 * here touches `process`.
 */
export function voiceConfigFromEnv(env: Record<string, string | undefined>): VoiceConfig {
  return {
    patientF: clean(env.VOICE_PATIENT_F) ?? DEFAULT_VOICES.patientF,
    patientM: clean(env.VOICE_PATIENT_M) ?? DEFAULT_VOICES.patientM,
    examiner: clean(env.VOICE_EXAMINER),
  };
}

/** CLIENT-side: trust nothing from the wire; anything missing falls back. */
export function normalizeVoiceConfig(raw: unknown): VoiceConfig {
  const v = (raw ?? {}) as Partial<Record<keyof VoiceConfig, unknown>>;
  const str = (x: unknown): string | null => (typeof x === "string" ? clean(x) : null);
  return {
    patientF: str(v.patientF) ?? DEFAULT_VOICES.patientF,
    patientM: str(v.patientM) ?? DEFAULT_VOICES.patientM,
    examiner: str(v.examiner),
  };
}

/**
 * CLAUDE.md §3: patient voice follows the case patient's sex; the examiner
 * takes the OTHER voice so the two are never confusable — unless VOICE_EXAMINER
 * pins one, which always wins. Interpretation stations have no patient (sex
 * null) and use the female-patient pairing.
 */
export function voicesForPatientSex(
  sex: "M" | "F" | null | undefined,
  config: VoiceConfig = DEFAULT_VOICES,
): Record<VoiceRole, string> {
  const patient = sex === "M" ? config.patientM : config.patientF;
  const opposite = sex === "M" ? config.patientF : config.patientM;
  return { patient, examiner: config.examiner ?? opposite };
}

// ---------------------------------------------------------------------------
// voice capabilities (evidence: `pnpm voices:list`, region eastus)

/**
 * The new-generation families (`DragonHD*`, `MAI-Voice-*`) are all named
 * `<locale>-<Name>:<Family>`; the classic neural voices never contain a colon.
 * HD voices do their own prosody/emotion inference and reject or ignore the
 * classic tuning elements, so we hand them plain text and let them perform.
 */
export function isHdVoice(voiceName: string): boolean {
  return voiceName.includes(":");
}

/**
 * Styles are only legal on voices whose `StyleList` actually contains them —
 * emitting `<mstts:express-as>` for a voice without the style is an SSML error.
 * This map is transcribed from the live voices/list response for the voices a
 * human would plausibly pin via env. Leah and Luke are deliberately ABSENT:
 * they report `StyleList: none`, so they never get a style attribute.
 */
const VOICE_STYLES: Record<string, readonly string[]> = {
  "en-GB-RyanNeural": ["cheerful", "chat", "whispering", "sad"],
  "en-GB-SoniaNeural": ["cheerful", "sad"],
  "en-IN-NeerjaNeural": ["newscast", "cheerful", "empathetic"],
  "en-US-AriaNeural": ["chat", "customerservice", "narration-professional", "newscast-casual", "newscast-formal", "cheerful", "empathetic", "angry", "sad", "excited", "friendly", "terrified", "shouting", "unfriendly", "whispering", "hopeful"],
  "en-US-JennyNeural": ["assistant", "chat", "customerservice", "newscast", "angry", "cheerful", "sad", "excited", "friendly", "terrified", "shouting", "unfriendly", "whispering", "hopeful"],
  "en-US-GuyNeural": ["newscast", "angry", "cheerful", "sad", "excited", "friendly", "terrified", "shouting", "unfriendly", "whispering", "hopeful"],
  "en-US-DavisNeural": ["chat", "angry", "cheerful", "excited", "friendly", "hopeful", "sad", "shouting", "terrified", "unfriendly", "whispering"],
  "en-US-SaraNeural": ["angry", "cheerful", "excited", "friendly", "hopeful", "sad", "shouting", "terrified", "unfriendly", "whispering"],
  "en-US-KaiNeural": ["conversation"],
  "en-US-LunaNeural": ["conversation"],
  "en-US-AndrewMultilingualNeural": ["empathetic", "relieved"],
  "en-US-SerenaMultilingualNeural": ["empathetic", "excited", "friendly", "shy", "serious", "relieved", "sad"],
  "en-US-PhoebeMultilingualNeural": ["empathetic", "sad", "serious"],
  "en-US-DerekMultilingualNeural": ["empathetic", "excited", "relieved", "shy"],
};

/**
 * Preferred styles per role, most-wanted first. A style is applied only if the
 * chosen voice lists it — so a voice without styles (the en-ZA default) simply
 * gets none. The examiner list is deliberately professional-only: a casual
 * "chat" style would undercut the examiner's register.
 */
const ROLE_STYLES: Record<VoiceRole, readonly string[]> = {
  patient: ["chat", "empathetic", "conversation", "generalconversation"],
  examiner: ["narration-professional", "newscast-formal", "newscast", "serious", "professional"],
};

/** The style to use for this role on this voice, or null if none is supported. */
export function styleFor(role: VoiceRole, voiceName: string): string | null {
  if (isHdVoice(voiceName)) return null; // HD voices infer delivery from context
  const supported = VOICE_STYLES[voiceName];
  if (!supported) return null;
  return ROLE_STYLES[role].find((s) => supported.includes(s)) ?? null;
}

/** "en-ZA-LeahNeural" → "en-ZA"; "en-GB-Ada:DragonHDLatestNeural" → "en-GB". */
export function localeFromVoiceName(voiceName: string): string {
  const match = /^([a-z]{2,3})-([A-Za-z]{2})(?=[-:]|$)/.exec(voiceName);
  if (!match) return FALLBACK_LOCALE;
  return `${match[1].toLowerCase()}-${match[2].toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// SSML

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Mild slow-down — the single biggest fix for the "robotic" en-ZA read. */
const PROSODY_RATE = "-5%";
/** A beat between sentences; without it the neural voices run clauses together. */
const SENTENCE_BREAK_MS = 250;

/**
 * Escape the line, inserting a short break at each sentence boundary. The split
 * requires whitespace after the terminator, so decimals ("37.9") and ratios
 * ("108/68") are never broken apart.
 */
function escapeWithSentenceBreaks(text: string): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length < 2) return escapeXml(text);
  return sentences.map(escapeXml).join(`<break time="${SENTENCE_BREAK_MS}ms"/>`);
}

export interface SsmlOptions {
  /** Applies the role's preferred style — only if this voice supports it. */
  role?: VoiceRole;
}

/**
 * One utterance, one voice — the serial queue guarantees they never overlap.
 *
 * Classic neural voices (the en-ZA defaults) get the naturalness treatment:
 * a mild rate reduction, sentence-boundary breaks, and a role style when the
 * voice actually supports one. HD/MAI voices get plain text: they model
 * prosody and emotion themselves and do not accept the classic tuning
 * elements, so emitting them would be an unsupported-attribute error.
 */
export function buildSsml(text: string, voiceName: string, opts: SsmlOptions = {}): string {
  const lang = localeFromVoiceName(voiceName);
  const style = opts.role ? styleFor(opts.role, voiceName) : null;
  const mstts = style ? ` xmlns:mstts="https://www.w3.org/2001/mstts"` : "";

  const body = isHdVoice(voiceName)
    ? escapeXml(text)
    : `<prosody rate="${PROSODY_RATE}">${escapeWithSentenceBreaks(text)}</prosody>`;
  const styled = style ? `<mstts:express-as style="${style}">${body}</mstts:express-as>` : body;

  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"${mstts} xml:lang="${lang}">` +
    `<voice name="${voiceName}">${styled}</voice>` +
    `</speak>`
  );
}
