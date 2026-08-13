import { z } from "zod";

// MarkingReport — the Zod contract for the end-of-session marking pass
// (CLAUDE.md §7). Every report, whether produced by the deterministic MockBrain
// or by claude-sonnet-5, must validate against MarkingReportSchema before it is
// persisted or rendered.

export const CoverageStatusSchema = z.enum(["done", "partial", "missed"]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

/** §7.1 — one stationChecklist (or interpretationChecklist) item's coverage. */
export const ChecklistCoverageSchema = z.object({
  id: z.string().min(1),
  item: z.string().min(1),
  phase: z.string().min(1),
  status: CoverageStatusSchema,
  /** Short quoted evidence snippet from the transcript; null when missed. */
  evidence: z.string().nullable(),
  weight: z.number().int().min(1).max(5),
  critical: z.boolean(),
});
export type ChecklistCoverage = z.infer<typeof ChecklistCoverageSchema>;

/** §7.2 — a missed critical item, listed prominently. */
export const CriticalFlagSchema = z.object({
  checklistId: z.string().min(1),
  message: z.string().min(1),
});
export type CriticalFlag = z.infer<typeof CriticalFlagSchema>;

/** §7.3 — one asked examinerBank question graded 0–2 against its modelAnswer. */
export const VivaGradeSchema = z.object({
  questionId: z.string().min(1),
  question: z.string().min(1),
  grade: z.number().int().min(0).max(2),
  comment: z.string().min(1),
});
export type VivaGrade = z.infer<typeof VivaGradeSchema>;

/** §7.4 — per-domain performance, each 0–100 (percent of that domain). */
export const DomainScoresSchema = z.object({
  communication: z.number().min(0).max(100),
  historyTaking: z.number().min(0).max(100),
  examination: z.number().min(0).max(100),
  clinicalReasoning: z.number().min(0).max(100),
  investigations: z.number().min(0).max(100),
  management: z.number().min(0).max(100),
});
export type DomainScores = z.infer<typeof DomainScoresSchema>;

export const BandSchema = z.enum(["distinction", "pass", "borderline", "fail"]);
export type Band = z.infer<typeof BandSchema>;

/** §7 band mapping: 75+ Distinction / 60+ Pass / 50+ Borderline / <50 Fail. */
export function bandFor(globalScore: number): Band {
  if (globalScore >= 75) return "distinction";
  if (globalScore >= 60) return "pass";
  if (globalScore >= 50) return "borderline";
  return "fail";
}

/** §7.5 — narrative feedback; every session doubles as study notes. */
export const NarrativeSchema = z.object({
  strengths: z.array(z.string().min(1)).length(3),
  improvements: z.array(z.string().min(1)).length(3),
  /** "What the complete station looked like" — full walkthrough incl. the pathophys map. */
  modelStation: z.string().min(1),
});
export type Narrative = z.infer<typeof NarrativeSchema>;

/** §7.7 — interpretation stations: findingsKey hit rate. */
export const FindingHitSchema = z.object({
  finding: z.string().min(1),
  critical: z.boolean(),
  identified: z.boolean(),
});
export type FindingHit = z.infer<typeof FindingHitSchema>;

export const MarkingReportSchema = z.object({
  stationType: z.enum(["clinical", "interpretation"]),
  checklist: z.array(ChecklistCoverageSchema).min(1),
  criticalFlags: z.array(CriticalFlagSchema),
  viva: z.array(VivaGradeSchema),
  /**
   * Clinical stations: per-rubric domain scores. Interpretation stations have
   * no rubric (§7.7 marks step coverage + findings + diagnosis) so this is
   * absent there.
   */
  domainScores: DomainScoresSchema.optional(),
  globalScore: z.number().min(0).max(100),
  band: BandSchema,
  narrative: NarrativeSchema,
  /** Interpretation stations only. */
  findings: z.array(FindingHitSchema).optional(),
  /** Interpretation stations only. */
  diagnosisCorrect: z.boolean().optional(),
});
export type MarkingReport = z.infer<typeof MarkingReportSchema>;

/**
 * The LLM-facing variant used for the claude-sonnet-5 structured-outputs
 * marking call: identical, except narrative arrays are lenient (the API-side
 * schema cannot express exact lengths; code normalises to exactly 3 after
 * parsing) and score fields the code recomputes anyway stay required so the
 * model still reasons about them.
 */
export const LlmMarkingReportSchema = MarkingReportSchema.extend({
  narrative: NarrativeSchema.extend({
    strengths: z.array(z.string().min(1)).min(1),
    improvements: z.array(z.string().min(1)).min(1),
  }),
});
export type LlmMarkingReport = z.infer<typeof LlmMarkingReportSchema>;
