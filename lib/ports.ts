// Ports & adapters (CLAUDE.md §3): the session engine depends only on these
// interfaces. Anthropic / the filesystem / Supabase are adapters behind them —
// swap any vendor without touching the engine. Implementations live in
// lib/brains/* and lib/stores/*.

import type { ClinicalCase, HistoryFact, InterpretationCase, OsceCase, Phase } from "./case-schema";
import type { MarkingReport } from "./marking-schema";

// ---------------------------------------------------------------------------
// CaseStore / KbStore

export interface CaseSummary {
  id: string;
  stationType: "clinical" | "interpretation";
  discipline: string;
  diagnosis: string;
  commonness: "common" | "uncommon";
  difficulty: number;
}

export interface CaseStore {
  list(): Promise<CaseSummary[]>;
  get(id: string): Promise<OsceCase | null>;
}

export interface KbTopic {
  slug: string;
  title: string;
  system: string;
  keywords: string[];
  content: string;
}

export interface KbStore {
  search(keywords: string[]): Promise<KbTopic[]>;
  upsert(topic: KbTopic): Promise<void>;
}

// ---------------------------------------------------------------------------
// Session state (CLAUDE.md §9) — persisted after EVERY turn

export type Speaker = "student" | "patient" | "examiner";

export interface TranscriptEntry {
  speaker: Speaker;
  text: string;
  /** ISO timestamp. */
  ts: string;
  phase: Phase;
}

export type ExamSection = "general" | "vitals" | "respiratory" | "cardio" | "abdo" | "neuro" | "other";

/**
 * New-exam flow (CLAUDE.md §8). "full" is the whole station from the presenting
 * complaint; "management" is the management-focus rapid viva — the diagnosis is
 * handed to the student up front and the station opens in the management phase.
 */
export type SessionMode = "full" | "management";

export interface SessionState {
  id: string;
  caseId: string;
  stationType: "clinical" | "interpretation";
  /** Sessions persisted before this field existed read back undefined → "full". */
  mode: SessionMode;
  status: "active" | "completed" | "abandoned";
  phase: Phase;
  startedAt: string;
  endedAt: string | null;
  /** Accumulated ACTIVE seconds — time while quit/suspended never counts. */
  elapsedActiveSec: number;
  /** Wall-clock anchor of the last engine interaction (turn or resume). */
  lastActivityAt: string;
  timeLimitSec: number;
  transcript: TranscriptEntry[];
  /** Includes volunteered facts (seeded at creation) + everything trigger-revealed. */
  revealedFactIds: string[];
  revealedExamSections: ExamSection[];
  orderedInvestigations: string[];
  askedExaminerQIds: string[];
  answeredExaminerQIds: string[];
  /** Bank question awaiting the student's answer, if any. */
  pendingExaminerQId: string | null;
  /**
   * Who is waiting on an answer from the candidate — set whenever a reply ends
   * in a direct question, cleared when she speaks. This is what lets her answer
   * an examiner's spontaneous follow-up (or a patient's "am I going to be all
   * right, doctor?") without the engine mis-routing it to the other one.
   * Sessions persisted before this field existed read back undefined → null.
   */
  floor?: Speaker | null;
  /** Investigations whose result is withheld until the student interprets the stimulus (§6). */
  pendingInterpretations: string[];
  /** Timer-warning thresholds (seconds) already announced. */
  issuedWarningsSec: number[];
  /** Phases the examiner has already time-nudged out of. */
  nudgedPhases: Phase[];
  report: MarkingReport | null;
}

export interface SessionSummary {
  id: string;
  caseId: string;
  stationType: "clinical" | "interpretation";
  status: SessionState["status"];
  startedAt: string;
  band: string | null;
}

export interface SessionStore {
  get(id: string): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  list(): Promise<SessionSummary[]>;
}

// ---------------------------------------------------------------------------
// Brain

/**
 * Engine-gated disclosure (DECISIONS.md): the patient brain receives ONLY
 * volunteered + already-revealed + newly-triggered facts — never the full
 * hidden case. It cannot leak what it never saw.
 */
export interface PatientTurnCtx {
  osceCase: ClinicalCase;
  utterance: string;
  /** Facts whose triggers matched THIS utterance (revealed now or previously). */
  matchedFacts: HistoryFact[];
  /** Everything the patient may draw on: volunteered + all revealed so far. */
  knownFacts: HistoryFact[];
  transcript: TranscriptEntry[];
}

export type ExaminerDirective =
  | { type: "bank-question"; questionId: string; question: string }
  | { type: "followup-or-continue"; questionId: string; question: string; modelAnswer: string; gradingNotes: string; studentAnswer: string }
  // A free conversational reply to something the candidate said directly to the
  // examiner, outside the question bank. Without this the examiner could only
  // speak from a script, so a spontaneous follow-up ("why that antibiotic?")
  // had no way to receive an answer and the reply fell through to the patient.
  | { type: "reply"; studentUtterance: string }
  | { type: "nudge"; fromPhase: Phase; toPhase: Phase }
  | { type: "timer-warning"; minutesLeft: number }
  | { type: "time-up" }
  | { type: "acknowledge" };

export interface ExaminerTurnCtx {
  osceCase: OsceCase;
  directive: ExaminerDirective;
  transcript: TranscriptEntry[];
}

export interface MarkingCtx {
  osceCase: OsceCase;
  state: SessionState;
}

export interface Brain {
  patientTurn(ctx: PatientTurnCtx): Promise<string>;
  examinerTurn(ctx: ExaminerTurnCtx): Promise<string>;
  mark(ctx: MarkingCtx): Promise<MarkingReport>;
}

// ---------------------------------------------------------------------------
// Voice (CLAUDE.md §3) — Azure Speech is an adapter behind these two ports
// (lib/speech/); the station UI depends only on the interfaces.

export type VoiceRole = "patient" | "examiner";

export interface SpeakingEvent {
  role: VoiceRole;
  text: string;
  state: "started" | "stopped";
}

export interface SpeechToText {
  /** Open the mic and stream. Partials fire while she speaks; the accumulated
   *  final transcript is delivered to onFinal after stop(). */
  start(onPartial: (text: string) => void, onFinal: (text: string) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface TextToSpeech {
  /** Queued + strictly sequential — resolves when THIS utterance finishes
   *  playing (the examiner waits for the patient, never talks over). */
  speak(text: string, role: VoiceRole): Promise<void>;
  onSpeaking(cb: (ev: SpeakingEvent) => void): void;
  /** Cut current playback and drop the queue. */
  stop(): void;
  setMuted(muted: boolean): void;
  repeatLast(): Promise<void>;
  /** Change the patient's voice for SUBSEQUENT utterances — "random" (derive it
   *  from the session id) or a concrete voice name. Never reloads the page. */
  setPatientVoice(choice: string): void;
}

// ---------------------------------------------------------------------------
// The redacted view the client is allowed to see (never the hidden case JSON)

/**
 * Exactly the stimulus an interpretation station is MEANT to show her (§4b/§8):
 * kind, vignette, ABG values, image path. It carries none of the hidden case —
 * findingsKey, interpretationChecklist and examinerBank stay server-side.
 */
export type StimulusView = InterpretationCase["stimulus"];

export interface SessionView {
  id: string;
  caseId: string;
  stationType: "clinical" | "interpretation";
  discipline: string;
  status: SessionState["status"];
  phase: Phase;
  elapsedSec: number;
  timeLimitSec: number;
  transcript: TranscriptEntry[];
  patient: { name: string; age: number; sex: "M" | "F" } | null;
  /** Interpretation stations only — the stimulus viewer renders this. */
  stimulus: StimulusView | null;
  report: MarkingReport | null;
}
