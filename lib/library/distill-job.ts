// Stage A + B as a server-side job (CLAUDE.md §5d): she uploads a study guide
// from her phone, and each poll of POST /api/grounding/job/[id]/step does
// exactly ONE unit of work — split the file, or distil one chapter into one KB
// topic — so nothing ever needs longer than a serverless invocation.
//
//   uploaded → extracting → distilling (chunk n/m) → ready | failed
//
// The prompts are NOT reimplemented here: `buildSystemPrompt` and `distillOne`
// come from lib/kb-pipeline/distill.ts, the same code that produced the 27
// topics already in the KB, and the splitters come from lib/kb-pipeline/ingest.
// This file only supplies the storage-agnostic plumbing around them.
//
// Failure policy mirrors the flashcards job: transient errors (an API hiccup)
// PROPAGATE with the checkpoint untouched, so the next poll retries the same
// chunk; only structurally hopeless documents (a scan, an unsupported type) are
// marked failed, because retrying those forever helps nobody.

import mammoth from "mammoth";
import { join } from "node:path";
import { z } from "zod";

import { DISTILL_MODEL, distillOne, buildSystemPrompt, inferSystem, parseKbFile } from "../kb-pipeline/distill";
import { slugify, splitMarkdown, splitPdf } from "../kb-pipeline/ingest";
import { SYSTEMS, type NormalizedSection, type System } from "../kb-pipeline/types";
import {
  LibraryUserError,
  UnprocessableDocumentError,
  createBudgetGuard,
  type CallUsage,
} from "./budget";
import { createGenerationClient, epidemiologyBrief } from "./generate-job";
import type { JobStepResult, Library, SourceDoc } from "./types";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// A whole guide can be enormous; the per-job budget would stop it anyway, but a
// hard chapter cap keeps the checkpoint (and the bill) predictable.
const MAX_SECTIONS = 60;
// The distil prompt truncates at 100k chars, so storing more in the checkpoint
// would only bloat the row.
const MAX_SECTION_CHARS = 100_000;
// Under this much extracted text, a PDF is a scan, not a document.
const MIN_TEXT_CHARS = 400;
// DOCX/plain text with no headings: split into roughly chapter-sized chunks.
const PLAIN_CHUNK_CHARS = 18_000;

export type UploadKind = "pdf" | "md" | "docx";

export function uploadKind(filename: string): UploadKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  if (lower.endsWith(".docx")) return "docx";
  return null;
}

// ---------------------------------------------------------------------------
// checkpoint
//
// The section bodies live in the checkpoint rather than being re-extracted each
// step: extracting a 300-page PDF costs seconds, and every one of those seconds
// would be spent again on every chunk, inside the same 120s budget as the model
// call. Bodies are capped (above), so the row stays a few hundred KB.

const CheckpointSchema = z.object({
  strategy: z.string(),
  sections: z.array(z.object({ title: z.string(), slug: z.string(), body: z.string() })),
  produced: z.array(z.object({ slug: z.string(), title: z.string() })),
  truncated: z.boolean().default(false),
});
type DistillCheckpoint = z.infer<typeof CheckpointSchema>;

function readCheckpoint(doc: SourceDoc): DistillCheckpoint {
  const parsed = CheckpointSchema.safeParse(doc.checkpoint);
  if (!parsed.success) {
    throw new LibraryUserError(
      `"${doc.filename}" lost its place while processing — upload it again to restart.`,
      409,
    );
  }
  return parsed.data;
}

async function save(library: Library, doc: SourceDoc, patch: Partial<SourceDoc>): Promise<SourceDoc> {
  const next: SourceDoc = { ...doc, ...patch, updatedAt: new Date().toISOString() };
  await library.docs.put(next);
  return next;
}

// ---------------------------------------------------------------------------
// step 1 — extract & plan

interface PlannedSection {
  title: string;
  body: string;
}

function chunkPlainText(text: string, filename: string): PlannedSection[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if (current.length > 0 && current.length + para.length + 2 > PLAIN_CHUNK_CHARS) {
      chunks.push(current);
      current = "";
    }
    current += (current.length > 0 ? "\n\n" : "") + para;
  }
  if (current.trim().length > 0) chunks.push(current);
  const base = filename.replace(/\.[^.]+$/, "");
  return chunks.map((body, i) => ({
    title: chunks.length === 1 ? base : `${base} — part ${i + 1}`,
    body,
  }));
}

async function planSections(
  filename: string,
  bytes: Uint8Array,
): Promise<{ sections: PlannedSection[]; strategy: string }> {
  const kind = uploadKind(filename);
  if (!kind) {
    throw new UnprocessableDocumentError(
      `I can only read .pdf, .md and .docx files, and "${filename}" is none of those.`,
    );
  }

  if (kind === "pdf") {
    const { sections, strategy } = await splitPdf(bytes);
    const totalChars = sections.reduce((sum, s) => sum + s.body.trim().length, 0);
    if (totalChars < MIN_TEXT_CHARS) {
      throw new UnprocessableDocumentError(
        `"${filename}" looks like a scan — there is no text layer to read. ` +
          `An original (non-scanned) export will work.`,
      );
    }
    return { sections, strategy };
  }

  const text =
    kind === "md"
      ? new TextDecoder().decode(bytes)
      : (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value ?? "";
  if (text.trim().length < MIN_TEXT_CHARS) {
    throw new UnprocessableDocumentError(
      `There is almost no readable text in "${filename}" — is it empty, or all images?`,
    );
  }

  const split = splitMarkdown(text.replace(/\r\n/g, "\n"), filename);
  // A .docx carries no markdown headings, so the splitter hands back one giant
  // section — chunk that by size instead of paying for one enormous call.
  if (split.sections.length <= 1 && text.length > PLAIN_CHUNK_CHARS) {
    return { sections: chunkPlainText(text, filename), strategy: "plain-text-chunks" };
  }
  return split;
}

async function extractStep(library: Library, doc: SourceDoc): Promise<JobStepResult> {
  const working = doc.status === "extracting" ? doc : await save(library, doc, { status: "extracting" });

  if (!working.storagePath) {
    return markFailed(library, working, `The uploaded copy of "${working.filename}" is missing — upload it again.`);
  }
  const bytes = await library.docs.getBlob(working.storagePath);
  if (!bytes) {
    return markFailed(library, working, `The uploaded copy of "${working.filename}" is missing — upload it again.`);
  }

  let planned: { sections: PlannedSection[]; strategy: string };
  try {
    planned = await planSections(working.filename, bytes);
  } catch (err) {
    if (err instanceof UnprocessableDocumentError) return markFailed(library, working, err.message);
    throw err; // transient — the next poll retries this same step
  }

  const usable = planned.sections.filter((s) => s.body.trim().length > 0);
  if (usable.length === 0) {
    return markFailed(library, working, `I could not find any readable sections in "${working.filename}".`);
  }
  const truncated = usable.length > MAX_SECTIONS;
  const usedSlugs = new Set<string>();
  const sections = usable.slice(0, MAX_SECTIONS).map((s) => {
    let slug = slugify(s.title);
    while (usedSlugs.has(slug)) slug = `${slug}-x`;
    usedSlugs.add(slug);
    return { title: s.title, slug, body: s.body.slice(0, MAX_SECTION_CHARS) };
  });

  const checkpoint: DistillCheckpoint = { strategy: planned.strategy, sections, produced: [], truncated };
  await save(library, working, {
    status: "distilling",
    progress: { done: 0, total: sections.length },
    checkpoint,
    error: null,
  });

  return {
    status: "distilling",
    progress: { done: 0, total: sections.length },
    message:
      `Read "${working.filename}" and found ${sections.length} topic${sections.length === 1 ? "" : "s"} to distil` +
      (truncated ? ` (the first ${MAX_SECTIONS} — it is a big one).` : "."),
  };
}

async function markFailed(library: Library, doc: SourceDoc, message: string): Promise<JobStepResult> {
  await save(library, doc, { status: "failed", error: message });
  return { status: "failed", progress: doc.progress, message };
}

// ---------------------------------------------------------------------------
// steps 2..n — one chapter, one KB topic

function toNormalizedSection(doc: SourceDoc, section: DistillCheckpoint["sections"][number]): NormalizedSection {
  const sourceSlug = slugify(doc.filename.replace(/\.[^.]+$/, ""));
  return {
    relPath: join("uploads", doc.id, `${section.slug}.md`),
    sourceSlug,
    sectionSlug: section.slug,
    title: section.title,
    body: section.body,
    sha256: "", // resume is tracked on the doc row, not the ingest manifest
    // Everything she uploads herself IS her own study material (§5d), so the
    // distil prompt is told to keep the "Her notes emphasise" section.
    isHerNotes: true,
  };
}

function asSystem(value: string | undefined, title: string, sourceSlug: string): System {
  return value && (SYSTEMS as readonly string[]).includes(value) ? (value as System) : inferSystem(title, sourceSlug);
}

function usageFrom(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): CallUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}

async function distillStep(library: Library, doc: SourceDoc): Promise<JobStepResult> {
  const checkpoint = readCheckpoint(doc);
  const index = doc.progress.done;
  const total = checkpoint.sections.length;
  const section = checkpoint.sections[index];
  if (!section) {
    await save(library, doc, { status: "ready", progress: { done: total, total } });
    return { status: "ready", progress: { done: total, total } };
  }

  const guard = createBudgetGuard(library, doc.id);
  await guard.assertWithinBudget();

  const client = createGenerationClient();
  // groundingDir is only consulted for the epidemiology brief, and we pass that
  // explicitly, so this works identically with or without a grounding/ tree.
  const systemPrompt = buildSystemPrompt(join(process.cwd(), "grounding"), epidemiologyBrief());
  const { markdown, usage } = await distillOne(client, systemPrompt, toNormalizedSection(doc, section), []);
  await guard.record("distill", DISTILL_MODEL, usageFrom(usage));

  const { title, meta } = parseKbFile(markdown);
  const sourceSlug = slugify(doc.filename.replace(/\.[^.]+$/, ""));
  const slug = await uniqueSlug(library, doc, title || section.title, checkpoint);
  await library.kb.upsert({
    slug,
    title: title || section.title,
    system: asSystem(meta.system, title || section.title, sourceSlug),
    content: markdown,
    sourceDoc: doc.id,
    sourceRef: `${section.title} — ${doc.filename}`,
    tokenCount: usage.outputTokens,
    updatedAt: new Date().toISOString(),
  });

  checkpoint.produced.push({ slug, title: title || section.title });
  const done = index + 1;
  const status = done >= total ? "ready" : "distilling";
  await save(library, doc, { status, progress: { done, total }, checkpoint });

  return {
    status,
    progress: { done, total },
    message:
      status === "ready"
        ? `Done — "${doc.filename}" added ${checkpoint.produced.length} knowledge-base topic${checkpoint.produced.length === 1 ? "" : "s"}: ${checkpoint.produced.map((p) => p.title).join(", ")}.`
        : `Distilled "${title || section.title}" (${done} of ${total}).`,
  };
}

/**
 * Re-uploading the same guide should UPDATE its own topics, so a slug this
 * document already owns is reused; a clash with someone else's topic gets a
 * suffix rather than silently overwriting it.
 */
async function uniqueSlug(
  library: Library,
  doc: SourceDoc,
  title: string,
  checkpoint: DistillCheckpoint,
): Promise<string> {
  const base = slugify(title);
  const existing = await library.kb.list();
  const takenByOthers = new Set(
    existing.filter((t) => t.sourceDoc !== doc.id).map((t) => t.slug),
  );
  const takenThisRun = new Set(checkpoint.produced.map((p) => p.slug));
  let slug = base;
  let n = 2;
  while (takenByOthers.has(slug) || takenThisRun.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

// ---------------------------------------------------------------------------

/** One unit of work for one uploaded document. */
export async function runDistillStep(library: Library, docId: string): Promise<JobStepResult> {
  const doc = await library.docs.get(docId);
  if (!doc) throw new LibraryUserError("I can't find that upload.", 404);

  switch (doc.status) {
    case "ready":
      return { status: "ready", progress: doc.progress };
    case "failed":
      return { status: "failed", progress: doc.progress, message: doc.error ?? "Processing failed." };
    case "uploaded":
    case "extracting":
      return extractStep(library, doc);
    case "distilling":
      return distillStep(library, doc);
  }
}
