// CLI-side plumbing for the Stage C generators (CLAUDE.md §5) and the coverage
// report: case-dir scanning, dedupe normalisation, id sequencing and draft
// writing — everything that only makes sense when cases live on this laptop.
//
// The model-facing half (prompts, the structured-outputs call and its
// grammar-too-large fallback, the diagnosis pool, validation/retry) moved to
// lib/library/generate-job.ts when the pipeline went server-side, so `pnpm
// gen:cases` and POST /api/cases/job/[id]/step run the SAME generator. It is
// re-exported here so the CLI scripts' imports are unchanged.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { OsceCaseSchema, type OsceCase } from "../lib/case-schema";
import { nextSequenceFromIds } from "../lib/library/generate-job";

export {
  GENERATION_MODEL,
  MAX_TOKENS,
  diagnosisSlug,
  formatZodIssues,
  generateStructured,
  normalizeDiagnosis,
} from "../lib/library/generate-job";
export type { StructuredResult } from "../lib/library/generate-job";

export const BANK_DIR = join(process.cwd(), "cases", "bank");
export const DRAFTS_DIR = join(process.cwd(), "cases", "drafts");
export const KB_DIR = join(process.cwd(), "grounding", "kb");
export const KB_INDEX_PATH = join(KB_DIR, "_index.json");
export const EPI_BRIEF_PATH = join(process.cwd(), "grounding", "_epidemiology-kzn.md");

export function loadLocalEnv(): void {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    console.warn("(!) .env.local not found — relying on ambient environment variables");
  }
}

// --------------------------------------------------------------------------
// existing-case scanning (dedupe + id sequencing)

export interface ExistingCaseInfo {
  file: string;
  dir: "bank" | "drafts";
  id: string;
  diagnosis: string;
  presentingComplaint: string | null;
  parsed: OsceCase | null; // null when the JSON doesn't (yet) pass the schema
  raw: unknown;
}

export function readExistingCases(): ExistingCaseInfo[] {
  const out: ExistingCaseInfo[] = [];
  for (const dir of ["bank", "drafts"] as const) {
    const abs = dir === "bank" ? BANK_DIR : DRAFTS_DIR;
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs).filter((f) => f.endsWith(".json"))) {
      try {
        const raw: unknown = JSON.parse(readFileSync(join(abs, file), "utf8"));
        const loose = raw as Record<string, unknown>;
        const result = OsceCaseSchema.safeParse(raw);
        out.push({
          file,
          dir,
          id: typeof loose.id === "string" ? loose.id : file.replace(/\.json$/, ""),
          diagnosis: typeof loose.diagnosis === "string" ? loose.diagnosis : "",
          presentingComplaint:
            typeof loose.presentingComplaint === "string" ? loose.presentingComplaint : null,
          parsed: result.success ? result.data : null,
          raw,
        });
      } catch {
        console.warn(`(!) cases/${dir}/${file} is not valid JSON — ignoring for dedupe/sequence purposes`);
      }
    }
  }
  return out;
}

/** Next NNN for ids shaped `<prefix>-NNN-...` across bank + drafts. */
export function nextSequence(prefix: string, existing: ExistingCaseInfo[]): number {
  return nextSequenceFromIds(prefix, existing.map((c) => c.id));
}

// --------------------------------------------------------------------------
// Anthropic

export function createAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set (expected in .env.local). Aborting.");
    process.exit(1);
  }
  return new Anthropic();
}

// --------------------------------------------------------------------------
// output

export function writeDraft(id: string, data: OsceCase): string {
  mkdirSync(DRAFTS_DIR, { recursive: true });
  const path = join(DRAFTS_DIR, `${id}.json`);
  if (existsSync(path)) throw new Error(`draft ${id}.json already exists — refusing to overwrite`);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  return path;
}
