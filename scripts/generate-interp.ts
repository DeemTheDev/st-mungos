// Stage C — interpretation station generation (CLAUDE.md §4b, §5).
// Usage: tsx scripts/generate-interp.ts --kind abg --count 3
//
// ABG stations are SYNTHETIC: lib/abg.ts computes physiologically consistent
// values in code (Henderson-Hasselbalch + compensation rules + anion gap) and
// rejects inconsistent gases deterministically. claude-sonnet-5 is called once
// per case only to WRAP the pre-validated values in the case JSON (vignette,
// findingsKey, checklist, examiner bank, brief management). If the model edits
// any value, the code restores the originals.
//
// ECG / CXR stations need real reviewed images — never faked (§4b), so those
// kinds are skipped until images exist in /public/stimuli.

try {
  process.loadEnvFile(".env.local");
} catch {
  console.warn("(!) .env.local not found — relying on ambient environment variables");
}

import { parseArgs } from "node:util";
import {
  InterpretationCaseSchema,
  OsceCaseSchema,
  type InterpretationCase,
  type OsceCase,
} from "../lib/case-schema";
import { ABG_ARCHETYPES, type AbgValues, type GeneratedAbg, generateAbg } from "../lib/abg";
import {
  createAnthropicClient,
  diagnosisSlug,
  generateStructured,
  nextSequence,
  normalizeDiagnosis,
  readExistingCases,
  writeDraft,
} from "./gen-common";

// The standard stepwise ABG method (CLAUDE.md §4b) — the checklist IS this
// method; the model adapts wording per case but keeps ids, order and weights.
const ABG_METHOD_STEPS = [
  { id: "ic-1", item: "Comments on clinical context first", weight: 1 },
  { id: "ic-2", item: "Assesses oxygenation (pO2 against FiO2)", weight: 2 },
  { id: "ic-3", item: "Identifies acidaemia/alkalaemia from pH", weight: 2 },
  { id: "ic-4", item: "Identifies the primary disorder (respiratory vs metabolic)", weight: 3 },
  { id: "ic-5", item: "Assesses compensation (acute vs chronic, expected vs actual)", weight: 3 },
  { id: "ic-6", item: "Calculates the anion gap where relevant", weight: 2 },
  { id: "ic-7", item: "Synthesises: diagnosis + clinical correlation", weight: 3 },
  { id: "ic-8", item: "States immediate management implications", weight: 2 },
] as const;

// Schema-valid few-shot (the §4b example, completed). parse() at module load
// keeps this example honest against schema drift.
const EXAMPLE_INTERP_CASE: OsceCase = OsceCaseSchema.parse({
  id: "interp-abg-000-example",
  version: 1,
  stationType: "interpretation",
  discipline: "resp",
  diagnosis: "Acute-on-chronic type 2 respiratory failure (infective exacerbation of COPD)",
  commonness: "common",
  difficulty: 2,
  stimulus: {
    kind: "abg",
    vignette: "A 58-year-old man, known with COPD, presents with 3 days of worsening breathlessness and purulent sputum. ABG taken on room air:",
    values: { pH: 7.28, pCO2_kPa: 9.1, pO2_kPa: 7.2, HCO3: 31, BE: 4, Na: 138, Cl: 100, K: 4.4, lactate: 1.1 },
    imagePath: null,
  },
  findingsKey: [
    { finding: "Acidaemia (pH 7.28)", critical: true },
    { finding: "Raised pCO2 → primary respiratory acidosis", critical: true },
    { finding: "Raised HCO3 → partial metabolic compensation (chronic element)", critical: true },
    { finding: "Type 2 respiratory failure (pO2 7.2 kPa with pCO2 9.1 kPa)", critical: true },
    { finding: "Normal anion gap (~7)", critical: false },
  ],
  interpretationChecklist: ABG_METHOD_STEPS.map((s) => ({ ...s })),
  examinerBank: [
    {
      id: "ex-1",
      triggerPhase: "probe",
      question: "The bicarbonate is 31 — why is it raised, and what does that tell you about the time course?",
      modelAnswer:
        "Renal bicarbonate retention takes days, so a raised HCO3 means chronic CO2 retention with metabolic compensation; the pH remaining acidaemic means the pCO2 has risen acutely on top of that baseline — an acute-on-chronic picture.",
      gradingNotes: "Wants the acute-vs-chronic compensation logic, not just 'compensation'.",
    },
    {
      id: "ex-2",
      triggerPhase: "probe",
      question: "How would you give this man oxygen, and what is the danger?",
      modelAnswer:
        "Controlled oxygen via 24–28% Venturi targeting SpO2 88–92%, repeat the gas within 30–60 minutes; uncontrolled high-flow oxygen risks worsening hypercapnia in a chronic retainer. If the pH stays below 7.35 with persistent hypercapnia despite initial therapy, he needs NIV.",
      gradingNotes: "Full marks: target saturations AND the escalation to NIV. Partial: 'give oxygen carefully'.",
    },
  ],
  management: {
    immediate: [
      "Controlled oxygen (24–28% Venturi) targeting SpO2 88–92%",
      "Nebulised salbutamol + ipratropium, systemic corticosteroids, antibiotics per exacerbation protocol",
    ],
    definitive: ["Repeat ABG within an hour; NIV if pH remains < 7.35 with hypercapnia"],
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseCliArgs(): { kind: "abg" | "ecg" | "cxr"; count: number } {
  const { values } = parseArgs({
    options: {
      kind: { type: "string", default: "abg" },
      count: { type: "string" },
    },
  });
  const kind = values.kind as string;
  if (kind !== "abg" && kind !== "ecg" && kind !== "cxr") {
    fail("Usage: tsx scripts/generate-interp.ts --kind abg|ecg|cxr --count 3");
  }
  const count = values.count ? parseInt(values.count, 10) : 3;
  if (!Number.isInteger(count) || count < 1 || count > 20) fail("--count must be an integer between 1 and 20");
  return { kind, count };
}

function buildSystemPrompt(): string {
  return `You are the case author for "St Mungo's", a voice-driven OSCE simulator for a 4th-year medical student at UKZN, KwaZulu-Natal, South Africa. You write short INTERPRETATION stations (7-minute, stimulus-first) for arterial blood gases.

The ABG values you receive were generated and physiology-validated IN CODE (Henderson-Hasselbalch, compensation rules, anion gap). Your job is ONLY to wrap them in the station JSON.

HARD RULES
- Echo the provided values EXACTLY, key for key, number for number, into "stimulus.values". Do not change, round, add or remove any value.
- Set "diagnosis" to exactly the diagnosis string provided.
- Base "findingsKey" on the provided deterministic findings — keep each provided finding (light rewording for readability is fine, numbers unchanged); you may add at most 2 extra non-critical findings.
- "interpretationChecklist" must keep the provided ids, order and weights of the standard stepwise ABG method; adapt each item's wording to this case where helpful (e.g. name the relevant compensation question).
- The systematic method matters as much as the final answer — the examiner bank should probe mechanism, compensation logic and management, each with a modelAnswer and gradingNotes.
- Ground the vignette and management in KwaZulu-Natal / South African hospital practice.

OUTPUT (the JSON shape is enforced by the API against a schema — fill it with real content):
{
  "id": kebab-case placeholder (reassigned in code),
  "version": 1,
  "stationType": "interpretation",
  "discipline": as provided,
  "diagnosis": exactly as provided,
  "commonness": as provided,
  "difficulty": as provided (1-3),
  "stimulus": { "kind": "abg", "vignette": 1-3 sentence clinical stem ending in "ABG on <FiO2 context>:", "values": the provided values EXACTLY, "imagePath": null },
  "findingsKey": [{ "finding": string, "critical": boolean }, ...],
  "interpretationChecklist": [{ "id", "item", "weight" }, ...] — the 8 provided steps,
  "examinerBank": 2-4 of { "id": "ex-N", "triggerPhase": "probe", "question", "modelAnswer", "gradingNotes" },
  "management": { "immediate": [...], "definitive": [...] } — brief, what she should do next
}

GOLD-STANDARD EXAMPLE:
${JSON.stringify(EXAMPLE_INTERP_CASE, null, 2)}`;
}

function buildUserPrompt(gen: GeneratedAbg): string {
  const a = gen.archetype;
  return `Write ONE new ABG interpretation station.

Case parameters (use verbatim where stated):
- discipline: "${a.discipline}"
- commonness: "${a.commonness}"
- difficulty: ${a.difficulty}
- diagnosis (exact): ${a.diagnosis}
- clinical scenario to build the vignette around: ${a.vignetteSeed}
- model interpretation the student should reach: ${a.interpretation}

ABG VALUES — echo EXACTLY into stimulus.values:
${JSON.stringify(gen.values, null, 2)}

DETERMINISTIC FINDINGS — the basis of findingsKey:
${JSON.stringify(gen.findings, null, 2)}

STANDARD STEPWISE METHOD — keep ids, order and weights; adapt wording to this case:
${JSON.stringify(ABG_METHOD_STEPS, null, 2)}`;
}

/** Number-exact comparison of the echoed values against the generated ones. */
function valuesMatch(generated: AbgValues, echoed: AbgValues): boolean {
  const keys: Array<keyof AbgValues> = ["pH", "pCO2_kPa", "pO2_kPa", "HCO3", "BE", "Na", "Cl", "K", "lactate"];
  return keys.every((k) => generated[k] === echoed[k]);
}

interface AttemptResult {
  ok: boolean;
  case?: InterpretationCase;
  feedback?: string;
}

/** Structured outputs already ran the schema client-side; only the kind check remains. */
function validateGenerated(c: InterpretationCase | null, feedback: string | null): AttemptResult {
  if (!c) return { ok: false, feedback: feedback ?? "generation returned nothing" };
  if (c.stationType !== "interpretation" || c.stimulus.kind !== "abg") {
    return { ok: false, feedback: `stationType must be "interpretation" with stimulus.kind "abg".` };
  }
  return { ok: true, case: c };
}

async function generateAbgStations(count: number): Promise<void> {
  const existing = readExistingCases();
  const seenDiagnoses = new Set(existing.map((c) => normalizeDiagnosis(c.diagnosis)).filter(Boolean));

  // Rotate through archetypes for variety; each archetype has a fixed diagnosis,
  // so anything already in bank/drafts is excluded up front (dedupe guard).
  const pool = ABG_ARCHETYPES.filter((a) => !seenDiagnoses.has(normalizeDiagnosis(a.diagnosis)));
  if (pool.length === 0) {
    fail("Every ABG archetype's diagnosis already exists in cases/bank + cases/drafts — nothing to generate.");
  }
  if (pool.length < count) {
    console.warn(`(!) Only ${pool.length} unused ABG archetype(s) available — generating ${pool.length} instead of ${count}.`);
  }
  const targets = pool.slice(0, count);

  const client = createAnthropicClient();
  const systemPrompt = buildSystemPrompt();
  let sequence = nextSequence("interp-abg", existing);
  let written = 0;
  let discarded = 0;

  for (let i = 0; i < targets.length; i++) {
    const archetype = targets[i];
    console.log(`[${i + 1}/${targets.length}] archetype: ${archetype.id}`);
    try {
      // Deterministic generation + physiology validation happens here, in code.
      const gen = generateAbg(archetype.id);
      const userPrompt = buildUserPrompt(gen);

      const first = await generateStructured(client, systemPrompt, userPrompt, InterpretationCaseSchema);
      let result = validateGenerated(first.data, first.feedback);
      if (!result.ok) {
        console.log(`        first attempt rejected — retrying once with feedback`);
        const retry = await generateStructured(
          client,
          systemPrompt,
          `${userPrompt}\n\nYour previous attempt was rejected. ${result.feedback}\n\nOutput the corrected complete case.`,
          InterpretationCaseSchema,
        );
        result = validateGenerated(retry.data, retry.feedback);
      }
      if (!result.ok || !result.case) {
        discarded++;
        console.error(`        DISCARDED after retry:\n${result.feedback}`);
        continue;
      }

      const c = result.case;

      // Re-verify the values were echoed unchanged; if not, restore them.
      if (!c.stimulus.values || !valuesMatch(gen.values, c.stimulus.values)) {
        console.warn("        (!) model altered the ABG values — restoring the validated originals");
        c.stimulus.values = gen.values;
      }
      if (c.diagnosis !== gen.archetype.diagnosis) {
        console.warn("        (!) model altered the diagnosis — restoring the archetype diagnosis");
      }

      const id = `interp-abg-${String(sequence).padStart(3, "0")}-${diagnosisSlug(gen.archetype.diagnosis)}`;
      const final = OsceCaseSchema.parse({
        ...c,
        id,
        diagnosis: gen.archetype.diagnosis,
        discipline: gen.archetype.discipline,
        commonness: gen.archetype.commonness,
        difficulty: gen.archetype.difficulty,
        stimulus: { ...c.stimulus, values: gen.values, imagePath: null },
      });

      const path = writeDraft(id, final);
      sequence++;
      written++;
      console.log(`        WROTE ${path}`);
      console.log(`        ${final.diagnosis}`);
    } catch (err) {
      discarded++;
      console.error(`        DISCARDED: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone: ${written} draft(s) written, ${discarded} discarded.`);
  console.log("Review at /admin/review — nothing enters cases/bank without approval.");
  if (written === 0) process.exit(1);
}

async function main(): Promise<void> {
  const { kind, count } = parseCliArgs();
  if (kind === "ecg" || kind === "cxr") {
    console.log(
      `${kind}: requires reviewed images in /public/stimuli — none available; skipping. ` +
        `(Never fake a stimulus — promote reviewed images from /grounding/stimuli-candidates/ first, CLAUDE.md §4b.)`,
    );
    return;
  }
  await generateAbgStations(count);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
