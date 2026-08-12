// Stage C — clinical case generation (CLAUDE.md §5).
// Usage: tsx scripts/generate-cases.ts --system resp --count 5 [--uncommon]
//
// Per case: pick a KB topic for the requested system (rotating for variety),
// call claude-sonnet-5 with the topic + KZN epidemiology brief + the full seed
// case as a few-shot example, validate the JSON with the Zod schema (one retry
// with the issues fed back), dedupe against bank + drafts, and write the draft
// to cases/drafts/<id>.json. Nothing reaches the bank without human review.

try {
  process.loadEnvFile(".env.local");
} catch {
  console.warn("(!) .env.local not found — relying on ambient environment variables");
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DisciplineSchema, OsceCaseSchema, type Discipline, type OsceCase } from "../lib/case-schema";
import {
  BANK_DIR,
  EPI_BRIEF_PATH,
  KB_DIR,
  KB_INDEX_PATH,
  createAnthropicClient,
  diagnosisSlug,
  extractJsonObject,
  formatZodIssues,
  generateJson,
  nextSequence,
  normalizeDiagnosis,
  readExistingCases,
  writeDraft,
  type ExistingCaseInfo,
} from "./gen-common";

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
- Output ONLY one JSON object. No markdown fences, no commentary before or after.

SCHEMA (every field required unless marked optional)
{
  "id": kebab-case string (placeholder is fine — it is reassigned in code),
  "version": 1,
  "stationType": "clinical",
  "discipline": one of "resp"|"cardio"|"gi-hep"|"endo"|"neuro"|"renal"|"haem"|"id"|"rheum",
  "diagnosis": string — the final diagnosis,
  "commonness": "common" | "uncommon",
  "difficulty": 1 | 2 | 3,
  "framework": string — the symptom-to-differential framework in play (from the KB topic),
  "patient": { "name", "age" (int), "sex" "M"|"F", "occupation", "personality", "openingLine" },
  "presentingComplaint": string,
  "history": array of AT LEAST 12 facts covering the full HPI, systems-review negatives, PMH, medications, allergies, social history and family history. Each fact:
    { "id": "hx-...", "fact": string, "disclosure": "volunteered"|"onAsk", "triggers": string[] }
    - "volunteered" facts: triggers may be [].
    - "onAsk" facts: FAT trigger lists — 8 to 12 triggers each, covering medical terms AND lay phrasings a nervous student might use (e.g. for haemoptysis: "blood", "coughing up", "phlegm", "spit"). The engine gates disclosure on these strings; thin lists break the game.
  "examination": { "general", "vitals": { "hr" (num), "bp" (string), "rr" (num), "temp" (num), "spo2" (string), "bmi" (num, optional) }, "respiratory", "cardio", "abdo", "neuro", "other": {} } — findings only revealed when the student performs the step,
  "investigations": AT LEAST 6 entries { "name", "result", "key": boolean } with REAL result values — include the confirmatory pathway ("key": true) AND plausible non-key tests so ordering everything isn't free,
  "differentials": AT LEAST 3, each { "dx", "rank" (1 = most likely), "for": string[], "against": string[] },
  "pathophys": object mapping each cardinal symptom → its mechanism (used for examiner "why" questions),
  "staging": string (optional — WHO stage, NYHA class, CKD stage etc. where relevant),
  "management": { "immediate": [], "definitive": [], "supportive": [], "followUp": [] } per SA guidelines,
  "stationChecklist": AT LEAST 8 items — THE MARK SHEET. Every question/action expected of the student:
    { "id": "cl-...", "phase": "history"|"examination"|"differentials"|"investigations"|"management", "item", "answer" (string or null), "why", "weight" 1-5 (int), "critical": boolean }
    - Derive the checklist from the KB topic's framework: the checklist IS that framework turned into a mark sheet, in the order a good candidate would work.
    - Mark items "critical": true when missing them would be an examiner red flag.
  "examinerBank": 3 to 5 viva questions { "id": "ex-...", "triggerPhase": phase, "triggerAfterSec" (int, optional), "question", "modelAnswer", "gradingNotes" }
    - Include one "walk me through your approach / differential" question and one pathophysiology-mechanism question pulled from the pathophys map.
  "rubric": { "communication", "historyTaking", "examination", "clinicalReasoning", "investigations", "management" } — integers that MUST sum to exactly 100.

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
  avoidPairs: Array<{ diagnosis: string; presentingComplaint: string | null }>,
): string {
  const avoidList =
    avoidPairs.length > 0
      ? avoidPairs
          .map((p) => `- ${p.diagnosis}${p.presentingComplaint ? ` — presenting: ${p.presentingComplaint}` : ""}`)
          .join("\n")
      : "- (none yet)";
  return `Write ONE new clinical OSCE case.

Requirements:
- "discipline": "${system}"
- "commonness": "${commonness}"${commonness === "uncommon" ? " — pick a genuinely less-common but examinable diagnosis for this system (still plausible in KZN)" : ""}
- "stationType": "clinical"
- Base the case on the KB topic below. Derive "framework" and the "stationChecklist" from the topic's framework/approach — the checklist is that framework turned into a mark sheet. Weight heavily anything under a "Her notes emphasise" section.
- The case MUST have a different diagnosis AND a different presenting-complaint pattern from every existing case listed here:
${avoidList}

KB TOPIC — ${topic.title}:
${topic.content}

Output ONLY the JSON object.`;
}

/** Checks beyond the Zod schema; returns retryable feedback lines. */
function extraChecks(c: OsceCase, system: Discipline, commonness: "common" | "uncommon"): string[] {
  const problems: string[] = [];
  if (c.stationType !== "clinical") problems.push(`stationType must be "clinical", got "${c.stationType}"`);
  if (c.discipline !== system) problems.push(`discipline must be "${system}", got "${c.discipline}"`);
  if (c.commonness !== commonness) problems.push(`commonness must be "${commonness}", got "${c.commonness}"`);
  if (c.stationType === "clinical") {
    for (const fact of c.history) {
      if (fact.disclosure === "onAsk" && fact.triggers.length < MIN_TRIGGERS_PER_ONASK_FACT) {
        problems.push(
          `history fact "${fact.id}" has only ${fact.triggers.length} triggers — onAsk facts need 8-12 (minimum ${MIN_TRIGGERS_PER_ONASK_FACT}) including lay phrasings`,
        );
      }
    }
  }
  return problems;
}

interface AttemptResult {
  ok: boolean;
  case?: OsceCase;
  feedback?: string;
}

function parseAndValidate(raw: string, system: Discipline, commonness: "common" | "uncommon"): AttemptResult {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonObject(raw));
  } catch (err) {
    return { ok: false, feedback: `The output was not parseable JSON: ${err instanceof Error ? err.message : err}` };
  }
  const parsed = OsceCaseSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, feedback: `Schema validation failed:\n${formatZodIssues(parsed.error.issues)}` };
  }
  const problems = extraChecks(parsed.data, system, commonness);
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
  const seenDiagnoses = new Set(existing.map((c) => normalizeDiagnosis(c.diagnosis)).filter(Boolean));
  const avoidPairs = existing
    .filter((c) => c.diagnosis)
    .map((c) => ({ diagnosis: c.diagnosis, presentingComplaint: c.presentingComplaint }));

  const client = createAnthropicClient();
  const systemPrompt = buildSystemPrompt(seedCaseJson, epidemiologyBrief);
  let sequence = nextSequence(system, existing);
  let written = 0;
  let discarded = 0;

  console.log(`Generating ${count} ${commonness} ${system} case(s) from ${topics.length} KB topic(s)...\n`);

  for (let i = 0; i < count; i++) {
    const topic = topics[i % topics.length];
    console.log(`[${i + 1}/${count}] topic: ${topic.slug}`);
    try {
      const userPrompt = buildUserPrompt(topic, system, commonness, avoidPairs);
      const firstRaw = await generateJson(client, systemPrompt, userPrompt);
      let result = parseAndValidate(firstRaw, system, commonness);

      // A within-run duplicate diagnosis is retryable feedback too.
      if (result.ok && seenDiagnoses.has(normalizeDiagnosis(result.case!.diagnosis))) {
        result = {
          ok: false,
          feedback: `The diagnosis "${result.case!.diagnosis}" already exists in the case bank. Produce a case with a genuinely different diagnosis.`,
        };
      }

      if (!result.ok) {
        console.log(`        first attempt rejected — retrying once with feedback`);
        const retryRaw = await generateJson(
          client,
          systemPrompt,
          `${userPrompt}\n\nYour previous attempt was rejected. ${result.feedback}\n\nOutput the corrected complete JSON object.`,
        );
        result = parseAndValidate(retryRaw, system, commonness);
      }

      if (!result.ok || !result.case) {
        discarded++;
        console.error(`        DISCARDED after retry:\n${result.feedback}`);
        continue;
      }

      // Code-level dedupe guard — refuse to write a duplicate diagnosis.
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
      avoidPairs.push({
        diagnosis: final.diagnosis,
        presentingComplaint: final.stationType === "clinical" ? final.presentingComplaint : null,
      });
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
