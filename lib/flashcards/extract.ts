// Text extraction for flashcard uploads (docs/FLASHCARDS.md §1).
// PDF via unpdf, per-page with page anchors (same pattern as lib/kb-pipeline);
// DOCX via mammoth.extractRawText with approximate page anchors by character
// offset. Scanned PDFs (no text layer) are detected and refused with a
// friendly message — OCR is a fast-follow, not an MVP promise.

import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/** Thrown when a PDF has no usable text layer (a scan). */
export class ScanDetectedError extends Error {
  constructor() {
    super(
      "This looks like a scan — the PDF has no text layer to read. " +
        "OCR support is coming; for now, try an original (non-scanned) export.",
    );
    this.name = "ScanDetectedError";
  }
}

/** Thrown for file types the pipeline doesn't handle. */
export class UnsupportedFileError extends Error {
  constructor(filename: string) {
    super(`Unsupported file type: ${filename} — only .pdf and .docx are accepted.`);
    this.name = "UnsupportedFileError";
  }
}

export interface ExtractedPage {
  /** 1-based page number (approximate pseudo-page for DOCX). */
  page: number;
  text: string;
}

export interface ExtractedDocument {
  kind: "pdf" | "docx";
  pages: ExtractedPage[];
  pageCount: number;
  /** True for DOCX, where "pages" are ~2200-char chunks, not print pages. */
  approximatePages: boolean;
}

// A text-layer PDF averages well over 500 chars/page; a scan yields ~0. The
// thresholds are deliberately forgiving of sparse-but-real text (title pages,
// image-heavy pages with captions).
const SCAN_TOTAL_CHARS_MIN = 200;
const SCAN_AVG_CHARS_PER_PAGE_MIN = 25;

/** Approximate characters per DOCX pseudo-page (~a printed page of prose). */
const DOCX_PAGE_CHARS = 2200;

export function fileKind(filename: string): "pdf" | "docx" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  return null;
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 } as never);
  const { text } = await extractText(pdf as never, { mergePages: false });
  const pages: ExtractedPage[] = (text as string[]).map((t, i) => ({
    page: i + 1,
    text: (t ?? "").trim(),
  }));

  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  if (
    pages.length === 0 ||
    totalChars < SCAN_TOTAL_CHARS_MIN ||
    totalChars / pages.length < SCAN_AVG_CHARS_PER_PAGE_MIN
  ) {
    throw new ScanDetectedError();
  }

  return { kind: "pdf", pages, pageCount: pages.length, approximatePages: false };
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractedDocument> {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  const raw = (result.value ?? "").replace(/\r\n/g, "\n").trim();
  if (raw.length < SCAN_TOTAL_CHARS_MIN) {
    throw new Error("No readable text found in the .docx — is it empty or image-only?");
  }

  // Approximate page anchors: pack paragraphs into ~2200-char pseudo-pages so
  // cards still carry usable "roughly here" provenance.
  const paragraphs = raw.split(/\n{2,}/);
  const pages: ExtractedPage[] = [];
  let current = "";
  const flush = () => {
    if (current.trim().length > 0) pages.push({ page: pages.length + 1, text: current.trim() });
    current = "";
  };
  for (const para of paragraphs) {
    if (current.length > 0 && current.length + para.length + 2 > DOCX_PAGE_CHARS) flush();
    current += (current.length > 0 ? "\n\n" : "") + para;
    // A single paragraph longer than several pages still gets split hard.
    while (current.length > DOCX_PAGE_CHARS * 2) {
      pages.push({ page: pages.length + 1, text: current.slice(0, DOCX_PAGE_CHARS * 2).trim() });
      current = current.slice(DOCX_PAGE_CHARS * 2);
    }
  }
  flush();

  return { kind: "docx", pages, pageCount: pages.length, approximatePages: true };
}

export async function extractDocument(filename: string, bytes: Uint8Array): Promise<ExtractedDocument> {
  const kind = fileKind(filename);
  if (kind === "pdf") return extractPdf(bytes);
  if (kind === "docx") return extractDocx(bytes);
  throw new UnsupportedFileError(filename);
}
