// Shared plumbing for the Stage C generators (CLAUDE.md §5) and the coverage
// report: case-dir scanning, dedupe normalisation, id sequencing, Anthropic
// call shape, and draft writing.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic, { AnthropicError, APIError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodIssue, ZodType } from "zod";
import { OsceCaseSchema, type OsceCase } from "../lib/case-schema";

// Examiner/marking/case-gen model per DECISIONS.md (2026-08-12).
export const GENERATION_MODEL = "claude-sonnet-5";
// Generation is JSON transcription against a fixed schema, not open reasoning —
// thinking is disabled on these calls, so the whole budget belongs to the case
// JSON (~5k tokens) and 8000 has comfortable headroom.
export const MAX_TOKENS = 8000;

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

/** Next NNN for ids shaped `<prefix>-NNN-...` across bank + drafts. */
export function nextSequence(prefix: string, existing: ExistingCaseInfo[]): number {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)`);
  let max = 0;
  for (const c of existing) {
    const m = re.exec(c.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

// --------------------------------------------------------------------------
// LLM response handling

export function formatZodIssues(issues: ZodIssue[]): string {
  return issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
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

/** Result of one structured generation attempt. Exactly one field is set. */
export interface StructuredResult<T> {
  data: T | null;
  /** Retryable client-side validation feedback (refine rules the API-side schema can't express). */
  feedback: string | null;
}

/**
 * One structured-outputs generation call. The JSON *shape* is enforced by the
 * API via `output_config.format` (zodOutputFormat), so shape retries should be
 * rare; refine rules (rubric sum, trigger fatness) are validated client-side by
 * `messages.parse` and surface as retryable `feedback`.
 *
 * The system prompt is static across a run and carries the cache_control
 * breakpoint (prompt-caching: stable prefix in `system`, per-case content in
 * the user message). Thinking is disabled — this is JSON transcription against
 * a fixed schema, not open reasoning.
 */
export async function generateStructured<T>(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string,
  schema: ZodType<T>,
): Promise<StructuredResult<T>> {
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
    // messages.parse throws a plain AnthropicError (not an APIError) when the
    // response fails the client-side Zod backstop — its message carries the
    // formatted issues, which is exactly the retry feedback we want.
    if (err instanceof AnthropicError && !(err instanceof APIError) && /Failed to parse structured output/.test(err.message)) {
      return { data: null, feedback: err.message };
    }
    throw err;
  }

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

// --------------------------------------------------------------------------
// output

export function writeDraft(id: string, data: OsceCase): string {
  mkdirSync(DRAFTS_DIR, { recursive: true });
  const path = join(DRAFTS_DIR, `${id}.json`);
  if (existsSync(path)) throw new Error(`draft ${id}.json already exists — refusing to overwrite`);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  return path;
}
