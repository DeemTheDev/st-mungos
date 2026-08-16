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

/**
 * The selectable patient voices, per sex. Every name here was confirmed present
 * in region `eastus` by `pnpm voices:list` and is documented in
 * docs/ARCHITECTURE.md §8. These are DEFAULTS: `VOICE_PATIENT_POOL_F` /
 * `VOICE_PATIENT_POOL_M` replace them wholesale without a deploy.
 *
 * Shipped South African first — it is the authentic accent for a KZN station,
 * and the deterministic picker indexes into the list, not past it.
 */
export const DEFAULT_POOL_F: readonly string[] = [
  VOICE_FEMALE,
  "en-GB-Sonia:DragonHDLatestNeural",
  "en-GB-Ada:DragonHDLatestNeural",
  "en-KE-AsiliaNeural",
  "en-NG-EzinneNeural",
  "en-TZ-ImaniNeural",
];

export const DEFAULT_POOL_M: readonly string[] = [
  VOICE_MALE,
  "en-GB-Ollie:DragonHDLatestNeural",
  "en-GB-Ryan:DragonHDLatestNeural",
  "en-KE-ChilembaNeural",
  "en-NG-AbeoNeural",
  "en-TZ-ElimuNeural",
];

/** The picker value meaning "derive it from the session id". */
export const RANDOM_PATIENT_VOICE = "random";

// ---------------------------------------------------------------------------
// configuration

export interface VoiceConfig {
  /** Effective default voice for a female case patient (pin ?? shipped). */
  patientF: string;
  /** Effective default voice for a male case patient (pin ?? shipped). */
  patientM: string;
  /** null = not pinned by env; the examiner then takes the OTHER patient voice
   *  so the two speakers are never confusable. A set value always wins. */
  examiner: string | null;
  /** VOICE_PATIENT_F verbatim, or null when unset. Non-null disables picking. */
  pinnedF: string | null;
  /** VOICE_PATIENT_M verbatim, or null when unset. Non-null disables picking. */
  pinnedM: string | null;
  /** Selectable female-patient voices (VOICE_PATIENT_POOL_F ?? DEFAULT_POOL_F). */
  poolF: string[];
  /** Selectable male-patient voices (VOICE_PATIENT_POOL_M ?? DEFAULT_POOL_M). */
  poolM: string[];
}

export const DEFAULT_VOICES: VoiceConfig = {
  patientF: VOICE_FEMALE,
  patientM: VOICE_MALE,
  examiner: null,
  pinnedF: null,
  pinnedM: null,
  poolF: [...DEFAULT_POOL_F],
  poolM: [...DEFAULT_POOL_M],
};

const clean = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** "a, b ,, b" → ["a", "b"]. Blank/duplicate entries are dropped, order kept. */
export function parseVoicePool(value: string | undefined): string[] | null {
  const raw = clean(value);
  if (!raw) return null;
  const names = [...new Set(raw.split(",").map((n) => n.trim()).filter(Boolean))];
  return names.length > 0 ? names : null;
}

/**
 * SERVER-side env → VoiceConfig. Pure (the env bag is a parameter), so it is
 * smoke-testable and safe to keep in this client-reachable module — nothing
 * here touches `process`.
 */
export function voiceConfigFromEnv(env: Record<string, string | undefined>): VoiceConfig {
  const pinnedF = clean(env.VOICE_PATIENT_F);
  const pinnedM = clean(env.VOICE_PATIENT_M);
  return {
    patientF: pinnedF ?? DEFAULT_VOICES.patientF,
    patientM: pinnedM ?? DEFAULT_VOICES.patientM,
    examiner: clean(env.VOICE_EXAMINER),
    pinnedF,
    pinnedM,
    poolF: parseVoicePool(env.VOICE_PATIENT_POOL_F) ?? [...DEFAULT_POOL_F],
    poolM: parseVoicePool(env.VOICE_PATIENT_POOL_M) ?? [...DEFAULT_POOL_M],
  };
}

/** CLIENT-side: trust nothing from the wire; anything missing falls back. */
export function normalizeVoiceConfig(raw: unknown): VoiceConfig {
  const v = (raw ?? {}) as Partial<Record<keyof VoiceConfig, unknown>>;
  const str = (x: unknown): string | null => (typeof x === "string" ? clean(x) : null);
  const pool = (x: unknown, fallback: readonly string[]): string[] => {
    if (!Array.isArray(x)) return [...fallback];
    const names = [...new Set(x.filter((n): n is string => typeof n === "string").map((n) => n.trim()).filter(Boolean))];
    return names.length > 0 ? names : [...fallback];
  };
  return {
    patientF: str(v.patientF) ?? DEFAULT_VOICES.patientF,
    patientM: str(v.patientM) ?? DEFAULT_VOICES.patientM,
    examiner: str(v.examiner),
    pinnedF: str(v.pinnedF),
    pinnedM: str(v.pinnedM),
    poolF: pool(v.poolF, DEFAULT_POOL_F),
    poolM: pool(v.poolM, DEFAULT_POOL_M),
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
// per-session patient voice (the picker)

/** The selectable pool for this patient's sex. Interpretation stations → female. */
export function patientVoicePool(
  sex: "M" | "F" | null | undefined,
  config: VoiceConfig = DEFAULT_VOICES,
): string[] {
  return sex === "M" ? config.poolM : config.poolF;
}

/** The env pin for this sex, or null when the student is free to choose. */
export function pinnedPatientVoice(
  sex: "M" | "F" | null | undefined,
  config: VoiceConfig = DEFAULT_VOICES,
): string | null {
  return sex === "M" ? config.pinnedM : config.pinnedF;
}

/**
 * FNV-1a, 32-bit. Any stable string hash would do; the requirement is only that
 * it is DETERMINISTIC — `Math.random()` at render time would re-cast the patient
 * mid-station on every re-render and again on resume.
 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface PatientVoiceRequest {
  sex: "M" | "F" | null | undefined;
  /** The session id — the seed. Same station ⇒ same voice, forever. */
  sessionId: string;
  /** "random" (or null/unknown) ⇒ derive from the seed; anything else is a pin. */
  choice?: string | null;
  config?: VoiceConfig;
  /** The examiner's voice, so a random patient never collides with it. */
  examiner?: string | null;
}

/**
 * Precedence, highest first:
 *   1. `VOICE_PATIENT_F` / `VOICE_PATIENT_M` — a server pin. The student's
 *      picker is disabled while one is set; this is the pre-existing
 *      "operator decides" behaviour and stays backward-compatible.
 *   2. Her explicit choice, if it is actually in the pool.
 *   3. "Random each station" (the default) — `hash(sessionId) % pool.length`,
 *      nudged one along if it lands on the examiner's voice.
 *   4. Empty pool ⇒ the shipped en-ZA default for that sex.
 */
export function resolvePatientVoice(req: PatientVoiceRequest): string {
  const config = req.config ?? DEFAULT_VOICES;
  const pin = pinnedPatientVoice(req.sex, config);
  if (pin) return pin;

  const pool = patientVoicePool(req.sex, config);
  const fallback = req.sex === "M" ? config.patientM : config.patientF;
  if (pool.length === 0) return fallback;

  const choice = clean(req.choice ?? undefined);
  if (choice && choice !== RANDOM_PATIENT_VOICE && pool.includes(choice)) return choice;

  let index = hashSeed(req.sessionId) % pool.length;
  // Two speakers with one voice is unusable in an exam — step off the collision.
  if (pool.length > 1 && req.examiner && pool[index] === req.examiner) {
    index = (index + 1) % pool.length;
  }
  return pool[index] ?? fallback;
}

/**
 * The full pair for a live session: the examiner exactly as before (env pin, or
 * the opposite shipped voice), the patient through the picker.
 */
export function voicesForSession(req: PatientVoiceRequest): Record<VoiceRole, string> {
  const config = req.config ?? DEFAULT_VOICES;
  const examiner = config.examiner ?? (req.sex === "M" ? config.patientF : config.patientM);
  return { patient: resolvePatientVoice({ ...req, config, examiner }), examiner };
}

// ---------------------------------------------------------------------------
// human labels for the picker

/** Locale → the accent a human would name it by. */
const ACCENTS: Record<string, string> = {
  "en-ZA": "South African",
  "en-GB": "British",
  "en-KE": "Kenyan",
  "en-NG": "Nigerian",
  "en-TZ": "Tanzanian",
  "en-GH": "Ghanaian",
  "en-US": "American",
  "en-AU": "Australian",
  "en-IE": "Irish",
  "en-IN": "Indian",
  "en-NZ": "New Zealand",
  "en-CA": "Canadian",
  "en-SG": "Singaporean",
  "en-PH": "Filipino",
  "en-HK": "Hong Kong",
};

export interface VoiceDescription {
  /** "Leah". */
  name: string;
  /** "South African", or the raw locale when it is not one we have a word for. */
  accent: string;
  /** New-generation (Dragon HD / MAI) — noticeably more natural. */
  hd: boolean;
  /** "Leah — South African" / "Sonia — British (HD)". */
  label: string;
}

/**
 * Derived, not table-driven, so a voice pinned through `VOICE_PATIENT_POOL_*`
 * that nobody has ever heard of still gets a sensible label instead of a raw
 * Azure identifier in the dropdown.
 */
export function describeVoice(voiceName: string): VoiceDescription {
  const locale = localeFromVoiceName(voiceName);
  const hd = isHdVoice(voiceName);
  const stem = voiceName.startsWith(`${locale}-`) ? voiceName.slice(locale.length + 1) : voiceName;
  const name =
    stem
      .split(":")[0]
      .replace(/(Multilingual)?Neural$/, "")
      .trim() || voiceName;
  const accent = ACCENTS[locale] ?? locale;
  return { name, accent, hd, label: `${name} — ${accent}${hd ? " (HD)" : ""}` };
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
