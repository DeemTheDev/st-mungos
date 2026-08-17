// Stage C — clinical case generation (CLAUDE.md §5).
// Usage: tsx scripts/generate-cases.ts --system resp --count 5 [--uncommon]
//
// Per case: pick a KB topic for the requested system (rotating for variety),
// pick the target diagnosis IN CODE from the per-system pool (excluding
// everything already in bank/drafts — no dedupe-collision waste), then hand
// both to lib/library/generate-job.ts, which owns the prompts, the
// structured-outputs call and the validate-then-retry loop and is the same
// code POST /api/cases/job/[id]/step runs.
//
// This script keeps the LOCAL half: the KB index on disk, cases/bank +
// cases/drafts scanning, and writing cases/drafts/<id>.json. Nothing reaches
// the bank unreviewed.

try {
  process.loadEnvFile(".env.local");
} catch {
  console.warn("(!) .env.local not found — relying on ambient environment variables");
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DisciplineSchema, OsceCaseSchema, type Discipline } from "../lib/case-schema";
import {
  buildCaseSystemPrompt,
  generateOneCase,
  pickDiagnosis,
  usedDiagnoses,
} from "../lib/library/generate-job";
import {
  BANK_DIR,
  EPI_BRIEF_PATH,
  KB_DIR,
  KB_INDEX_PATH,
  createAnthropicClient,
  diagnosisSlug,
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
  const seenDiagnoses = usedDiagnoses(existing.map((c) => c.diagnosis));

  const client = createAnthropicClient();
  const systemPrompt = buildCaseSystemPrompt(seedCaseJson, epidemiologyBrief);
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
          `Add entries to the pool in lib/library/generate-job.ts to generate more.`,
      );
      break;
    }
    console.log(`[${i + 1}/${count}] topic: ${topic.slug} → ${diagnosis}`);
    try {
      const result = await generateOneCase({
        client,
        systemPrompt,
        topic,
        system,
        commonness,
        diagnosis,
        log: (line) => console.log(line),
      });

      if (!result.ok) {
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
  console.log(`Review at /review — nothing enters cases/bank without approval.`);
  if (written === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
