// Stage B — distil normalized sections into the KB (CLAUDE.md §5).
// One claude-sonnet-5 call per chapter/section → grounding/kb/<topic-slug>.md
// with a fixed structure, plus grounding/kb/_index.json.
// Incremental + resumable via grounding/manifest.json.

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadNormalizedSections, slugify } from "./ingest";
import { loadManifest, saveManifest, sha256 } from "./manifest";
import { SYSTEMS } from "./types";
import type { KbIndexEntry, Manifest, NormalizedSection, System, UsageRecord } from "./types";

export const DISTILL_MODEL = "claude-sonnet-5";
const MAX_OUTPUT_TOKENS = 6000;
const MAX_SECTION_CHARS = 100_000; // truncate oversized inputs at ~100k chars
const MAX_HER_NOTES_CHARS = 20_000; // per matched her-notes excerpt
const MAX_HER_NOTES_MATCHES = 2;

// Sonnet 5 intro pricing (USD per MTok) through 2026-08-31; cache write 1.25x, read 0.1x.
const PRICE_IN = 2;
const PRICE_OUT = 10;
const PRICE_CACHE_WRITE = PRICE_IN * 1.25;
const PRICE_CACHE_READ = PRICE_IN * 0.1;

// ---------------------------------------------------------------------------
// system prompt (stable bytes → prompt-cached across calls)
// ---------------------------------------------------------------------------

const FIXED_STRUCTURE = `# <Topic>
<!-- meta: {"system": "...", "keywords": [...]} -->   <- single line, directly under the title (see rules)
## Framework
## Ranked differentials
## Red flags
## Key history questions
## Examination findings
## Investigations
## Management outline
## Pathophys pearls
## KZN/SA notes
## Her notes emphasise   <- include ONLY when her-notes material is available (see rules)`;

/**
 * `epidemiologyOverride` exists for the server pipeline: grounding/ is
 * gitignored, so the brief file is absent in production — the caller supplies
 * the bundled fallback instead (lib/library/generate-job.ts).
 */
export function buildSystemPrompt(groundingDir: string, epidemiologyOverride?: string): string {
  const epiPath = join(groundingDir, "_epidemiology-kzn.md");
  const epidemiology =
    epidemiologyOverride ??
    (existsSync(epiPath) ? readFileSync(epiPath, "utf8").trim() : "(no epidemiology brief found)");

  return `You are a senior internal-medicine registrar at a KwaZulu-Natal teaching hospital, distilling clinical study material into a structured knowledge base for a 4th-year UKZN medical student preparing for her end-of-block OSCE.

You receive ONE chapter or section of source material inside <source> tags, and sometimes excerpts from the student's own lecture-note handbooks inside <her_notes> tags. Distil it into a single markdown document with EXACTLY this heading structure, in this order:

${FIXED_STRUCTURE}

Section content requirements:
- "Framework": a stepwise, numbered approach to the presenting problem or topic — the systematic method she should verbalise in the station (symptom → differential, never diagnosis-first).
- "Ranked differentials": ordered list, most likely first for the KZN case-mix, each with one line of "for/against" reasoning. If the topic is a single disease, rank the differentials for its cardinal presentation.
- "Red flags": findings that demand immediate action or escalate the differential.
- "Key history questions": the questions an examiner expects her to ask, grouped logically; include the discriminating ones, not a generic template.
- "Examination findings": what to look for and what each finding means.
- "Investigations": first-line tests first, then confirmatory/second-line, each with the finding that matters. Public-hospital lens.
- "Management outline": immediate → definitive → supportive → follow-up, grounded in SA practice (SA EML / Adult Hospital Level STGs, SA TB and HIV/ART guidelines, WHO clinical staging). Include drug names and standard regimens only when supported by the source or standard SA guidance — never invent doses.
- "Pathophys pearls": symptom → mechanism explanations an examiner probes ("why does she get night sweats?").
- "KZN/SA notes": local epidemiology, guideline and resource-context points for this topic.
- "Her notes emphasise": ONLY when her-notes material is available. Two cases: (a) <her_notes> excerpts were provided alongside the source; (b) the <source> itself is from one of her KZN handbook notes (the message will say so). Capture what her lecturers actually stressed — repeated points, mnemonics, tables, "NB" markers, exam cribs. This section is weighted heavily downstream, so make it specific. If neither case applies, OMIT the heading entirely.

Rules:
- Stay strictly within the supplied material plus uncontroversial standard SA clinical practice. Do not import exotic differentials or first-world-only investigations.
- Be dense and specific: short bullets, concrete numbers/criteria/scores from the source, no filler prose, no preamble before the title.
- LENGTH BUDGET (hard): the whole document must fit in well under 6000 output tokens — target 1200-1500 words, never more than ~1800. Completing EVERY section matters more than exhaustiveness: be selective (≤8 framework steps, ≤6 differentials, ≤8 bullets per remaining section) and never run out of space before "KZN/SA notes". If the source covers several presenting problems in one chapter, compress each into a few lines under the shared headings instead of covering each in full depth.
- Weight everything toward the KZN case-mix described below.
- Directly under the "# <Topic>" line (before "## Framework"), output exactly one machine-read line in this form (valid JSON):
<!-- meta: {"system": "<one of: resp|cardio|gi-hep|endo|neuro|renal|haem|id|rheum>", "keywords": ["6-12 lowercase search keywords: cardinal symptoms, key differentials, key tests"]} -->

KZN epidemiology and practice grounding (apply throughout):

${epidemiology}`;
}

// ---------------------------------------------------------------------------
// her-notes matching (slug/keyword overlap between normalized sources)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "and", "approach", "acute", "cardinal", "chapter", "chronic", "disease",
  "diseases", "disorder", "disorders", "in", "integration", "its", "management", "of",
  "on", "or", "sign", "signs", "symptom", "symptoms", "syndrome", "syndromes", "the",
  "to", "with",
]);

const SYNONYMS: Record<string, string> = {
  tuberculosis: "tb", ptb: "tb", epilepsy: "seizure", seizures: "seizure", fits: "seizure",
  cva: "stroke", icterus: "jaundice", ketoacidosis: "dka", reflux: "gord",
  hepatic: "liver", renal: "kidney", nephropathy: "kidney",
};

function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  for (let word of title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)) {
    if (!word || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    if (word.length > 4 && word.endsWith("s")) word = word.slice(0, -1);
    tokens.add(SYNONYMS[word] ?? word);
  }
  return tokens;
}

/** Find her-notes sections (KZN handbooks) covering the same topic as `section`. */
export function matchHerNotes(section: NormalizedSection, all: NormalizedSection[]): NormalizedSection[] {
  const tokens = titleTokens(section.title);
  if (tokens.size === 0) return [];
  const scored = all
    .filter((s) => s.isHerNotes && s.relPath !== section.relPath && s.sourceSlug !== section.sourceSlug)
    .map((s) => {
      let score = 0;
      for (const token of titleTokens(s.title)) if (tokens.has(token)) score++;
      return { section: s, score };
    })
    .filter((entry) => entry.score >= 1)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_HER_NOTES_MATCHES).map((entry) => entry.section);
}

// ---------------------------------------------------------------------------
// index building
// ---------------------------------------------------------------------------

const SOURCE_SYSTEM_HINTS: Array<[RegExp, System]> = [
  [/endocrinology/, "endo"],
  [/gastroenterology/, "gi-hep"],
  [/nephrology/, "renal"],
  [/neurology/, "neuro"],
  [/respiratory/, "resp"],
];

const TITLE_SYSTEM_HINTS: Array<[RegExp, System]> = [
  [/\b(tb|tuberculosis|pneumo|asthma|copd|pleural|lung|respiratory|cough|dyspnoea)\b/i, "resp"],
  [/\b(cardiac|heart|ccf|hypertension|ecg|murmur|angina|arrhythm)\b/i, "cardio"],
  [/\b(liver|jaundice|hepat|gastro|bowel|pancrea|ascites|gi bleed|abdomen)\b/i, "gi-hep"],
  [/\b(diabet|thyroid|adrenal|pituitary|glycaem|dka|endocrine)\b/i, "endo"],
  [/\b(stroke|seizure|epilep|mening|neuro|weakness|paralysis|headache|dementia|delirium)\b/i, "neuro"],
  [/\b(kidney|renal|nephr|dialysis|electrolyte|urinary)\b/i, "renal"],
  [/\b(anaemia|bleeding disorder|lymphadenopathy|splenomegaly|haem)\b/i, "haem"],
  [/\b(hiv|aids|sepsis|infection|malaria)\b/i, "id"],
  [/\b(arthritis|lupus|rheum|vasculitis)\b/i, "rheum"],
];

export interface KbMeta { system?: string; keywords?: string[] }

/** Reads back the meta line the distil prompt is told to emit. */
export function parseKbFile(content: string): { title: string; meta: KbMeta } {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const metaMatch = content.match(/<!--\s*meta:\s*(\{[\s\S]*?\})\s*-->/);
  let meta: KbMeta = {};
  if (metaMatch) {
    try {
      meta = JSON.parse(metaMatch[1]) as KbMeta;
    } catch {
      meta = {};
    }
  }
  return { title: titleMatch ? titleMatch[1].trim() : "Untitled", meta };
}

export function inferSystem(title: string, sourceSlug: string): System {
  for (const [re, system] of SOURCE_SYSTEM_HINTS) if (re.test(sourceSlug)) return system;
  for (const [re, system] of TITLE_SYSTEM_HINTS) if (re.test(title)) return system;
  return "id";
}

/** Rebuild grounding/kb/_index.json from every kb/*.md on disk. */
export function buildKbIndex(groundingDir: string, manifest: Manifest): KbIndexEntry[] {
  const kbDir = join(groundingDir, "kb");
  if (!existsSync(kbDir)) return [];
  const bySlugSource = new Map<string, string>(); // kb file → sourceSlug (via manifest)
  for (const [rel, record] of Object.entries(manifest.distilled)) {
    bySlugSource.set(record.kbFile.replace(/^kb\//, ""), rel.split("/")[1] ?? "");
  }

  const entries: KbIndexEntry[] = [];
  for (const file of readdirSync(kbDir).filter((f) => f.endsWith(".md")).sort()) {
    const content = readFileSync(join(kbDir, file), "utf8");
    const { title, meta } = parseKbFile(content);
    const slug = file.replace(/\.md$/, "");
    const system: System =
      meta.system && (SYSTEMS as readonly string[]).includes(meta.system)
        ? (meta.system as System)
        : inferSystem(title, bySlugSource.get(file) ?? "");
    const keywords =
      Array.isArray(meta.keywords) && meta.keywords.length > 0
        ? meta.keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean)
        : [...titleTokens(title)];
    entries.push({ slug, file, title, system, keywords });
  }
  const indexPath = join(kbDir, "_index.json");
  writeFileSync(indexPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  return entries;
}

// ---------------------------------------------------------------------------
// distillation
// ---------------------------------------------------------------------------

export interface DistillOptions {
  groundingDir: string;
  /** Slug prefixes to include — matched against "<sourceSlug>/<sectionSlug>" and bare section slug. */
  only?: string[];
  limit?: number;
  /** Re-distill even when the manifest says the section is unchanged. */
  force?: boolean;
  log?: (line: string) => void;
}

export interface DistillResult {
  distilled: Array<{ relPath: string; kbFile: string; title: string; usage: UsageRecord }>;
  skipped: number;
  totalCostUsd: number;
  indexEntries: KbIndexEntry[];
}

function matchesOnly(section: NormalizedSection, only: string[] | undefined): boolean {
  if (!only || only.length === 0) return true;
  const full = `${section.sourceSlug}/${section.sectionSlug}`;
  return only.some((prefix) => {
    const p = prefix.toLowerCase().trim();
    return p.length > 0 && (section.sectionSlug.startsWith(p) || full.startsWith(p));
  });
}

function kbSlugFor(section: NormalizedSection, manifest: Manifest): string {
  let slug = section.sectionSlug || slugify(section.title);
  const taken = (candidate: string) =>
    Object.entries(manifest.distilled).some(
      ([rel, record]) => rel !== section.relPath && record.kbFile === `kb/${candidate}.md`,
    );
  if (taken(slug)) slug = `${section.sourceSlug}-${slug}`.slice(0, 80);
  while (taken(slug)) slug = `${slug}-x`;
  return slug;
}

export function buildUserMessage(section: NormalizedSection, herNotes: NormalizedSection[]): string {
  const parts: string[] = [`<topic>${section.title}</topic>`];
  if (section.isHerNotes) {
    parts.push(
      "Note: the <source> below is from the student's OWN KZN handbook lecture notes — it counts as her notes. Include the \"Her notes emphasise\" section.",
    );
  }
  let body = section.body;
  if (body.length > MAX_SECTION_CHARS) {
    body = `${body.slice(0, MAX_SECTION_CHARS)}\n\n[...truncated at ${MAX_SECTION_CHARS} chars]`;
  }
  parts.push(`<source name="${section.sourceSlug}/${section.sectionSlug}">\n${body}\n</source>`);
  for (const notes of herNotes) {
    let excerpt = notes.body;
    if (excerpt.length > MAX_HER_NOTES_CHARS) {
      excerpt = `${excerpt.slice(0, MAX_HER_NOTES_CHARS)}\n\n[...truncated]`;
    }
    parts.push(
      `<her_notes name="${notes.sourceSlug}/${notes.sectionSlug}" title="${notes.title}">\n${excerpt}\n</her_notes>`,
    );
  }
  return parts.join("\n\n");
}

function usageFrom(response: Anthropic.Message): UsageRecord {
  const u = response.usage;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const estCostUsd =
    (u.input_tokens * PRICE_IN +
      cacheWrite * PRICE_CACHE_WRITE +
      cacheRead * PRICE_CACHE_READ +
      u.output_tokens * PRICE_OUT) /
    1_000_000;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    estCostUsd,
  };
}

/** ONE chapter → one KB document. Shared by the CLI and the upload job. */
export async function distillOne(
  client: Anthropic,
  systemPrompt: string,
  section: NormalizedSection,
  herNotes: NormalizedSection[],
): Promise<{ markdown: string; usage: UsageRecord; stopReason: string | null }> {
  const response = await client.messages.create({
    model: DISTILL_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(section, herNotes) }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`model refused to distill "${section.title}"`);
  }
  let markdown = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  // drop any preamble before the title heading
  const h1 = markdown.indexOf("# ");
  if (h1 > 0) markdown = markdown.slice(h1);
  if (!markdown.startsWith("#")) markdown = `# ${section.title}\n\n${markdown}`;
  return { markdown, usage: usageFrom(response), stopReason: response.stop_reason };
}

export async function distillKb(options: DistillOptions): Promise<DistillResult> {
  const { groundingDir } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const manifest = loadManifest(groundingDir);
  const allSections = loadNormalizedSections(groundingDir, manifest);
  const systemPrompt = buildSystemPrompt(groundingDir);
  const client = new Anthropic();

  const pending = allSections.filter((section) => {
    if (!matchesOnly(section, options.only)) return false;
    const record = manifest.distilled[section.relPath];
    if (!options.force && record && record.sectionSha256 === section.sha256) return false;
    return true;
  });
  const limited = typeof options.limit === "number" ? pending.slice(0, options.limit) : pending;
  const skipped = allSections.filter((s) => matchesOnly(s, options.only)).length - limited.length;

  log(`[distill] ${limited.length} section(s) to distill, ${skipped} skipped (already distilled/unchanged)`);

  const kbDir = join(groundingDir, "kb");
  mkdirSync(kbDir, { recursive: true });

  const result: DistillResult = { distilled: [], skipped, totalCostUsd: 0, indexEntries: [] };

  for (let i = 0; i < limited.length; i++) {
    const section = limited[i];
    const herNotes = section.isHerNotes ? [] : matchHerNotes(section, allSections);
    const label = `[${i + 1}/${limited.length}] ${section.sourceSlug}/${section.sectionSlug}`;
    try {
      const { markdown, usage, stopReason } = await distillOne(client, systemPrompt, section, herNotes);
      const slug = kbSlugFor(section, manifest);
      const kbFile = `kb/${slug}.md`;
      writeFileSync(join(groundingDir, kbFile), `${markdown}\n`, "utf8");
      manifest.distilled[section.relPath] = {
        sectionSha256: section.sha256,
        kbFile,
        title: section.title,
        distilledAt: new Date().toISOString(),
        model: DISTILL_MODEL,
        usage,
      };
      saveManifest(groundingDir, manifest); // resumable: persist after every call
      result.distilled.push({ relPath: section.relPath, kbFile, title: section.title, usage });
      result.totalCostUsd += usage.estCostUsd;
      const cacheNote = usage.cacheReadTokens > 0 ? `cache read ${usage.cacheReadTokens}` : `cache write ${usage.cacheWriteTokens}`;
      const truncNote = stopReason === "max_tokens" ? " [WARN hit max_tokens]" : "";
      log(
        `${label} -> ${kbFile}${herNotes.length ? ` (+${herNotes.length} her-notes match)` : ""} | in ${usage.inputTokens} (${cacheNote}) out ${usage.outputTokens} | $${usage.estCostUsd.toFixed(4)} (run total $${result.totalCostUsd.toFixed(4)})${truncNote}`,
      );
    } catch (error) {
      log(`${label} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  result.indexEntries = buildKbIndex(groundingDir, manifest);
  saveManifest(groundingDir, manifest);
  log(`[distill] index rebuilt: ${result.indexEntries.length} topic(s) in kb/_index.json`);
  log(`[distill] run cost estimate: $${result.totalCostUsd.toFixed(4)} (Sonnet 5 intro pricing $2/M in, $10/M out)`);
  return result;
}
