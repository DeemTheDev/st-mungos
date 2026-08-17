// Stage C case generation, as a library (CLAUDE.md §5, DECISIONS.md 2026-08-13).
//
// This file is the ONE implementation of "write me an OSCE station": the
// prompts, the KZN-weighted diagnosis pool, the structured-outputs call with
// its grammar-too-large fallback, and the validation/retry loop. Two entry
// points sit on top of it — `pnpm gen:cases` (scripts/generate-cases.ts) and
// POST /api/cases/job/[id]/step — so the CLI and the server can never drift
// into generating different cases from different prompts.
//
// Every safety property of the CLI generator is preserved here, because they
// are the reason the bank is trustworthy:
//   · the target diagnosis is picked IN CODE from the pool, never by the model;
//   · diagnoses already taken (bank + drafts) are excluded before we pay;
//   · output is Zod-validated, with ONE feedback retry, then discarded;
//   · ids are assigned in code, and the mutated object is re-validated.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import Anthropic, { AnthropicError, APIError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z, type ZodIssue, type ZodType } from "zod";

import {
  ClinicalCaseSchema,
  ExaminationSchema,
  OsceCaseSchema,
  type ClinicalCase,
  type Discipline,
} from "../case-schema";
import {
  LibraryUserError,
  createBudgetGuard,
  consoleSpendSink,
  usageOf,
  type SpendSink,
} from "./budget";
import type { CaseRecord, JobStepResult, Library } from "./types";

// Examiner/marking/case-gen model per DECISIONS.md (2026-08-12).
export const GENERATION_MODEL = "claude-sonnet-5";
// Generation is JSON transcription against a fixed schema, not open reasoning —
// thinking is disabled on these calls, so the whole budget belongs to the case
// JSON (~5k tokens) and 8000 has comfortable headroom.
export const MAX_TOKENS = 8000;
// Pretty-printed JSON burns ~40% more output tokens than compact JSON, so the
// fallback demands minified output and gets extra headroom over MAX_TOKENS
// (only tokens actually generated are billed — headroom is free insurance).
const FALLBACK_MAX_TOKENS = 16000;

/** The hand-checked case every generation is asked to match for depth/tone. */
const SEED_CASE_ID = "resp-001-ptb-hiv";

// ---------------------------------------------------------------------------
// small shared helpers (also re-exported by scripts/gen-common.ts)

export function formatZodIssues(issues: ZodIssue[]): string {
  return issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

/** Normalised diagnosis used for the code-level dedupe guard. */
export function normalizeDiagnosis(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // parenthetical qualifiers don't make a new diagnosis
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function diagnosisSlug(diagnosis: string, maxWords = 4): string {
  const words = diagnosis
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, maxWords);
  return (words.join("-") || "case").slice(0, 48).replace(/-+$/, "");
}

/** Next NNN for ids shaped `<prefix>-NNN-...`. */
export function nextSequenceFromIds(prefix: string, ids: readonly string[]): number {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)`);
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export function createGenerationClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new LibraryUserError(
      "The server has no Anthropic API key configured, so nothing can be generated yet.",
      503,
    );
  }
  return new Anthropic();
}

// ---------------------------------------------------------------------------
// the Anthropic call (moved verbatim from scripts/gen-common.ts, plus the sink)

/** Result of one structured generation attempt. Exactly one field is set. */
export interface StructuredResult<T> {
  data: T | null;
  /** Retryable client-side validation feedback (refine rules the API-side schema can't express). */
  feedback: string | null;
}

// 2026-08-17: the API started rejecting the full clinical case schema at
// request time — 400 "The compiled grammar is too large" — while the smaller
// interpretation schema still compiles. When a schema hits that limit,
// structured outputs cannot be used for it, so generateStructured falls back
// to a plain (unconstrained) call and validates the returned JSON client-side
// with the SAME Zod schema + feedback retry the structured path already uses.
// Schemas that failed once are remembered so calls 2..N of a run skip the
// doomed probe. If the API limit rises, the probe succeeds again and
// structured outputs resume automatically — nothing else changes.
const grammarTooLargeSchemas = new WeakSet<object>();

function isGrammarTooLarge(err: unknown): boolean {
  return err instanceof APIError && err.status === 400 && /grammar is too large/i.test(err.message);
}

// The CLIs share one console sink per process, so their `run total $…` line
// still accumulates across every call of a run exactly as it used to.
const cliSink = consoleSpendSink();

/** Plain-call fallback: prompted JSON, parsed + validated client-side. */
async function generateUnstructured<T>(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string,
  schema: ZodType<T>,
  sink: SpendSink,
): Promise<StructuredResult<T>> {
  await sink.assertWithinBudget();
  const response = await client.messages.create({
    model: GENERATION_MODEL,
    max_tokens: FALLBACK_MAX_TOKENS,
    thinking: { type: "disabled" },
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `${userPrompt}\n\nOutput ONLY the complete case as a single MINIFIED JSON object (no indentation or newlines, no prose, no markdown fences).`,
      },
    ],
  });
  await sink.record("generate-case", GENERATION_MODEL, usageOf(response.usage));
  if (response.stop_reason === "refusal") throw new Error("model declined the request (stop_reason: refusal)");
  if (response.stop_reason === "max_tokens") {
    throw new Error(`response truncated at ${FALLBACK_MAX_TOKENS} tokens (stop_reason: max_tokens)`);
  }
  let text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  // Tolerate accidental fences / leading prose around the JSON object.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) return { data: null, feedback: "response contained no JSON object" };
  text = text.slice(first, last + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { data: null, feedback: `response was not valid JSON: ${err instanceof Error ? err.message : err}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { data: null, feedback: `Schema validation failed:\n${formatZodIssues(result.error.issues)}` };
  }
  return { data: result.data, feedback: null };
}

/**
 * One structured-outputs generation call. The JSON *shape* is enforced by the
 * API via `output_config.format` (zodOutputFormat), so shape retries should be
 * rare; refine rules (rubric sum, trigger fatness) are validated client-side by
 * `messages.parse` and surface as retryable `feedback`. Schemas the API's
 * grammar compiler rejects (see note above) transparently use the plain-call
 * fallback instead.
 *
 * The system prompt is static across a run and carries the cache_control
 * breakpoint (prompt-caching: stable prefix in `system`, per-case content in
 * the user message). Thinking is disabled — this is JSON transcription against
 * a fixed schema, not open reasoning.
 *
 * `sink` is the budget guardrail: it vetoes the call when a cap is hit and
 * books the usage afterwards. The CLIs pass nothing and get the console sink.
 */
export async function generateStructured<T>(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string,
  schema: ZodType<T>,
  sink: SpendSink = cliSink,
): Promise<StructuredResult<T>> {
  if (grammarTooLargeSchemas.has(schema)) {
    return generateUnstructured(client, systemPrompt, userPrompt, schema, sink);
  }
  await sink.assertWithinBudget();
  let response;
  try {
    response = await client.messages.parse({
      model: GENERATION_MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: { format: zodOutputFormat(schema) },
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userPrompt }],
    });
  } catch (err) {
    if (isGrammarTooLarge(err)) {
      console.log("        (!) schema exceeds the API grammar limit — falling back to plain JSON generation for this run");
      grammarTooLargeSchemas.add(schema);
      return generateUnstructured(client, systemPrompt, userPrompt, schema, sink);
    }
    // messages.parse throws a plain AnthropicError (not an APIError) when the
    // response fails the client-side Zod backstop — its message carries the
    // formatted issues, which is exactly the retry feedback we want. The call
    // still happened, but the SDK gives us no usage to book for it.
    if (err instanceof AnthropicError && !(err instanceof APIError) && /Failed to parse structured output/.test(err.message)) {
      return { data: null, feedback: err.message };
    }
    throw err;
  }

  await sink.record("generate-case", GENERATION_MODEL, usageOf(response.usage));

  if (response.stop_reason === "refusal") {
    throw new Error("model declined the request (stop_reason: refusal)");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`response truncated at ${MAX_TOKENS} tokens (stop_reason: max_tokens)`);
  }
  if (response.parsed_output == null) {
    throw new Error("model returned no structured output");
  }
  return { data: response.parsed_output, feedback: null };
}

// ---------------------------------------------------------------------------
// the KZN-weighted diagnosis pool (moved from scripts/diagnosis-pool.ts)
//
// The target diagnosis is picked IN CODE before the model is called (and pinned
// in the prompt), which removes dedupe-collision waste: the model can no longer
// "invent" a diagnosis that already exists in bank/drafts and burn a whole
// generation on it. Entries carry match keywords so a KB topic ("Approach to
// chronic cough") can be steered toward the diagnoses it actually teaches.
//
// Diagnoses are deliberately KZN-weighted (CLAUDE.md §1): HIV and its
// opportunistic infections, TB in all its forms, rheumatic heart disease,
// diabetes emergencies, CKD/HIVAN, hepatitis B.

export interface DiagnosisPoolEntry {
  dx: string;
  /** Keywords scored against the KB topic's title + keywords to pick the best fit. */
  match: string[];
}

export interface DisciplinePool {
  common: DiagnosisPoolEntry[];
  uncommon: DiagnosisPoolEntry[];
}

export const DIAGNOSIS_POOL: Record<Discipline, DisciplinePool> = {
  resp: {
    common: [
      { dx: "Pulmonary tuberculosis with newly diagnosed HIV", match: ["cough", "chronic", "tb", "tuberculosis", "haemoptysis", "night sweats"] },
      { dx: "Community-acquired pneumonia", match: ["cough", "fever", "breathless", "pneumonia", "chest"] },
      { dx: "Infective exacerbation of COPD", match: ["breathless", "dyspnoea", "copd", "smoker", "wheeze"] },
      { dx: "Acute severe asthma exacerbation", match: ["wheeze", "breathless", "asthma", "dyspnoea"] },
      { dx: "Tuberculous pleural effusion", match: ["effusion", "pleural", "breathless", "chest pain", "tb"] },
      { dx: "Pneumocystis jirovecii pneumonia in advanced HIV", match: ["breathless", "dyspnoea", "hiv", "hypoxia", "dry cough"] },
      { dx: "Bronchiectasis with secondary infection", match: ["cough", "sputum", "chronic", "haemoptysis"] },
      { dx: "Pulmonary embolism", match: ["chest pain", "pleuritic", "breathless", "dyspnoea", "leg swelling"] },
    ],
    uncommon: [
      { dx: "Bronchogenic carcinoma", match: ["haemoptysis", "weight loss", "cough", "smoker", "mass"] },
      { dx: "Sarcoidosis with pulmonary involvement", match: ["cough", "breathless", "lymphadenopathy", "erythema nodosum"] },
      { dx: "Pneumothorax (secondary, spontaneous)", match: ["chest pain", "sudden", "breathless", "pleuritic", "asthma", "copd", "wheeze"] },
      { dx: "Multidrug-resistant pulmonary tuberculosis", match: ["tb", "tuberculosis", "cough", "retreatment", "resistance"] },
    ],
  },
  cardio: {
    common: [
      { dx: "Congestive cardiac failure from hypertensive heart disease", match: ["breathless", "oedema", "orthopnoea", "heart failure", "hypertension"] },
      { dx: "Rheumatic mitral stenosis with atrial fibrillation", match: ["murmur", "palpitations", "breathless", "rheumatic", "valve"] },
      { dx: "Infective endocarditis on a rheumatic valve", match: ["fever", "murmur", "endocarditis", "valve", "embolic"] },
      { dx: "Acute coronary syndrome (STEMI)", match: ["chest pain", "crushing", "ischaemic", "acute", "sweating"] },
      { dx: "Tuberculous pericardial effusion", match: ["chest pain", "pericardial", "effusion", "tb", "breathless"] },
      { dx: "Hypertensive emergency with target-organ damage", match: ["headache", "hypertension", "blood pressure", "emergency"] },
      { dx: "Peripartum cardiomyopathy", match: ["breathless", "heart failure", "pregnancy", "postpartum", "oedema"] },
    ],
    uncommon: [
      { dx: "Constrictive pericarditis (post-tuberculous)", match: ["oedema", "ascites", "tb", "pericardial", "raised jvp"] },
      { dx: "Severe aortic stenosis with syncope", match: ["syncope", "murmur", "chest pain", "collapse", "valve"] },
      { dx: "Dilated cardiomyopathy (HIV-associated)", match: ["breathless", "heart failure", "hiv", "cardiomyopathy"] },
    ],
  },
  "gi-hep": {
    common: [
      { dx: "Decompensated cirrhosis from chronic hepatitis B", match: ["jaundice", "ascites", "hepatitis", "cirrhosis", "liver"] },
      { dx: "Upper gastrointestinal bleed from oesophageal varices", match: ["haematemesis", "melaena", "bleed", "varices", "liver"] },
      { dx: "Peptic ulcer disease with gastric outlet obstruction", match: ["vomiting", "epigastric", "ulcer", "dyspepsia"] },
      { dx: "Acute pancreatitis", match: ["abdominal pain", "epigastric", "vomiting", "pancreatitis", "alcohol"] },
      { dx: "Chronic diarrhoea in advanced HIV", match: ["diarrhoea", "weight loss", "hiv", "chronic", "wasting"] },
      { dx: "Alcoholic hepatitis", match: ["jaundice", "alcohol", "liver", "hepatitis", "tender"] },
      { dx: "Abdominal tuberculosis with ascites", match: ["ascites", "abdominal", "tb", "weight loss", "distension"] },
    ],
    uncommon: [
      { dx: "Hepatocellular carcinoma on chronic hepatitis B", match: ["mass", "liver", "weight loss", "hepatitis", "right upper quadrant"] },
      { dx: "Autoimmune hepatitis", match: ["jaundice", "young woman", "liver", "fatigue"] },
      { dx: "Inflammatory bowel disease (ulcerative colitis)", match: ["diarrhoea", "bloody", "colitis", "abdominal pain"] },
    ],
  },
  endo: {
    common: [
      { dx: "Diabetic ketoacidosis as first presentation of type 1 diabetes", match: ["polyuria", "polydipsia", "vomiting", "diabetes", "ketoacidosis"] },
      { dx: "Hyperosmolar hyperglycaemic state", match: ["confusion", "dehydration", "diabetes", "elderly", "hyperglycaemia"] },
      { dx: "Newly diagnosed type 2 diabetes with sepsis of the foot", match: ["foot", "ulcer", "diabetes", "sepsis", "neuropathy"] },
      { dx: "Graves' thyrotoxicosis", match: ["weight loss", "palpitations", "tremor", "thyroid", "heat intolerance", "goitre"] },
      { dx: "Primary hypothyroidism", match: ["fatigue", "weight gain", "cold", "thyroid", "constipation"] },
      { dx: "Hypoglycaemia on sulphonylurea therapy", match: ["collapse", "confusion", "sweating", "diabetes", "hypoglycaemia"] },
    ],
    uncommon: [
      { dx: "Addisonian crisis from tuberculous adrenalitis", match: ["hypotension", "pigmentation", "fatigue", "adrenal", "collapse", "tb"] },
      { dx: "Cushing's syndrome", match: ["weight gain", "striae", "hypertension", "cushing", "moon face"] },
      { dx: "Diabetes insipidus", match: ["polyuria", "polydipsia", "thirst", "sodium"] },
    ],
  },
  neuro: {
    common: [
      { dx: "Cryptococcal meningitis in advanced HIV", match: ["headache", "meningitis", "hiv", "confusion", "neck stiffness"] },
      { dx: "Tuberculous meningitis", match: ["headache", "meningitis", "tb", "confusion", "cranial nerve"] },
      { dx: "Ischaemic stroke with hemiplegia", match: ["weakness", "hemiplegia", "stroke", "sudden", "speech"] },
      { dx: "New-onset generalised tonic-clonic seizures (neurocysticercosis)", match: ["seizure", "fit", "convulsion", "collapse"] },
      { dx: "Bacterial meningitis", match: ["headache", "fever", "meningitis", "neck stiffness", "photophobia"] },
      { dx: "HIV-associated peripheral neuropathy", match: ["numbness", "burning", "feet", "neuropathy", "hiv"] },
    ],
    uncommon: [
      { dx: "Cerebral toxoplasmosis with focal seizures in advanced HIV", match: ["seizure", "fit", "convulsion", "hiv", "headache", "focal", "toxoplasmosis", "epilepsy"] },
      { dx: "Guillain-Barré syndrome", match: ["weakness", "ascending", "paralysis", "areflexia"] },
      { dx: "Spinal cord compression from tuberculosis of the spine", match: ["back pain", "weakness", "legs", "tb", "spine", "paraplegia"] },
      { dx: "Myasthenia gravis", match: ["weakness", "fatigable", "ptosis", "diplopia"] },
    ],
  },
  renal: {
    common: [
      { dx: "Acute kidney injury (pre-renal) from gastroenteritis", match: ["oliguria", "dehydration", "kidney", "creatinine", "diarrhoea"] },
      { dx: "HIV-associated nephropathy with nephrotic syndrome", match: ["oedema", "proteinuria", "nephrotic", "hiv", "kidney"] },
      { dx: "Chronic kidney disease from hypertension and diabetes", match: ["kidney", "chronic", "hypertension", "diabetes", "creatinine"] },
      { dx: "Post-infectious glomerulonephritis", match: ["haematuria", "oedema", "hypertension", "nephritic", "throat"] },
      { dx: "Emergency hyperkalaemia in missed dialysis", match: ["hyperkalaemia", "potassium", "dialysis", "weakness", "ecg"] },
    ],
    uncommon: [
      { dx: "Lupus nephritis", match: ["proteinuria", "rash", "joint", "lupus", "young woman"] },
      { dx: "Rapidly progressive glomerulonephritis", match: ["haematuria", "oliguria", "kidney", "crescentic"] },
      { dx: "Renal tubular acidosis", match: ["acidosis", "potassium", "stones", "tubular"] },
    ],
  },
  haem: {
    common: [
      { dx: "Symptomatic iron deficiency anaemia from menorrhagia", match: ["fatigue", "pallor", "anaemia", "bleeding", "menorrhagia"] },
      { dx: "Anaemia of chronic disease in HIV and TB", match: ["fatigue", "pallor", "anaemia", "hiv", "tb", "chronic"] },
      { dx: "HIV-associated lymphoma with B symptoms", match: ["lymphadenopathy", "night sweats", "weight loss", "lymphoma", "hiv"] },
      { dx: "Immune thrombocytopenic purpura", match: ["bruising", "petechiae", "bleeding", "platelets", "purpura"] },
      { dx: "Deep vein thrombosis with pulmonary embolism risk", match: ["leg swelling", "calf", "thrombosis", "swollen", "clot"] },
    ],
    uncommon: [
      { dx: "Thrombotic thrombocytopenic purpura (HIV-associated)", match: ["confusion", "fever", "purpura", "anaemia", "platelets", "hiv"] },
      { dx: "Multiple myeloma", match: ["back pain", "bone pain", "anaemia", "fractures", "elderly", "calcium"] },
      { dx: "Chronic myeloid leukaemia", match: ["splenomegaly", "fatigue", "weight loss", "white cells", "leukaemia"] },
    ],
  },
  id: {
    common: [
      { dx: "Acute HIV seroconversion illness", match: ["fever", "rash", "sore throat", "hiv", "lymphadenopathy", "flu"] },
      { dx: "Disseminated tuberculosis in advanced HIV", match: ["fever", "weight loss", "tb", "hiv", "night sweats", "disseminated"] },
      { dx: "Falciparum malaria after travel to an endemic area", match: ["fever", "travel", "malaria", "rigors", "headache"] },
      { dx: "Sepsis from a urinary source", match: ["fever", "confusion", "sepsis", "dysuria", "shock"] },
      { dx: "Tick bite fever (African rickettsiosis)", match: ["fever", "eschar", "rash", "tick", "headache", "rural"] },
      { dx: "Cryptococcal disease presenting with headache in HIV", match: ["headache", "hiv", "fever", "cryptococcal", "meningitis"] },
      { dx: "Oesophageal candidiasis in advanced HIV", match: ["hiv", "swallowing", "odynophagia", "candidiasis", "thrush", "staging", "opportunistic", "cd4", "weight loss"] },
    ],
    uncommon: [
      { dx: "Paradoxical tuberculosis-IRIS after starting antiretroviral therapy", match: ["hiv", "art", "iris", "immune reconstitution", "tb", "antiretroviral", "cd4", "staging"] },
      { dx: "Typhoid fever", match: ["fever", "abdominal", "diarrhoea", "travel", "prolonged"] },
      { dx: "Amoebic liver abscess", match: ["fever", "right upper quadrant", "liver", "abscess", "tender"] },
      { dx: "Measles in an unvaccinated adult", match: ["rash", "fever", "coryza", "conjunctivitis", "outbreak"] },
    ],
  },
  rheum: {
    common: [
      { dx: "Systemic lupus erythematosus", match: ["joint pain", "rash", "young woman", "lupus", "photosensitive", "fatigue"] },
      { dx: "Rheumatoid arthritis", match: ["joint pain", "stiffness", "hands", "symmetrical", "morning"] },
      { dx: "Acute gout", match: ["joint pain", "toe", "swollen", "gout", "acute", "red"] },
      { dx: "Septic arthritis of the knee", match: ["joint pain", "knee", "fever", "swollen", "septic", "acute"] },
      { dx: "Acute rheumatic fever", match: ["joint pain", "fever", "migratory", "sore throat", "murmur", "rheumatic"] },
    ],
    uncommon: [
      { dx: "Reactive arthritis in HIV", match: ["joint pain", "urethritis", "eye", "hiv", "reactive"] },
      { dx: "Systemic sclerosis", match: ["tight skin", "raynaud", "fingers", "swallowing", "sclerosis"] },
      { dx: "Dermatomyositis", match: ["weakness", "rash", "proximal", "muscle", "heliotrope"] },
    ],
  },
};

const tokenize = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

/**
 * Pick the pool diagnosis best matching a KB topic, excluding anything already
 * used (bank + drafts + earlier in this run). Returns null when the pool for
 * this system/commonness is exhausted.
 */
export function pickDiagnosis(
  system: Discipline,
  commonness: "common" | "uncommon",
  topic: { title: string; keywords: string[] },
  usedNormalized: ReadonlySet<string>,
): string | null {
  const pool = DIAGNOSIS_POOL[system][commonness];
  const topicTokens = tokenize(`${topic.title} ${topic.keywords.join(" ")}`);

  // A pool diagnosis counts as used when an existing case's normalized
  // diagnosis contains it (or vice versa): "acute severe asthma exacerbation"
  // must not be re-picked because an existing case is titled "acute severe
  // asthma exacerbation on a background of poorly controlled asthma".
  const isUsed = (dxNorm: string): boolean => {
    if (usedNormalized.has(dxNorm)) return true;
    for (const used of usedNormalized) {
      if (used.includes(dxNorm) || dxNorm.includes(used)) return true;
    }
    return false;
  };

  let best: DiagnosisPoolEntry | null = null;
  let bestScore = -1;
  for (const entry of pool) {
    if (isUsed(normalizeDiagnosis(entry.dx))) continue;
    let score = 0;
    for (const kw of entry.match) {
      const kwTokens = tokenize(kw);
      if ([...kwTokens].some((t) => topicTokens.has(t))) score++;
    }
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best ? best.dx : null;
}

/** Normalized diagnoses of every existing case — the exclusion set for picking. */
export function usedDiagnoses(diagnoses: readonly string[]): Set<string> {
  return new Set(diagnoses.map(normalizeDiagnosis).filter(Boolean));
}

// ---------------------------------------------------------------------------
// generation-side schema (moved from scripts/generate-cases.ts)

// The prompt asks for 8-12 triggers per onAsk fact; the hard floor only
// catches systematically thin generation. It matches the hand-checked seed
// case, whose own allergies fact carries exactly 3 triggers — a stingy minor
// negative must not burn a paid retry on an otherwise excellent case.
// Floor applies AFTER fattenTriggers() below.
const MIN_TRIGGERS_PER_ONASK_FACT = 3;

// Words too generic to stand alone as disclosure triggers — they would fire
// the fact on almost any question ("anything else?", "how do you feel?").
const GENERIC_TRIGGER_WORDS = new Set([
  "the", "and", "for", "with", "any", "anything", "something", "else", "ever",
  "every", "feel", "feels", "felt", "get", "gets", "getting", "going", "have",
  "has", "had", "been", "being", "know", "like", "much", "many", "more",
  "notice", "noticed", "other", "really", "still", "tell", "think", "time",
  "today", "want", "well", "what", "when", "where", "which", "who", "why",
  "how", "your", "you", "about", "does", "did", "are", "was", "were",
  "than", "usual", "very", "quite", "some", "just", "now", "then", "here",
  "there", "this", "that", "these", "those",
]);

/**
 * Deterministic trigger fattening (the "coughing up" adjacency gap): the
 * engine's matcher only fires multi-word triggers on ADJACENT words, so every
 * multi-word trigger also contributes its meaningful single words as
 * standalone triggers. Mechanical and safe — every added word already appears
 * inside one of the model's own triggers.
 */
function fattenTriggers(triggers: string[]): string[] {
  const out = [...triggers];
  const seen = new Set(triggers.map((t) => t.toLowerCase().trim()));
  for (const trigger of triggers) {
    const words = trigger.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length < 2) continue;
    for (const word of words) {
      if (word.length < 3 || GENERIC_TRIGGER_WORDS.has(word) || seen.has(word)) continue;
      seen.add(word);
      out.push(word);
    }
  }
  return out;
}

// Structured outputs forces additionalProperties:false on every object, which
// would pin open-key records (pathophys, examination.other) to be permanently
// empty — so for generation, pathophys is an array of {symptom, mechanism}
// pairs (converted back to the record shape in code) and `other` is omitted
// (filled with {} in code).
export const GenClinicalCaseSchema = ClinicalCaseSchema.omit({ pathophys: true, examination: true }).extend({
  examination: ExaminationSchema.omit({ other: true }),
  pathophys: z
    .array(
      z.object({
        symptom: z.string().min(1),
        mechanism: z.string().min(1),
      }),
    )
    .min(3),
});
export type GenClinicalCase = z.infer<typeof GenClinicalCaseSchema>;

function toClinicalCase(gen: GenClinicalCase): unknown {
  return {
    ...gen,
    history: gen.history.map((f) =>
      f.disclosure === "onAsk" ? { ...f, triggers: fattenTriggers(f.triggers) } : f,
    ),
    examination: { ...gen.examination, other: {} },
    pathophys: Object.fromEntries(gen.pathophys.map((p) => [p.symptom, p.mechanism])),
  };
}

/** Checks beyond the Zod schema; returns retryable feedback lines. */
function extraChecks(
  c: ClinicalCase,
  system: Discipline,
  commonness: "common" | "uncommon",
  pinnedDiagnosis: string,
): string[] {
  const problems: string[] = [];
  if (normalizeDiagnosis(c.diagnosis) !== normalizeDiagnosis(pinnedDiagnosis)) {
    problems.push(`diagnosis must be exactly "${pinnedDiagnosis}", got "${c.diagnosis}"`);
  }
  if (c.discipline !== system) problems.push(`discipline must be "${system}", got "${c.discipline}"`);
  if (c.commonness !== commonness) problems.push(`commonness must be "${commonness}", got "${c.commonness}"`);
  for (const fact of c.history) {
    if (fact.disclosure === "onAsk" && fact.triggers.length < MIN_TRIGGERS_PER_ONASK_FACT) {
      problems.push(
        `history fact "${fact.id}" has only ${fact.triggers.length} triggers — onAsk facts need 8-12 (minimum ${MIN_TRIGGERS_PER_ONASK_FACT}) including lay phrasings`,
      );
    }
  }
  return problems;
}

interface AttemptResult {
  ok: boolean;
  case?: ClinicalCase;
  feedback?: string;
}

function validateGenerated(
  gen: GenClinicalCase,
  system: Discipline,
  commonness: "common" | "uncommon",
  pinnedDiagnosis: string,
): AttemptResult {
  // Convert the generation shape (pathophys pairs, no `other`) back to the
  // canonical case shape and re-validate — mechanical, so failures are rare.
  const parsed = ClinicalCaseSchema.safeParse(toClinicalCase(gen));
  if (!parsed.success) {
    return { ok: false, feedback: `Schema validation failed:\n${formatZodIssues(parsed.error.issues)}` };
  }
  const problems = extraChecks(parsed.data, system, commonness, pinnedDiagnosis);
  if (problems.length > 0) {
    return { ok: false, feedback: `Fix these problems:\n${problems.map((p) => `- ${p}`).join("\n")}` };
  }
  return { ok: true, case: parsed.data };
}

// ---------------------------------------------------------------------------
// prompts (moved verbatim from scripts/generate-cases.ts — do not fork)

export function buildCaseSystemPrompt(seedCaseJson: string, epidemiologyBrief: string): string {
  return `You are the case author for "St Mungo's", a voice-driven OSCE simulator for a 4th-year medical student at UKZN, KwaZulu-Natal, South Africa. You write complete, clinically accurate CLINICAL OSCE cases as a single JSON object.

PEDAGOGY (non-negotiable)
- Symptom → differential, never diagnosis-first. The student starts from a presenting complaint and works forward: differential → investigations to confirm → final diagnosis → management.
- Pathophysiology of each symptom matters as much as the label.
- Ground everything in KwaZulu-Natal epidemiology and South African practice (SA EML / Adult Hospital Level STGs, WHO clinical staging for HIV, SA TB guidelines).

OUTPUT FORMAT
- The JSON shape is enforced by the API against a schema — your job is to fill every field with real, deep clinical content, not to worry about syntax.

CONTENT REQUIREMENTS (the schema enforces shape; you must supply the substance)
- "id": kebab-case placeholder (it is reassigned in code); "version": 1; "stationType": "clinical".
- "diagnosis": EXACTLY the diagnosis you are given in the request — do not substitute or reword it.
- "framework": the symptom-to-differential framework in play (from the KB topic).
- "history": AT LEAST 12 facts covering the full HPI, systems-review negatives, PMH, medications, allergies, social history and family history.
  - "volunteered" facts: triggers may be [].
  - "onAsk" facts: FAT trigger lists — 8 to 12 triggers each, covering medical terms AND lay phrasings a nervous student might use (e.g. for haemoptysis: "blood", "coughing up", "phlegm", "spit"). The engine gates disclosure on these strings; thin lists break the game.
  - TRIGGER MATCHING MECHANICS (design every trigger list around these):
    - A multi-word trigger only fires when its words appear ADJACENT and in order in the student's sentence: "coughing up" does NOT match "are you coughing anything up?". So for EVERY multi-word trigger, ALSO include each meaningful word of it as its own single-word trigger (e.g. "coughing up" plus "cough" plus "sputum" plus "phlegm" plus "blood") — single words are the safety net.
    - Use base word forms: the matcher already tolerates simple suffixes ("cough" matches coughs/coughed/coughing; "test" matches tested/testing/tests), so "cough" is strictly better than "coughing".
    - Include the common lay paraphrases and question-wordings a student would actually say out loud ("bringing anything up", "anything in the phlegm", "night sweats", "lost weight", "been tested").
    - Never rely on a phrase alone to guard a fact; at least half of each trigger list should be single words.
    - Before you finish, COUNT the triggers on EVERY onAsk fact — minor facts (smoking, alcohol, allergies, medication) included. Any fact with fewer than 8 triggers gets padded with more lay paraphrases and single words until it has 8-12.
- "examination": findings only revealed when the student performs the step — write real signs consistent with the diagnosis, including a full vitals set.
- "investigations": AT LEAST 6 entries with REAL result values — include the confirmatory pathway ("key": true) AND plausible non-key tests so ordering everything isn't free.
- "differentials": AT LEAST 3, ranked (1 = most likely), each with "for" and "against" evidence drawn from this case.
- "pathophys": an ARRAY of { "symptom", "mechanism" } pairs — one per cardinal symptom, real mechanisms (used for examiner "why" questions). (The seed example below shows the older object form; you must produce the array-of-pairs form.)
- "staging": WHO stage, NYHA class, CKD stage etc. where relevant (optional).
- "management": { "immediate", "definitive", "supportive", "followUp" } per SA guidelines.
- "stationChecklist": AT LEAST 8 items — THE MARK SHEET. Every question/action expected of the student.
  - Derive the checklist from the KB topic's framework: the checklist IS that framework turned into a mark sheet, in the order a good candidate would work.
  - Mark items "critical": true when missing them would be an examiner red flag.
  - weights are integers 1-5.
  - "phase" must be EXACTLY one of: "history" | "examination" | "differentials" | "investigations" | "management" — no other value exists.
  - EVERY checklist item MUST carry ALL of: "id", "phase", "item", "answer" (string or null), "why", "weight", "critical" — never omit "why".
- "examinerBank": 3 to 5 viva questions.
  - EVERY question MUST carry ALL of: "id", "triggerPhase", "question", "modelAnswer", "gradingNotes".
  - "triggerPhase" must be EXACTLY one of: "history" | "examination" | "differentials" | "investigations" | "management".
  - Include one "walk me through your approach / differential" question and one pathophysiology-mechanism question pulled from the pathophys pairs.
- "rubric": { communication, historyTaking, examination, clinicalReasoning, investigations, management } — integers that MUST sum to exactly 100.

PATIENT REALISM
- Patients speak layperson language ("sugar sickness", not "poorly controlled T2DM"); the personality field should make them playable (worried, stoic, chatty, minimising...).
- Names, places and occupations should feel like Durban / KZN (see the epidemiology brief).

GOLD-STANDARD EXAMPLE (match its depth, tone and trigger fatness):
${seedCaseJson}

KZN EPIDEMIOLOGY BRIEF:
${epidemiologyBrief}`;
}

export function buildCaseUserPrompt(
  topic: { title: string; content: string },
  system: Discipline,
  commonness: "common" | "uncommon",
  diagnosis: string,
): string {
  return `Write ONE new clinical OSCE case for exactly this diagnosis: ${diagnosis}

Requirements:
- "diagnosis": exactly "${diagnosis}" (verbatim — it was chosen in code and is checked in code)
- "discipline": "${system}"
- "commonness": "${commonness}"
- "stationType": "clinical"
- Base the case on the KB topic below. Derive "framework" and the "stationChecklist" from the topic's framework/approach — the checklist is that framework turned into a mark sheet. Weight heavily anything under a "Her notes emphasise" section.

KB TOPIC — ${topic.title}:
${topic.content}`;
}

// ---------------------------------------------------------------------------
// one case, start to finish — the unit both entry points call

export interface GenerateOneCaseOptions {
  client: Anthropic;
  /** Built once per run by buildCaseSystemPrompt — byte-identical so it caches. */
  systemPrompt: string;
  topic: { title: string; content: string };
  system: Discipline;
  commonness: "common" | "uncommon";
  /** Picked in code from the pool; the model must reproduce it verbatim. */
  diagnosis: string;
  sink?: SpendSink;
  log?: (line: string) => void;
}

export type GenerateOneCaseResult =
  | { ok: true; case: ClinicalCase }
  | { ok: false; feedback: string };

/** First attempt, then ONE retry with the validation errors fed back. */
export async function generateOneCase(opts: GenerateOneCaseOptions): Promise<GenerateOneCaseResult> {
  const { client, systemPrompt, topic, system, commonness, diagnosis } = opts;
  const sink = opts.sink ?? cliSink;
  const log = opts.log ?? (() => {});

  const userPrompt = buildCaseUserPrompt(topic, system, commonness, diagnosis);
  const first = await generateStructured(client, systemPrompt, userPrompt, GenClinicalCaseSchema, sink);
  let result: AttemptResult = first.data
    ? validateGenerated(first.data, system, commonness, diagnosis)
    : { ok: false, feedback: first.feedback ?? "generation returned nothing" };

  if (!result.ok) {
    log(
      `        first attempt rejected — retrying once with feedback:\n        ${(result.feedback ?? "").slice(0, 400).replace(/\n/g, "\n        ")}`,
    );
    const retry = await generateStructured(
      client,
      systemPrompt,
      `${userPrompt}\n\nYour previous attempt was rejected. ${result.feedback}\n\nOutput the corrected complete case.`,
      GenClinicalCaseSchema,
      sink,
    );
    result = retry.data
      ? validateGenerated(retry.data, system, commonness, diagnosis)
      : { ok: false, feedback: retry.feedback ?? "generation returned nothing" };
  }

  if (!result.ok || !result.case) {
    return { ok: false, feedback: result.feedback ?? "generation returned nothing" };
  }
  return { ok: true, case: result.case };
}

// ---------------------------------------------------------------------------
// grounding shared by both stages

// The real brief lives in grounding/_epidemiology-kzn.md, which is gitignored
// (her private course material tree) and therefore absent in production. This
// condensed version — written from CLAUDE.md §1, not from her material — keeps
// server-side generation and distillation KZN-grounded when the file is gone.
const KZN_BRIEF_FALLBACK = `KwaZulu-Natal, South Africa — public-sector internal medicine (condensed brief).
- HIV prevalence is very high; assume it is relevant to almost every adult admission. Test, stage (WHO clinical staging), and think about opportunistic infections: TB, cryptococcal disease, PJP, oesophageal candidiasis, toxoplasmosis, HIV-associated nephropathy, HIV-associated cardiomyopathy.
- Tuberculosis is everywhere, pulmonary and extrapulmonary (pleural, pericardial, abdominal, spinal, meningeal). A cough over two weeks triggers a TB workup; GeneXpert MTB/RIF is the first-line test.
- Chronic hepatitis B is common and drives cirrhosis and hepatocellular carcinoma.
- Non-communicable disease burden: type 2 diabetes and its emergencies (DKA, HHS, foot sepsis), hypertension and hypertensive heart disease/CCF, CKD, stroke.
- Rheumatic heart disease remains common in young adults; infective endocarditis usually lands on a rheumatic valve.
- Practice context: district and regional public hospitals, limited imaging and specialist access, SA Essential Medicines List and Adult Hospital Level STGs, SA TB and ART guidelines. Investigations and management must be what a public hospital can actually do.
- Patients: isiZulu-speaking Durban/KZN names, occupations and places; layperson symptom language; taxi transport, clinic-first care pathways, treatment-interruption and adherence themes.`;

/** The KZN brief that grounds both distillation and generation. */
export function epidemiologyBrief(): string {
  try {
    const text = readFileSync(join(process.cwd(), "grounding", "_epidemiology-kzn.md"), "utf8").trim();
    return text.length > 0 ? text : KZN_BRIEF_FALLBACK;
  } catch {
    return KZN_BRIEF_FALLBACK;
  }
}

/** KB meta line written by the distil prompt: `<!-- meta: {"system":…,"keywords":[…]} -->`. */
export function keywordsFromKbContent(content: string, fallbackTitle: string): string[] {
  const match = content.match(/<!--\s*meta:\s*(\{[\s\S]*?\})\s*-->/);
  if (match) {
    try {
      const meta = JSON.parse(match[1]) as { keywords?: unknown };
      if (Array.isArray(meta.keywords) && meta.keywords.length > 0) {
        return meta.keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean);
      }
    } catch {
      // fall through to the title tokens
    }
  }
  return [...tokenize(fallbackTitle)];
}

// ---------------------------------------------------------------------------
// the server-side job
//
// There is no jobs table: `Library` (lib/library/types.ts) has no jobs port and
// schema-library.sql has no st_gen_jobs, so a generation job is STATELESS. The
// job id carries its own spec, and progress is derived from the case ids it
// owns — `<system>-NNN-<slug>` with NNN in [startSeq, startSeq+count). That
// makes a job resumable across invocations and across a page refresh with no
// extra state to keep consistent, and it costs one list() per step.

const GenJobSpecSchema = z.object({
  system: z.enum(["resp", "cardio", "gi-hep", "endo", "neuro", "renal", "haem", "id", "rheum"]),
  count: z.number().int().min(1).max(25),
  commonness: z.enum(["common", "uncommon"]),
  /** First sequence number this job owns — reserved when the job was created. */
  startSeq: z.number().int().min(1),
  createdAt: z.string().min(1),
});
export type GenJobSpec = z.infer<typeof GenJobSpecSchema>;

const JOB_ID_PREFIX = "gen_";

export function encodeGenJobId(spec: GenJobSpec): string {
  return JOB_ID_PREFIX + Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");
}

export function decodeGenJobId(jobId: string): GenJobSpec {
  const invalid = new LibraryUserError("That generation job link is not one I recognise — start a new run.", 404);
  if (!jobId.startsWith(JOB_ID_PREFIX)) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(jobId.slice(JOB_ID_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  const result = GenJobSpecSchema.safeParse(parsed);
  if (!result.success) throw invalid;
  return result.data;
}

/** Reserve a block of sequence numbers and hand back the job id that owns it. */
export async function createGenJob(
  library: Pick<Library, "cases">,
  input: { system: Discipline; count: number; commonness: "common" | "uncommon" },
): Promise<GenJobSpec & { id: string }> {
  const existing = await library.cases.list();
  const startSeq = nextSequenceFromIds(
    input.system,
    existing.map((c) => c.id),
  );
  const spec: GenJobSpec = {
    system: input.system,
    count: input.count,
    commonness: input.commonness,
    startSeq,
    createdAt: new Date().toISOString(),
  };
  return { ...spec, id: encodeGenJobId(spec) };
}

/** Case ids this job owns, in sequence order — its progress, derived. */
function producedIdsFor(spec: GenJobSpec, cases: readonly CaseRecord[]): string[] {
  const re = new RegExp(`^${spec.system}-(\\d+)-`);
  const owned: Array<{ seq: number; id: string }> = [];
  for (const record of cases) {
    const m = re.exec(record.id);
    if (!m) continue;
    const seq = parseInt(m[1], 10);
    if (seq >= spec.startSeq && seq < spec.startSeq + spec.count) owned.push({ seq, id: record.id });
  }
  return owned.sort((a, b) => a.seq - b.seq).map((o) => o.id);
}

interface GenerationTopic {
  slug: string;
  title: string;
  keywords: string[];
  content: string;
}

async function topicsForSystem(library: Library, system: Discipline): Promise<GenerationTopic[]> {
  const all = await library.kb.list();
  const forSystem = all.filter((t) => t.system === system);
  if (forSystem.length === 0) {
    const present = [...new Set(all.map((t) => t.system))].sort().join(", ") || "none yet";
    throw new LibraryUserError(
      `There are no knowledge-base topics for "${system}" yet, so there is nothing to build a station from. ` +
        `Upload a study guide for it first. (Topics currently cover: ${present}.)`,
      409,
    );
  }
  return forSystem.map((t) => ({
    slug: t.slug,
    title: t.title,
    keywords: keywordsFromKbContent(t.content, t.title),
    content: t.content,
  }));
}

/** The gold-standard example in the system prompt — bank first, draft as backup. */
async function seedCaseJson(library: Library): Promise<string> {
  const seed = await library.cases.get(SEED_CASE_ID);
  if (seed && seed.stationType === "clinical") return JSON.stringify(seed.data, null, 2);
  const bank = await library.cases.list("bank");
  const fallback =
    bank.find((c) => c.stationType === "clinical") ??
    (await library.cases.list("draft")).find((c) => c.stationType === "clinical");
  if (!fallback) {
    throw new LibraryUserError(
      "There is no clinical case in the library yet to use as the worked example, so generation would have nothing to imitate.",
      409,
    );
  }
  return JSON.stringify(fallback.data, null, 2);
}

/**
 * ONE case per invocation — that is what keeps a generation run inside a
 * serverless function's time limit. The step is idempotent in the sense that
 * matters: it derives what has already been produced from the library, so a
 * killed or re-polled step simply generates the next missing case.
 */
export async function runGenerateStep(library: Library, jobId: string): Promise<JobStepResult> {
  const spec = decodeGenJobId(jobId);
  const total = spec.count;
  const produced = producedIdsFor(spec, await library.cases.list());
  const done = produced.length;

  if (done >= total) {
    return { status: "done", progress: { done, total }, producedIds: produced };
  }

  const topics = await topicsForSystem(library, spec.system);
  const topic = topics[done % topics.length];
  const taken = await library.cases.takenDiagnoses();
  const diagnosis = pickDiagnosis(spec.system, spec.commonness, topic, usedDiagnoses(taken));
  if (!diagnosis) {
    return {
      status: "done",
      progress: { done, total },
      producedIds: produced,
      message:
        `Every ${spec.commonness} ${spec.system} diagnosis in the pool already has a case, so I stopped at ${done}. ` +
        `Add more to the pool in lib/library/generate-job.ts to go further.`,
    };
  }

  const client = createGenerationClient();
  const systemPrompt = buildCaseSystemPrompt(await seedCaseJson(library), epidemiologyBrief());
  const outcome = await generateOneCase({
    client,
    systemPrompt,
    topic,
    system: spec.system,
    commonness: spec.commonness,
    diagnosis,
    sink: createBudgetGuard(library, jobId),
  });

  if (!outcome.ok) {
    // Deliberately terminal for this job: a step that produced nothing has no
    // way to record "I already tried this one", so re-polling would retry it
    // for real money forever. Stopping puts the decision back with a human.
    return {
      status: "failed",
      progress: { done, total },
      producedIds: produced,
      message:
        `The station for "${diagnosis}" came back malformed twice, so I stopped rather than keep spending. ` +
        `The ${done} case(s) already written are safe — start a new run to try again.`,
    };
  }

  const id = `${spec.system}-${String(spec.startSeq + done).padStart(3, "0")}-${diagnosisSlug(outcome.case.diagnosis)}`;
  // Re-validate the mutated object: the id was assigned in code after generation.
  const data = OsceCaseSchema.parse({ ...outcome.case, id });
  await library.cases.put({
    id,
    status: "draft",
    stationType: "clinical",
    discipline: data.discipline,
    diagnosis: data.diagnosis,
    commonness: data.commonness,
    difficulty: data.difficulty,
    data,
    kbSource: topic.slug,
    reviewNote: null,
    reviewedAt: null,
    createdAt: new Date().toISOString(),
  });

  const nowDone = done + 1;
  return {
    status: nowDone >= total ? "done" : "running",
    progress: { done: nowDone, total },
    producedIds: [...produced, id],
    message: `Drafted ${data.diagnosis} (${nowDone} of ${total}).`,
  };
}
