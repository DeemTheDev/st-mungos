// The session engine (CLAUDE.md §6) — a server-side state machine keyed by
// sessionId, persisted after EVERY turn (quit/resume restores phase, elapsed
// time, transcript and revealed facts).
//
// Everything deterministic lives HERE, not in the Brain:
//  - engine-gated disclosure (DECISIONS.md): the patient brain only ever sees
//    volunteered + already-revealed + newly-triggered facts,
//  - exam findings narrated verbatim when the student performs the step,
//  - investigation results returned verbatim when specifically requested,
//  - phase transitions, speaker arbitration, bank triggers, timer events.
// The Brain supplies voices (patient/examiner phrasing) and the marking pass.

import type { ClinicalCase, HistoryFact, InterpretationCase, OsceCase, Phase } from "./case-schema";
import { MarkingReportSchema } from "./marking-schema";
import { matchesAnyTrigger, normalizeText } from "./text-match";
import type {
  Brain,
  CaseStore,
  CaseSummary,
  ExamSection,
  ExaminerDirective,
  SessionMode,
  SessionState,
  SessionStore,
  SessionView,
  Speaker,
} from "./ports";

export const CLINICAL_TIME_LIMIT_SEC = 20 * 60; // 20:00 hard (§6)
export const INTERPRETATION_TIME_LIMIT_SEC = 7 * 60; // 7:00 (§4b)
/** Management-focus viva is deliberately short — it is "rapid-fire" (§8). */
export const MANAGEMENT_TIME_LIMIT_SEC = 10 * 60;
/** Examiner nudges the student out of history after 8 minutes (§6). */
export const HISTORY_NUDGE_SEC = 8 * 60;
/** In-character timer warnings at 10:00 and 17:00 elapsed (§6). */
export const WARNING_THRESHOLDS_SEC = [10 * 60, 17 * 60] as const;

export interface TurnReply {
  speaker: Speaker;
  text: string;
}

export interface TurnResult {
  replies: TurnReply[];
  state: SessionState;
  timeUp: boolean;
}

export interface EngineDeps {
  caseStore: CaseStore;
  sessionStore: SessionStore;
  brain: Brain;
}

// ---------------------------------------------------------------------------
// student-intent detection (§6: transitions are primarily student-driven)

const MGMT_INTENT =
  /\bmy management\b|\bmanagement plan\b|\bmov(e|ing) (on )?to management\b|\bfor management\b|\bmy (treatment )?plan\b|\bi (would|will|d) (start|manage|treat|give|initiate|prescribe|admit)\b/;
const DDX_INTENT =
  /\b(my|the|our) differentials?\b|\bdifferential diagnos\w*\b|\bddx\b|\bmost likely diagnos\w*\b|\bi think (this|she|he|it) (is|has)\b/;
const INV_INTENT =
  /\b(order|request|send|arrange|run|book)\b.*\b(test\w*|investigation\w*|blood\w*|labs?|imaging)\b|\bmov(e|ing) (on )?to investigations?\b/;
const EXAM_INTENT = /\bexamin(e|es|ed|ing|ation)\b|\bmov(e|ing) (on )?to (the )?exam\b/;

// -- who is she talking to? (speaker arbitration) ---------------------------
// An OSCE has two people in the room and the candidate may address either at
// any moment. Routing purely off the phase meant an examiner's spontaneous
// follow-up got answered by the patient, which is the most immersion-breaking
// thing a station can do.

/** Addressing the examiner explicitly, or saying something only he receives. */
const EXAMINER_ADDRESS =
  /\bexaminer\b|\bsir\b|\bma'?am\b|\bmadam\b|\bmy (differential|diagnosis|management|plan|impression|findings)\b|\bi (would|'d) like to (present|summaris|summariz)|\bto (summarise|summarize)\b|\bmay i\b|\bcan i (please )?(have|examine|order|proceed)/;

/** Naming the patient — the one signal strong enough to override a question
 *  the examiner is still waiting on ("Sorry doctor — Mrs Dlamini, one more thing"). */
const PATIENT_NAMED = /\b(mr|mrs|ms|miss|mister)\b|\bsorry to (bother|trouble) you\b/;

/** Ordinary bedside questioning: second-person, symptom-directed. */
const PATIENT_SECOND_PERSON =
  /\bhow are you (feeling|doing)\b|\bcan you tell me\b|\bdo you (have|get|feel|know|mind)\b|\bhave you (ever|had|been|noticed)\b|\bany (pain|fever|cough|nausea)\b|\bare you\b/;

function asksTheCandidate(text: string): boolean {
  if (!text.includes("?")) return false;
  // Rhetorical scene-setting ("shall we move on?") is a nudge, not a question
  // she must answer — holding the floor for it would misroute her next
  // clinical sentence, which is worse than the bug being fixed.
  return !/\b(shall we|let'?s|would you like to (move|continue)|ready to (move|proceed))\b/i.test(text);
}

/** The room's default listener when nothing more specific decides it. */
function defaultAddressee(state: SessionState): Speaker {
  // Management vivas and interpretation stations have no bedside to talk to.
  if (state.mode === "management" || state.stationType === "interpretation") return "examiner";
  return "patient";
}

/**
 * Resolve who the candidate is speaking to, most explicit signal first:
 *   1. an explicit UI choice (she tapped "Examiner"),
 *   2. naming the person ("Mrs Dlamini, do you..." / "my differential is..."),
 *   3. an unanswered question — whoever asked it is owed the answer,
 *   4. the room default (the patient, at the bedside).
 */
function resolveAddressee(
  state: SessionState,
  norm: string,
  override: Speaker | null | undefined,
): Speaker {
  if (override === "patient" || override === "examiner") return override;
  if (state.mode === "management" || state.stationType === "interpretation") return "examiner";
  // Naming the patient outranks everything: she is allowed to turn back to the
  // bedside mid-viva, and only she knows she means to.
  if (PATIENT_NAMED.test(norm)) return "patient";
  // A bank question the examiner is still waiting on outranks loose bedside
  // phrasing — a viva answer can easily contain "do you have" without being
  // addressed to the patient.
  if (state.pendingExaminerQId) return "examiner";
  if (EXAMINER_ADDRESS.test(norm)) return "examiner";
  if (PATIENT_SECOND_PERSON.test(norm)) return "patient";
  // Nothing explicit: whoever asked the last unanswered question is owed it.
  if (state.floor === "patient" || state.floor === "examiner") return state.floor;
  return defaultAddressee(state);
}


function detectPhaseIntent(norm: string): Phase | null {
  if (MGMT_INTENT.test(norm)) return "management";
  if (DDX_INTENT.test(norm)) return "differentials";
  if (INV_INTENT.test(norm)) return "investigations";
  if (EXAM_INTENT.test(norm)) return "examination";
  return null;
}

// ---------------------------------------------------------------------------
// examination mapping (§6: findings revealed ONLY when she performs the step)

const EXAM_VERB = /\b(examin\w*|auscultat\w*|percuss\w*|palpat\w*|inspect\w*|listen\w*|feel\w*|check\w*|measur\w*|assess\w*|perform\w*)\b/;

/** Phrases checked FIRST and masked, so "heart rate" is vitals, not cardio. */
const VITALS_PHRASES = [
  "vital signs", "vitals", "observations", "obs", "blood pressure", "heart rate",
  "respiratory rate", "oxygen saturation", "saturations", "sats", "spo2", "pulse",
  "temperature", "temp",
];

const SECTION_KEYWORDS: Record<Exclude<ExamSection, "vitals" | "other">, string[]> = {
  general: ["general", "end of the bed", "hands", "clubbing", "pallor", "lymph", "jaundice", "cyanosis", "oedema", "thrush", "mouth", "nails", "conjunctiva"],
  respiratory: ["chest", "lungs", "lung", "respiratory", "breath sounds", "air entry", "percussion note"],
  cardio: ["heart", "cardiovascular", "cardiac", "praecordium", "precordium", "murmur", "murmurs", "heart sounds", "jvp", "apex", "pulses"],
  abdo: ["abdomen", "abdominal", "tummy", "belly", "liver", "spleen", "bowel", "ascites"],
  neuro: ["neuro", "neurological", "reflexes", "cranial nerves", "gcs", "power", "tone", "sensation", "meningism", "gait"],
};

function detectExamSections(norm: string, osceCase: ClinicalCase): ExamSection[] {
  if (!EXAM_VERB.test(norm)) return [];
  const sections: ExamSection[] = [];
  let work = norm;
  for (const phrase of VITALS_PHRASES) {
    if (matchesAnyTrigger(work, [phrase])) {
      if (!sections.includes("vitals")) sections.push("vitals");
      work = work.split(phrase).join(" ");
    }
  }
  for (const [section, keywords] of Object.entries(SECTION_KEYWORDS) as Array<[ExamSection, string[]]>) {
    if (matchesAnyTrigger(work, keywords)) sections.push(section);
  }
  for (const key of Object.keys(osceCase.examination.other)) {
    if (matchesAnyTrigger(work, [key]) && !sections.includes("other")) sections.push("other");
  }
  return sections;
}

function narrateExamSection(section: ExamSection, osceCase: ClinicalCase): string {
  const ex = osceCase.examination;
  switch (section) {
    case "vitals": {
      const v = ex.vitals;
      const bmi = v.bmi != null ? `, BMI ${v.bmi}` : "";
      return `Vital signs: heart rate ${v.hr}, blood pressure ${v.bp}, respiratory rate ${v.rr}, temperature ${v.temp}, saturating ${v.spo2}${bmi}.`;
    }
    case "general":
      return `On general examination: ${ex.general}`;
    case "respiratory":
      return `On examination of the chest: ${ex.respiratory}`;
    case "cardio":
      return `On cardiovascular examination: ${ex.cardio}`;
    case "abdo":
      return `On abdominal examination: ${ex.abdo}`;
    case "neuro":
      return `On neurological examination: ${ex.neuro}`;
    case "other":
      return Object.entries(ex.other)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" ");
  }
}

// ---------------------------------------------------------------------------
// investigation requests (§6: returned verbatim only when specifically requested)

const ORDER_VERB = /\b(order\w*|request\w*|send\w*|arrange\w*|book\w*|check\w*|run\w*|take|like|want\w*|need\w*|please|investigat\w*)\b/;
/** Too generic to identify a test on their own. */
const GENERIC_INV_TOKENS = new Set([
  "test", "tests", "with", "consent", "random", "full", "blood", "count", "counts",
  "level", "levels", "chest", "sputum", "urine", "serum", "stool", "the", "and", "for",
]);
/** Classic ward abbreviations expanded in the utterance before matching. */
const INV_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bcxr\b/g, " chest x ray "],
  [/\bfbc\b/g, " full blood count "],
  [/\bu e\b/g, " urea electrolytes "],
  [/\bu and e\b/g, " urea electrolytes "],
  [/\bue\b/g, " urea electrolytes "],
];

function invNameTokens(name: string): string[] {
  return normalizeText(name.replace(/\(.*?\)/g, " "))
    .split(" ")
    .filter((t) => t.length >= 3);
}

/**
 * Fuzzy name match against the catalogue. A test matches when either
 *  (A) every token of its name appears in the utterance, or
 *  (B) a token unique to it in this catalogue (and not generic) appears.
 */
export function matchInvestigations(
  normUtterance: string,
  osceCase: ClinicalCase,
  alreadyOrdered: readonly string[],
): string[] {
  let expanded = ` ${normUtterance} `;
  for (const [re, replacement] of INV_ABBREVIATIONS) expanded = expanded.replace(re, replacement);
  expanded = normalizeText(expanded);

  const tokenCounts = new Map<string, number>();
  for (const inv of osceCase.investigations) {
    for (const t of new Set(invNameTokens(inv.name))) {
      tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
    }
  }

  const matched: string[] = [];
  for (const inv of osceCase.investigations) {
    if (alreadyOrdered.includes(inv.name)) continue;
    const tokens = invNameTokens(inv.name);
    if (tokens.length === 0) continue;
    const allPresent = tokens.every((t) => matchesAnyTrigger(expanded, [t]));
    const uniqueHit = tokens.some(
      (t) => !GENERIC_INV_TOKENS.has(t) && tokenCounts.get(t) === 1 && matchesAnyTrigger(expanded, [t]),
    );
    if (allPresent || uniqueHit) matched.push(inv.name);
  }
  return matched;
}

// ---------------------------------------------------------------------------
// misc helpers

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function advanceClock(state: SessionState, nowMs: number): number {
  const last = Date.parse(state.lastActivityAt);
  const delta = Number.isFinite(last) ? Math.max(0, (nowMs - last) / 1000) : 0;
  state.elapsedActiveSec = Math.round((state.elapsedActiveSec + delta) * 1000) / 1000;
  state.lastActivityAt = nowIso(nowMs);
  return state.elapsedActiveSec;
}

function pushEntry(state: SessionState, speaker: Speaker, text: string, nowMs: number): void {
  state.transcript.push({ speaker, text, ts: nowIso(nowMs), phase: state.phase });
}

function presentStimulus(osceCase: InterpretationCase): string {
  const parts: string[] = [osceCase.stimulus.vignette];
  if (osceCase.stimulus.values) {
    const v = osceCase.stimulus.values;
    const line = [
      `pH ${v.pH}`,
      `pCO2 ${v.pCO2_kPa} kPa`,
      `pO2 ${v.pO2_kPa} kPa`,
      `HCO3 ${v.HCO3} mmol/L`,
      v.BE != null ? `BE ${v.BE}` : null,
      v.Na != null ? `Na ${v.Na}` : null,
      v.Cl != null ? `Cl ${v.Cl}` : null,
      v.K != null ? `K ${v.K}` : null,
      v.lactate != null ? `lactate ${v.lactate}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    parts.push(line);
  }
  if (osceCase.stimulus.imagePath) parts.push(`(Stimulus image: ${osceCase.stimulus.imagePath})`);
  parts.push("Talk me through your interpretation, doctor.");
  return parts.join("\n");
}

/** Random pick respecting the ~80/20 common/uncommon bank weighting (§8). */
export function pickRandomCase(
  summaries: CaseSummary[],
  filter: { stationType?: "clinical" | "interpretation"; discipline?: string },
  rng: () => number = Math.random,
): CaseSummary | null {
  const pool = summaries.filter(
    (s) =>
      (!filter.stationType || s.stationType === filter.stationType) &&
      (!filter.discipline || s.discipline === filter.discipline),
  );
  if (pool.length === 0) return null;
  const common = pool.filter((s) => s.commonness === "common");
  const uncommon = pool.filter((s) => s.commonness === "uncommon");
  const bucket = rng() < 0.8 ? (common.length > 0 ? common : uncommon) : uncommon.length > 0 ? uncommon : common;
  return bucket[Math.floor(rng() * bucket.length)];
}

export function toSessionView(state: SessionState, osceCase: OsceCase): SessionView {
  return {
    id: state.id,
    caseId: state.caseId,
    stationType: state.stationType,
    discipline: osceCase.discipline,
    status: state.status,
    phase: state.phase,
    elapsedSec: Math.round(state.elapsedActiveSec),
    timeLimitSec: state.timeLimitSec,
    transcript: state.transcript,
    patient:
      osceCase.stationType === "clinical"
        ? { name: osceCase.patient.name, age: osceCase.patient.age, sex: osceCase.patient.sex }
        : null,
    // The stimulus is meant to be SHOWN (§4b) — the values/image are the
    // station. Everything that would give the answer away (findingsKey,
    // interpretationChecklist, examinerBank) stays behind on the server.
    stimulus: osceCase.stationType === "interpretation" ? osceCase.stimulus : null,
    report: state.report,
  };
}

// ---------------------------------------------------------------------------
// the engine

export class SessionEngine {
  constructor(private readonly deps: EngineDeps) {}

  private async loadCase(caseId: string): Promise<OsceCase> {
    const osceCase = await this.deps.caseStore.get(caseId);
    if (!osceCase) throw new Error(`Unknown case "${caseId}"`);
    return osceCase;
  }

  async createSession(
    caseId: string,
    nowMs: number = Date.now(),
    mode: SessionMode = "full",
  ): Promise<SessionState> {
    const osceCase = await this.loadCase(caseId);
    const id = `s-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const clinical = osceCase.stationType === "clinical";
    // Management focus is a clinical-station concept (§8): an interpretation
    // station has no management phase to skip to, so the flag is ignored there.
    const managementFocus = clinical && mode === "management";

    const state: SessionState = {
      id,
      caseId,
      stationType: osceCase.stationType,
      mode: managementFocus ? "management" : "full",
      status: "active",
      phase: clinical ? (managementFocus ? "management" : "intro") : "present",
      startedAt: nowIso(nowMs),
      endedAt: null,
      elapsedActiveSec: 0,
      lastActivityAt: nowIso(nowMs),
      timeLimitSec: clinical
        ? managementFocus
          ? MANAGEMENT_TIME_LIMIT_SEC
          : CLINICAL_TIME_LIMIT_SEC
        : INTERPRETATION_TIME_LIMIT_SEC,
      transcript: [],
      revealedFactIds: clinical
        ? osceCase.history.filter((f) => f.disclosure === "volunteered").map((f) => f.id)
        : [],
      revealedExamSections: [],
      orderedInvestigations: [],
      askedExaminerQIds: [],
      answeredExaminerQIds: [],
      pendingExaminerQId: null,
      floor: null,
      pendingInterpretations: [],
      issuedWarningsSec: [],
      nudgedPhases: [],
      report: null,
    };

    if (osceCase.stationType === "clinical") {
      if (managementFocus) {
        // The diagnosis is handed over deliberately — this mode drills treatment,
        // not the symptom→differential work-up (§8).
        pushEntry(
          state,
          "examiner",
          `You have already established the diagnosis: ${osceCase.diagnosis}. Take me through your management.`,
          nowMs,
        );
      } else {
        pushEntry(state, "patient", osceCase.patient.openingLine, nowMs);
      }
    } else {
      pushEntry(state, "examiner", presentStimulus(osceCase), nowMs);
      state.phase = "interpret";
    }

    await this.deps.sessionStore.save(state);
    return state;
  }

  /** Resume after quit/refresh — the away-gap must not count as active time. */
  async resume(sessionId: string, nowMs: number = Date.now()): Promise<SessionState> {
    const state = await this.mustGet(sessionId);
    if (state.status === "active") {
      state.lastActivityAt = nowIso(nowMs);
      await this.deps.sessionStore.save(state);
    }
    return state;
  }

  private async mustGet(sessionId: string): Promise<SessionState> {
    const state = await this.deps.sessionStore.get(sessionId);
    if (!state) throw new Error(`Unknown session "${sessionId}"`);
    return state;
  }

  async getCase(state: SessionState): Promise<OsceCase> {
    return this.loadCase(state.caseId);
  }

  // -------------------------------------------------------------------------

  /**
   * `addressee` is the candidate's explicit choice of who she is speaking to.
   * Voice input carries no such signal, so it is normally null and the engine
   * infers it (see resolveAddressee); the UI control exists for the times the
   * inference would be wrong and she needs to be certain.
   */
  async takeTurn(
    sessionId: string,
    utterance: string,
    nowMs: number = Date.now(),
    addressee: Speaker | null = null,
  ): Promise<TurnResult> {
    const state = await this.mustGet(sessionId);
    if (state.status !== "active") throw new Error(`Session is ${state.status} — start a new station.`);
    const osceCase = await this.loadCase(state.caseId);

    const elapsed = advanceClock(state, nowMs);
    const replies: TurnReply[] = [];
    const say = async (speaker: Speaker, text: string): Promise<void> => {
      replies.push({ speaker, text });
      pushEntry(state, speaker, text, nowMs);
      // Whoever just put a question to her is owed the next answer; a line that
      // is not a question hands the floor back to the room default.
      state.floor = asksTheCandidate(text) ? speaker : null;
    };

    if (state.phase === "wrap") {
      await this.deps.sessionStore.save(state);
      throw new Error("Time is up — end the session for marking.");
    }

    // -- 20:00 (or 7:00) hard timer: the examiner ends the station (§6).
    if (elapsed >= state.timeLimitSec) {
      pushEntry(state, "student", utterance, nowMs);
      const line = await this.deps.brain.examinerTurn({
        osceCase,
        directive: { type: "time-up" },
        transcript: state.transcript,
      });
      await say("examiner", line);
      state.phase = "wrap";
      await this.deps.sessionStore.save(state);
      return { replies, state, timeUp: true };
    }

    const norm = normalizeText(utterance);

    const speakingTo = resolveAddressee(state, norm, addressee);
    // She has taken her turn: the floor is consumed either way.
    state.floor = null;

    if (state.pendingExaminerQId && speakingTo === "examiner") {
      // The student is answering the examiner — no phase change, no disclosure,
      // the examiner (Brain) decides between ONE spontaneous follow-up and a
      // neutral continue (§6: that judgment is the Brain's job, not the engine's).
      const q = osceCase.examinerBank.find((x) => x.id === state.pendingExaminerQId);
      pushEntry(state, "student", utterance, nowMs);
      state.answeredExaminerQIds.push(state.pendingExaminerQId);
      state.pendingExaminerQId = null;
      if (q) {
        const line = await this.deps.brain.examinerTurn({
          osceCase,
          directive: {
            type: "followup-or-continue",
            questionId: q.id,
            question: q.question,
            modelAnswer: q.modelAnswer,
            gradingNotes: q.gradingNotes,
            studentAnswer: utterance,
          },
          transcript: state.transcript,
        });
        await say("examiner", line);
      }
    } else if (osceCase.stationType === "clinical") {
      await this.clinicalStudentTurn(state, osceCase, utterance, norm, nowMs, say, speakingTo);
    } else {
      await this.interpretationStudentTurn(state, utterance, nowMs);
    }

    // -- examiner bank triggers: phase entry / elapsed (§6a). One per turn.
    if (!state.pendingExaminerQId) {
      const due = osceCase.examinerBank.find(
        (q) =>
          !state.askedExaminerQIds.includes(q.id) &&
          q.triggerPhase === state.phase &&
          (q.triggerAfterSec == null || elapsed >= q.triggerAfterSec),
      );
      if (due) {
        const line = await this.deps.brain.examinerTurn({
          osceCase,
          directive: { type: "bank-question", questionId: due.id, question: due.question },
          transcript: state.transcript,
        });
        state.askedExaminerQIds.push(due.id);
        state.pendingExaminerQId = due.id;
        await say("examiner", line);
      } else if (osceCase.stationType === "interpretation" && replies.length === 0) {
        // Probe bank exhausted — brief acknowledgment so the station never stalls.
        const line = await this.deps.brain.examinerTurn({
          osceCase,
          directive: { type: "acknowledge" },
          transcript: state.transcript,
        });
        await say("examiner", line);
      }
    }

    // -- time nudge: stuck >8 min in history (§6). Skipped when the examiner
    //    already has the floor with a bank question.
    if (
      osceCase.stationType === "clinical" &&
      state.phase === "history" &&
      elapsed > HISTORY_NUDGE_SEC &&
      !state.nudgedPhases.includes("history") &&
      !state.pendingExaminerQId
    ) {
      const line = await this.deps.brain.examinerTurn({
        osceCase,
        directive: { type: "nudge", fromPhase: "history", toPhase: "examination" },
        transcript: state.transcript,
      });
      state.nudgedPhases.push("history");
      await say("examiner", line);
    }

    // -- timer warnings at 10:00 and 17:00, examiner voice, in character (§6).
    if (osceCase.stationType === "clinical") {
      for (const threshold of WARNING_THRESHOLDS_SEC) {
        if (elapsed >= threshold && !state.issuedWarningsSec.includes(threshold)) {
          const minutesLeft = Math.round((state.timeLimitSec - threshold) / 60);
          const line = await this.deps.brain.examinerTurn({
            osceCase,
            directive: { type: "timer-warning", minutesLeft },
            transcript: state.transcript,
          });
          state.issuedWarningsSec.push(threshold);
          await say("examiner", line);
        }
      }
    }

    await this.deps.sessionStore.save(state);
    return { replies, state, timeUp: false };
  }

  private async clinicalStudentTurn(
    state: SessionState,
    osceCase: ClinicalCase,
    utterance: string,
    norm: string,
    nowMs: number,
    say: (speaker: Speaker, text: string) => Promise<void>,
    speakingTo: Speaker,
  ): Promise<void> {
    // Student-driven phase transitions (§6) — detected before the entry is
    // recorded so the utterance is tagged with the phase it belongs to.
    const intent = detectPhaseIntent(norm);
    let phaseChanged = false;
    if (intent && intent !== state.phase && state.phase !== "wrap") {
      state.phase = intent;
      phaseChanged = true;
    } else if (state.phase === "intro") {
      state.phase = "history";
    }
    pushEntry(state, "student", utterance, nowMs);

    // Pending stimulus interpretation resolves first: she has now committed,
    // the examiner confirms the withheld result verbatim (§4b integration).
    if (state.pendingInterpretations.length > 0) {
      const name = state.pendingInterpretations.shift()!;
      const inv = osceCase.investigations.find((i) => i.name === name);
      if (inv) await say("examiner", `Thank you, doctor. The ${inv.name} reports: ${inv.result}`);
      return;
    }

    // Examination steps → verbatim findings, examiner-voice narration (§6).
    const sections = detectExamSections(norm, osceCase);
    if (sections.length > 0 && ["intro", "history", "differentials"].includes(state.phase)) {
      state.phase = "examination";
      phaseChanged = true;
    }
    for (const section of sections) {
      if (!state.revealedExamSections.includes(section)) state.revealedExamSections.push(section);
      await say("examiner", narrateExamSection(section, osceCase));
    }

    // Investigations → verbatim results, only when specifically requested (§6);
    // a stimulusRef pauses into an interpret-step before the result is given.
    const orderGate = state.phase === "investigations" || ORDER_VERB.test(norm);
    if (orderGate) {
      const matches = matchInvestigations(norm, osceCase, state.orderedInvestigations);
      if (matches.length > 0 && ["intro", "history", "examination", "differentials"].includes(state.phase)) {
        state.phase = "investigations";
        phaseChanged = true;
      }
      for (const name of matches) {
        state.orderedInvestigations.push(name);
        const inv = osceCase.investigations.find((i) => i.name === name)!;
        if (inv.stimulusRef) {
          state.pendingInterpretations.push(name);
          await say(
            "examiner",
            `Here is the ${inv.name}, doctor. Talk me through your interpretation before I give you the report.`,
          );
        } else {
          await say("examiner", `${inv.name}: ${inv.result}`);
        }
      }
    }

    // Default responder (§6): the patient — unless the student addressed the
    // examiner (phase announcement / differential or management presentation).
    // In management focus there is no bedside left to run: the examiner holds
    // the floor for the whole viva.
    // resolveAddressee has already weighed explicit address and the held floor
    // (an unanswered examiner follow-up). Phase announcements and presentations
    // are additionally examiner-directed by nature — she is telling the examiner
    // what she intends to do, not asking the patient's permission.
    const examinerDirected =
      speakingTo === "examiner" || phaseChanged || DDX_INTENT.test(norm) || MGMT_INTENT.test(norm);

    const producedReply = state.transcript[state.transcript.length - 1]?.speaker !== "student";
    if (!producedReply) {
      if (examinerDirected) {
        // A due bank question (checked by the caller right after this) is the
        // examiner's real response; only acknowledge when none is due.
        const elapsed = state.elapsedActiveSec;
        const due = osceCase.examinerBank.some(
          (q) =>
            !state.askedExaminerQIds.includes(q.id) &&
            q.triggerPhase === state.phase &&
            (q.triggerAfterSec == null || elapsed >= q.triggerAfterSec),
        );
        if (!due) {
          // "I'd like to examine her now" is a phase announcement and only wants
          // an acknowledgement. A differential or a management plan is the viva
          // itself — that is precisely where an examiner probes, so it gets a
          // real reply even though it also moves the phase on.
          const presented = DDX_INTENT.test(norm) || MGMT_INTENT.test(norm);
          const directive: ExaminerDirective =
            speakingTo === "examiner" && (presented || !phaseChanged)
              ? { type: "reply", studentUtterance: utterance }
              : { type: "acknowledge" };
          const line = await this.deps.brain.examinerTurn({ osceCase, directive, transcript: state.transcript });
          await say("examiner", line);
        }
      } else {
        // ENGINE-GATED DISCLOSURE: match the utterance against onAsk triggers;
        // the patient brain receives ONLY volunteered + revealed + newly
        // triggered facts — never the hidden case.
        const matchedFacts: HistoryFact[] = osceCase.history.filter(
          (f) => f.disclosure === "onAsk" && matchesAnyTrigger(norm, f.triggers),
        );
        for (const fact of matchedFacts) {
          if (!state.revealedFactIds.includes(fact.id)) state.revealedFactIds.push(fact.id);
        }
        const knownFacts = osceCase.history.filter((f) => state.revealedFactIds.includes(f.id));
        const line = await this.deps.brain.patientTurn({
          osceCase,
          utterance,
          matchedFacts,
          knownFacts,
          transcript: state.transcript,
        });
        await say("patient", line);
      }
    }
  }

  private async interpretationStudentTurn(
    state: SessionState,
    utterance: string,
    nowMs: number,
  ): Promise<void> {
    pushEntry(state, "student", utterance, nowMs);
    // present → interpret happened at creation; her first substantive utterance
    // commits the interpretation and the machine moves to probing (§6).
    if (state.phase === "interpret") state.phase = "probe";
  }

  // -------------------------------------------------------------------------

  async endSession(
    sessionId: string,
    mode: "mark" | "abandon",
    nowMs: number = Date.now(),
  ): Promise<SessionState> {
    const state = await this.mustGet(sessionId);
    if (state.report && mode === "mark") return state; // idempotent
    if (state.status === "active") advanceClock(state, nowMs);
    state.endedAt = nowIso(nowMs);

    if (mode === "abandon") {
      state.status = "abandoned";
      await this.deps.sessionStore.save(state);
      return state;
    }

    const osceCase = await this.loadCase(state.caseId);
    const report = await this.deps.brain.mark({ osceCase, state });
    // Belt-and-braces: nothing unvalidated is ever persisted or rendered (§7).
    state.report = MarkingReportSchema.parse(report);
    state.status = "completed";
    await this.deps.sessionStore.save(state);
    return state;
  }
}
