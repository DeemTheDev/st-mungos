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
// Sonnet 5 intro pricing (USD per MTok) through 2026-08-31 — same table as
// lib/kb-pipeline/distill.ts. Used only for the per-call budget log below.
const PRICE_IN = 2;
const PRICE_OUT = 10;
const PRICE_CACHE_WRITE = PRICE_IN * 1.25;
const PRICE_CACHE_READ = PRICE_IN * 0.1;
let runCostUsd = 0;
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

function logUsage(response: Anthropic.Message): void {
  const u = response.usage;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cost =
    (u.input_tokens * PRICE_IN + cacheWrite * PRICE_CACHE_WRITE + cacheRead * PRICE_CACHE_READ + u.output_tokens * PRICE_OUT) /
    1_000_000;
  runCostUsd += cost;
  console.log(
    `        [usage] in ${u.input_tokens} | cache write ${cacheWrite} read ${cacheRead} | out ${u.output_tokens} | $${cost.toFixed(4)} (run total $${runCostUsd.toFixed(4)})`,
  );
}

// Pretty-printed JSON burns ~40% more output tokens than compact JSON, so the
// fallback demands minified output and gets extra headroom over MAX_TOKENS
// (only tokens actually generated are billed — headroom is free insurance).
const FALLBACK_MAX_TOKENS = 16000;

/** Plain-call fallback: prompted JSON, parsed + validated client-side. */
async function generateUnstructured<T>(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string,
  schema: ZodType<T>,
): Promise<StructuredResult<T>> {
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
  logUsage(response);
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
 */
export async function generateStructured<T>(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string,
  schema: ZodType<T>,
): Promise<StructuredResult<T>> {
  if (grammarTooLargeSchemas.has(schema)) {
    return generateUnstructured(client, systemPrompt, userPrompt, schema);
  }
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
      return generateUnstructured(client, systemPrompt, userPrompt, schema);
    }
    // messages.parse throws a plain AnthropicError (not an APIError) when the
    // response fails the client-side Zod backstop — its message carries the
    // formatted issues, which is exactly the retry feedback we want.
    if (err instanceof AnthropicError && !(err instanceof APIError) && /Failed to parse structured output/.test(err.message)) {
      return { data: null, feedback: err.message };
    }
    throw err;
  }

  // Budget log (task mandate): token usage + estimated cost after every call.
  logUsage(response);

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
