import { z } from "zod";

// The case JSON schema — the heart of St Mungo's (CLAUDE.md §4, §4b).
// Every case in cases/ is validated against OsceCaseSchema; generator output
// that fails validation never reaches a student.

export const DisciplineSchema = z.enum([
  "resp", "cardio", "gi-hep", "endo", "neuro", "renal", "haem", "id", "rheum",
]);

export const PhaseSchema = z.enum([
  // clinical station machine          // interpretation machine
  "intro", "history", "examination", "differentials", "investigations",
  "management", "wrap", "present", "interpret", "probe",
]);

export const HistoryFactSchema = z
  .object({
    id: z.string().min(1),
    fact: z.string().min(1),
    disclosure: z.enum(["volunteered", "onAsk"]),
    // fat trigger lists on purpose — the engine gates disclosure on these (DECISIONS.md)
    triggers: z.array(z.string().min(1)).default([]),
  })
  .refine((f) => f.disclosure === "volunteered" || f.triggers.length > 0, {
    message: "onAsk facts must define at least one trigger",
  });

export const VitalsSchema = z.object({
  hr: z.number(),
  bp: z.string(),
  rr: z.number(),
  temp: z.number(),
  spo2: z.string(),
  bmi: z.number().optional(),
});

export const ExaminationSchema = z.object({
  general: z.string(),
  vitals: VitalsSchema,
  respiratory: z.string(),
  cardio: z.string(),
  abdo: z.string(),
  neuro: z.string(),
  other: z.record(z.string(), z.string()).default({}),
});

export const InvestigationSchema = z.object({
  name: z.string().min(1),
  result: z.string().min(1),
  key: z.boolean().default(false),
  stimulusRef: z.string().optional(), // links to an interpretation stimulus (§4b integration)
});

export const DifferentialSchema = z.object({
  dx: z.string().min(1),
  rank: z.number().int().min(1),
  for: z.array(z.string()),
  against: z.array(z.string()),
});

export const ChecklistItemSchema = z.object({
  id: z.string().min(1),
  phase: PhaseSchema,
  item: z.string().min(1),
  answer: z.string().nullable(),
  why: z.string().min(1),
  weight: z.number().int().min(1).max(5),
  critical: z.boolean(),
});

export const ExaminerQuestionSchema = z.object({
  id: z.string().min(1),
  triggerPhase: PhaseSchema,
  triggerAfterSec: z.number().int().positive().optional(),
  question: z.string().min(1),
  modelAnswer: z.string().min(1),
  gradingNotes: z.string().min(1),
});

export const ManagementSchema = z.object({
  immediate: z.array(z.string()).default([]),
  definitive: z.array(z.string()).default([]),
  supportive: z.array(z.string()).default([]),
  followUp: z.array(z.string()).default([]),
});

export const RubricSchema = z
  .object({
    communication: z.number().int().min(0),
    historyTaking: z.number().int().min(0),
    examination: z.number().int().min(0),
    clinicalReasoning: z.number().int().min(0),
    investigations: z.number().int().min(0),
    management: z.number().int().min(0),
  })
  .refine(
    (r) => Object.values(r).reduce((a, b) => a + b, 0) === 100,
    { message: "rubric weights must sum to 100" },
  );

const caseBase = {
  id: z.string().regex(/^[a-z0-9-]+$/, "kebab-case ids only"),
  version: z.number().int().min(1),
  discipline: DisciplineSchema,
  diagnosis: z.string().min(1),
  commonness: z.enum(["common", "uncommon"]),
  difficulty: z.number().int().min(1).max(3),
  examinerBank: z.array(ExaminerQuestionSchema).min(1),
};

export const ClinicalCaseSchema = z.object({
  ...caseBase,
  stationType: z.literal("clinical"),
  framework: z.string().min(1),
  patient: z.object({
    name: z.string().min(1),
    age: z.number().int().min(0).max(120),
    sex: z.enum(["M", "F"]),
    occupation: z.string(),
    personality: z.string().min(1),
    openingLine: z.string().min(1),
  }),
  presentingComplaint: z.string().min(1),
  history: z.array(HistoryFactSchema).min(5),
  examination: ExaminationSchema,
  investigations: z.array(InvestigationSchema).min(3),
  differentials: z.array(DifferentialSchema).min(2),
  pathophys: z.record(z.string(), z.string()),
  staging: z.string().optional(),
  management: ManagementSchema,
  stationChecklist: z.array(ChecklistItemSchema).min(5),
  rubric: RubricSchema,
});

export const AbgValuesSchema = z.object({
  pH: z.number(),
  pCO2_kPa: z.number(),
  pO2_kPa: z.number(),
  HCO3: z.number(),
  BE: z.number().optional(),
  Na: z.number().optional(),
  Cl: z.number().optional(),
  K: z.number().optional(),
  lactate: z.number().optional(),
});

export const InterpretationCaseSchema = z
  .object({
    ...caseBase,
    stationType: z.literal("interpretation"),
    stimulus: z.object({
      kind: z.enum(["abg", "ecg", "cxr"]),
      vignette: z.string().min(1),
      values: AbgValuesSchema.nullable().default(null),
      imagePath: z.string().nullable().default(null),
    }),
    findingsKey: z
      .array(z.object({ finding: z.string().min(1), critical: z.boolean() }))
      .min(1),
    interpretationChecklist: z
      .array(
        z.object({
          id: z.string().min(1),
          item: z.string().min(1),
          weight: z.number().int().min(1).max(5),
        }),
      )
      .min(3),
    management: ManagementSchema.partial(),
  })
  .superRefine((c, ctx) => {
    if (c.stimulus.kind === "abg" && !c.stimulus.values) {
      ctx.addIssue({ code: "custom", message: "abg stimulus requires values", path: ["stimulus", "values"] });
    }
    if (c.stimulus.kind !== "abg" && !c.stimulus.imagePath) {
      ctx.addIssue({ code: "custom", message: `${c.stimulus.kind} stimulus requires imagePath — never fake a stimulus`, path: ["stimulus", "imagePath"] });
    }
  });

export const OsceCaseSchema = z.discriminatedUnion("stationType", [
  ClinicalCaseSchema,
  InterpretationCaseSchema,
]);

export type Discipline = z.infer<typeof DisciplineSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type HistoryFact = z.infer<typeof HistoryFactSchema>;
export type ClinicalCase = z.infer<typeof ClinicalCaseSchema>;
export type InterpretationCase = z.infer<typeof InterpretationCaseSchema>;
export type OsceCase = z.infer<typeof OsceCaseSchema>;
