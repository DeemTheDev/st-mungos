// Stage C — clinical case generation (CLAUDE.md §5).
// Usage: tsx scripts/generate-cases.ts --system resp --count 5 [--uncommon]
//
// Per case: pick a KB topic for the requested system (rotating for variety),
// pick the target diagnosis IN CODE from the per-system pool (excluding
// everything already in bank/drafts — no dedupe-collision waste), then call
// claude-sonnet-5 with structured outputs (the Zod schema rides in
// output_config.format, so the JSON shape is API-enforced; refine rules like
// rubric-sums-to-100 are validated client-side with one feedback retry).
// Drafts land in cases/drafts/<id>.json. Nothing reaches the bank unreviewed.

try {
  process.loadEnvFile(".env.local");
} catch {
  console.warn("(!) .env.local not found — relying on ambient environment variables");
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  ClinicalCaseSchema,
  DisciplineSchema,
  ExaminationSchema,
  OsceCaseSchema,
  type ClinicalCase,
  type Discipline,
} from "../lib/case-schema";
import {
  BANK_DIR,
  EPI_BRIEF_PATH,
  KB_DIR,
  KB_INDEX_PATH,
  createAnthropicClient,
  diagnosisSlug,
  formatZodIssues,
  generateStructured,
  nextSequence,
  normalizeDiagnosis,
  readExistingCases,
  writeDraft,
  type ExistingCaseInfo,
} from "./gen-common";
import { pickDiagnosis, usedDiagnoses } from "./diagnosis-pool";

interface KbIndexEntry {
  slug: string;
  file: string;
  title: string;
  system: string;
  keywords: string[];
}

const SEED_CASE_PATH = join(BANK_DIR, "resp-001-ptb-hiv.json");
// The task brief asks for 8+ triggers per onAsk fact; we hard-require a floor
// of 6 so a single stingy fact doesn't discard an otherwise excellent case.
const MIN_TRIGGERS_PER_ONASK_FACT = 6;

// ---------------------------------------------------------------------------
// Generation-side schema. Structured outputs forces additionalProperties:false
// on every object, which would pin open-key records (pathophys,
// examination.other) to be permanently empty — so for generation, pathophys is
// an array of {symptom, mechanism} pairs (converted back to the record shape
// in code) and `other` is omitted (filled with {} in code).
const GenClinicalCaseSchema = ClinicalCaseSchema.omit({ pathophys: true, examination: true }).extend({
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
type GenClinicalCase = z.infer<typeof GenClinicalCaseSchema>;

function toClinicalCase(gen: GenClinicalCase): unknown {
  return {
    ...gen,
    examination: { ...gen.examination, other: {} },
    pathophys: Object.fromEntries(gen.pathophys.map((p) => [p.symptom, p.mechanism])),
  };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseCliArgs(): { system: Discipline; count: number; uncommon: boolean } {
  const { values } = parseArgs({
    options: {
      system: { type: "string" },
      count: { type: "string" },
      uncommon: { type: "boolean", default: false },
    },
  });
  const systemParse = DisciplineSchema.safeParse(values.system);
  if (!values.system || !systemParse.success) {
    fail(
      `Usage: tsx scripts/generate-cases.ts --system <system> --count 5 [--uncommon]\n` +
        `  --system must be one of: ${DisciplineSchema.options.join(" | ")}`,
    );
  }
  const count = values.count ? parseInt(values.count, 10) : 5;
  if (!Number.isInteger(count) || count < 1 || count > 25) {
    fail("--count must be an integer between 1 and 25");
  }
  return { system: systemParse.data, count, uncommon: values.uncommon ?? false };
}

function loadKbTopics(system: Discipline): Array<KbIndexEntry & { content: string }> {
  if (!existsSync(KB_INDEX_PATH)) {
    fail(
      `Missing ${KB_INDEX_PATH}.\n` +
        `The KB has not been built yet — run the Stage A/B pipeline (ingest + distil) first (CLAUDE.md §5).`,
    );
  }
  let index: KbIndexEntry[];
  try {
    index = JSON.parse(readFileSync(KB_INDEX_PATH, "utf8")) as KbIndexEntry[];
  } catch (err) {
    fail(`Could not parse ${KB_INDEX_PATH}: ${err instanceof Error ? err.message : err}`);
  }
  const entries = index.filter((e) => e.system === system);
  if (entries.length === 0) {
    const known = [...new Set(index.map((e) => e.system))].sort().join(", ") || "(none)";
    fail(`No KB topics for system "${system}". Systems present in the KB index: ${known}`);
  }
  const topics: Array<KbIndexEntry & { content: string }> = [];
  for (const entry of entries) {
    // entry.file may be a bare filename in grounding/kb or a repo-relative path.
    const candidates = [join(KB_DIR, entry.file), join(process.cwd(), entry.file)];
    const path = candidates.find((p) => existsSync(p));
    if (!path) {
      console.warn(`(!) KB file for "${entry.slug}" not found (${entry.file}) — skipping topic`);
      continue;
    }
    topics.push({ ...entry, content: readFileSync(path, "utf8") });
  }
  if (topics.length === 0) fail(`KB index has entries for "${system}" but none of their files exist.`);
  return topics;
}

function buildSystemPrompt(seedCaseJson: string, epidemiologyBrief: string): string {
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
- "examinerBank": 3 to 5 viva questions, each with a modelAnswer and gradingNotes.
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

function buildUserPrompt(
  topic: KbIndexEntry & { content: string },
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

async function main(): Promise<void> {
  const { system, count, uncommon } = parseCliArgs();
  const commonness = uncommon ? "uncommon" : "common";

  if (!existsSync(SEED_CASE_PATH)) fail(`Seed case missing: ${SEED_CASE_PATH}`);
  const seedCaseJson = readFileSync(SEED_CASE_PATH, "utf8");

  let epidemiologyBrief = "";
  if (existsSync(EPI_BRIEF_PATH)) {
    epidemiologyBrief = readFileSync(EPI_BRIEF_PATH, "utf8");
  } else {
    console.warn(`(!) ${EPI_BRIEF_PATH} missing — generating without the KZN epidemiology brief`);
    epidemiologyBrief = "(brief unavailable — apply standard KwaZulu-Natal epidemiology: high HIV and TB burden, diabetes, hypertensive heart disease, CKD, rheumatic heart disease.)";
  }

  const topics = loadKbTopics(system);
  const existing: ExistingCaseInfo[] = readExistingCases();
  // Diagnoses picked in code, excluded up front — no generation is ever spent
  // on a diagnosis that would collide with bank/drafts.
  const seenDiagnoses = usedDiagnoses(existing);

  const client = createAnthropicClient();
  const systemPrompt = buildSystemPrompt(seedCaseJson, epidemiologyBrief);
  let sequence = nextSequence(system, existing);
  let written = 0;
  let discarded = 0;

  console.log(`Generating ${count} ${commonness} ${system} case(s) from ${topics.length} KB topic(s)...\n`);

  for (let i = 0; i < count; i++) {
    const topic = topics[i % topics.length];
    const diagnosis = pickDiagnosis(system, commonness, topic, seenDiagnoses);
    if (!diagnosis) {
      console.warn(
        `[${i + 1}/${count}] diagnosis pool for "${system}" (${commonness}) is exhausted — stopping early. ` +
          `Add entries to scripts/diagnosis-pool.ts to generate more.`,
      );
      break;
    }
    console.log(`[${i + 1}/${count}] topic: ${topic.slug} → ${diagnosis}`);
    try {
      const userPrompt = buildUserPrompt(topic, system, commonness, diagnosis);
      const first = await generateStructured(client, systemPrompt, userPrompt, GenClinicalCaseSchema);
      let result: AttemptResult = first.data
        ? validateGenerated(first.data, system, commonness, diagnosis)
        : { ok: false, feedback: first.feedback ?? "generation returned nothing" };

      if (!result.ok) {
        console.log(`        first attempt rejected — retrying once with feedback`);
        const retry = await generateStructured(
          client,
          systemPrompt,
          `${userPrompt}\n\nYour previous attempt was rejected. ${result.feedback}\n\nOutput the corrected complete case.`,
          GenClinicalCaseSchema,
        );
        result = retry.data
          ? validateGenerated(retry.data, system, commonness, diagnosis)
          : { ok: false, feedback: retry.feedback ?? "generation returned nothing" };
      }

      if (!result.ok || !result.case) {
        discarded++;
        console.error(`        DISCARDED after retry:\n${result.feedback}`);
        continue;
      }

      // Belt-and-braces dedupe guard — the pool pick should make this unreachable.
      const normalized = normalizeDiagnosis(result.case.diagnosis);
      if (seenDiagnoses.has(normalized)) {
        discarded++;
        console.error(`        DISCARDED: duplicate diagnosis "${result.case.diagnosis}" already in bank/drafts`);
        continue;
      }

      // Assign a deterministic unique id, then re-validate the mutated object.
      const id = `${system}-${String(sequence).padStart(3, "0")}-${diagnosisSlug(result.case.diagnosis)}`;
      const final = OsceCaseSchema.parse({ ...result.case, id });

      const path = writeDraft(id, final);
      sequence++;
      written++;
      seenDiagnoses.add(normalized);
      console.log(`        WROTE ${path}`);
      console.log(`        ${final.diagnosis}`);
    } catch (err) {
      discarded++;
      console.error(`        DISCARDED: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone: ${written} draft(s) written, ${discarded} discarded.`);
  console.log(`Review at /admin/review — nothing enters cases/bank without approval.`);
  if (written === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
