// Stage A — ingest & normalise (CLAUDE.md §5).
// Handles .pdf and .md sources in /grounding, splits them into per-topic
// sections and writes normalized markdown to grounding/normalized/<source>/.
// Incremental via grounding/manifest.json (source sha256 → outputs).
//
// NOTE: image extraction from PDFs (stimuli candidates for §4b) is deferred —
// this pass extracts text only.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { extractText, getDocumentProxy } from "unpdf";

import { loadManifest, saveManifest, sha256 } from "./manifest";
import type { IngestSourceReport, Manifest, NormalizedSection } from "./types";

const MIN_SECTION_CHARS = 500;
const FALLBACK_CHUNK_PAGES = 8;

/** Files in /grounding that are never treated as sources. */
const IGNORED_FILES = new Set(["claude.md", "_epidemiology-kzn.md", "manifest.json"]);
const IGNORED_EXTENSIONS = new Set([".glb", ".json"]);

// ---------------------------------------------------------------------------
// slug / title helpers
// ---------------------------------------------------------------------------

const KEEP_UPPER = new Set([
  "TB", "PTB", "MDR", "XDR", "HIV", "AIDS", "COPD", "CCF", "ECG", "EEG", "PCP", "PJP",
  "DKA", "HHS", "GORD", "UTI", "CKD", "AKI", "IBD", "GBS", "RHD", "ILD", "OSCE", "KZN",
  "SA", "ART", "IRIS", "HAART", "LFT", "LFTS", "GI", "CVA", "TIA", "HT", "II", "III",
]);

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60)
    .replace(/-+$/, "") || "section";
}

/** "1. DIABETES MELLITUS" → "Diabetes Mellitus"; keeps clinical acronyms upper-case. */
export function cleanTitle(raw: string): string {
  const stripped = raw
    .replace(/^#+\s*/, "")
    .replace(/^[\d]+[.)]?\s+/, "")
    .replace(/^[A-Z][.)]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "Untitled";
  const isShouting = stripped === stripped.toUpperCase() && /[A-Z]/.test(stripped);
  if (!isShouting) return stripped;
  return stripped
    .split(" ")
    .map((word) => {
      const bare = word.replace(/[^A-Z0-9]/g, "");
      if (KEEP_UPPER.has(bare)) return word;
      return word.charAt(0) + word.slice(1).toLowerCase();
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// splitting
// ---------------------------------------------------------------------------

interface RawSection {
  title: string;
  body: string;
}

function mergeTinySections(sections: RawSection[]): RawSection[] {
  const merged: RawSection[] = [];
  for (const section of sections) {
    if (section.body.trim().length < MIN_SECTION_CHARS && merged.length > 0) {
      // merge tiny sections into their parent (the preceding section)
      const parent = merged[merged.length - 1];
      parent.body += `\n\n## ${section.title}\n\n${section.body.trim()}\n`;
    } else {
      merged.push({ ...section });
    }
  }
  // a tiny leading section with nothing before it merges forward instead
  if (merged.length > 1 && merged[0].body.trim().length < MIN_SECTION_CHARS) {
    const [first, second, ...rest] = merged;
    return [{ title: second.title, body: `${first.body.trim()}\n\n${second.body}` }, ...rest];
  }
  return merged;
}

/** Split a markdown file by top-level headings (h2 fallback when too few h1s). */
export function splitMarkdown(content: string, sourceName: string): { sections: RawSection[]; strategy: string } {
  const lines = content.split(/\r?\n/);
  const h1Count = lines.filter((l) => /^#\s+\S/.test(l)).length;
  const headingRe = h1Count >= 3 ? /^#\s+(\S.*)/ : /^##\s+(\S.*)/;
  const strategy = h1Count >= 3 ? "markdown-h1" : "markdown-h2";

  const sections: RawSection[] = [];
  let current: RawSection = { title: cleanTitle(basename(sourceName, extname(sourceName))), body: "" };
  for (const line of lines) {
    const match = line.match(headingRe);
    if (match) {
      if (current.body.trim()) sections.push(current);
      current = { title: cleanTitle(match[1]), body: `${line}\n` };
    } else {
      current.body += `${line}\n`;
    }
  }
  if (current.body.trim()) sections.push(current);
  return { sections: mergeTinySections(sections), strategy };
}

interface PdfChapterBoundary {
  page: number; // 0-based index of the chapter's first page
  title: string;
}

function firstLine(pageText: string): string {
  return pageText.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/** "Approach to ..." headings at the start of a line within the top of a page. */
function detectApproachHeadings(pages: string[]): PdfChapterBoundary[] {
  const boundaries: PdfChapterBoundary[] = [];
  for (let i = 0; i < pages.length; i++) {
    const head = pages[i].slice(0, 300);
    const match = head.match(/(?:^|\n)\s*((?:a systematic |an? )?approach to\s+[^\n]{3,80})/i);
    if (match) boundaries.push({ page: i, title: match[1].trim() });
  }
  return boundaries;
}

/** ALL-CAPS topic headings as the first line of a page (e.g. "PULMONARY TB"). */
function detectCapsHeadings(pages: string[]): PdfChapterBoundary[] {
  const boundaries: PdfChapterBoundary[] = [];
  for (let i = 0; i < pages.length; i++) {
    const line = firstLine(pages[i]);
    if (line.length < 3 || line.length > 80) continue;
    const letters = line.replace(/[^a-zA-Z]/g, "");
    if (letters.length < 3) continue;
    const upper = line.replace(/[^A-Z]/g, "");
    if (upper.length / letters.length < 0.9) continue;
    boundaries.push({ page: i, title: line });
  }
  return boundaries;
}

async function detectOutline(pdf: PdfDocument): Promise<PdfChapterBoundary[]> {
  try {
    const outline = await pdf.getOutline();
    if (!outline || outline.length === 0) return [];
    const boundaries: PdfChapterBoundary[] = [];
    for (const item of outline) {
      let dest = item.dest;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest) || dest.length === 0) continue;
      const pageIndex = (await pdf.getPageIndex(dest[0])) as number;
      boundaries.push({ page: pageIndex, title: String(item.title ?? "").trim() || `Page ${pageIndex + 1}` });
    }
    boundaries.sort((a, b) => a.page - b.page);
    return boundaries.filter((b, i, arr) => i === 0 || b.page > arr[i - 1].page);
  } catch {
    return [];
  }
}

function chaptersFromBoundaries(pages: string[], boundaries: PdfChapterBoundary[]): RawSection[] {
  const sections: RawSection[] = [];
  if (boundaries.length === 0 || boundaries[0].page > 0) {
    const endPage = boundaries.length > 0 ? boundaries[0].page : pages.length;
    const body = pages.slice(0, endPage).join("\n\n");
    sections.push({ title: cleanTitle(firstLine(body) || "Front matter"), body });
  }
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].page;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].page : pages.length;
    sections.push({ title: cleanTitle(boundaries[i].title), body: pages.slice(start, end).join("\n\n") });
  }
  return sections;
}

function fixedChunks(pages: string[]): RawSection[] {
  const sections: RawSection[] = [];
  for (let start = 0; start < pages.length; start += FALLBACK_CHUNK_PAGES) {
    const chunk = pages.slice(start, start + FALLBACK_CHUNK_PAGES);
    const title = cleanTitle(firstLine(chunk.join("\n")) || `Pages ${start + 1}-${start + chunk.length}`);
    sections.push({ title, body: chunk.join("\n\n") });
  }
  return sections;
}

// Minimal structural view of pdfjs's PDFDocumentProxy (what we use of it).
interface PdfOutlineItem { title: string; dest: unknown }
interface PdfDocument {
  numPages: number;
  getOutline(): Promise<PdfOutlineItem[] | null>;
  getDestination(id: string): Promise<unknown>;
  getPageIndex(ref: unknown): Promise<number>;
}

/**
 * Split a PDF into chapters. Detection chain:
 *  1. "Approach to ..." headings (case-insensitive, start-of-line) — used when ≥10 hits.
 *  2. PDF outline/bookmarks via unpdf, when present.
 *  3. ALL-CAPS first-line topic headings (the Approach-To-Everything PDF marks every
 *     chapter this way — COPD / ASTHMA / PULMONARY TB / ... — so this recovers real
 *     chapter boundaries where 1 and 2 come up empty).
 *  4. Fixed 8-page chunks, first line as title.
 */
export async function splitPdf(buffer: Uint8Array): Promise<{ sections: RawSection[]; strategy: string }> {
  const pdf = (await getDocumentProxy(buffer, { verbosity: 0 } as never)) as unknown as PdfDocument;
  const { text } = await extractText(pdf as never, { mergePages: false });
  const pages = (text as string[]).map((p) => p ?? "");

  const approach = detectApproachHeadings(pages);
  if (approach.length >= 10) {
    return { sections: mergeTinySections(chaptersFromBoundaries(pages, approach)), strategy: "approach-headings" };
  }

  const outline = await detectOutline(pdf);
  if (outline.length >= 3) {
    return { sections: mergeTinySections(chaptersFromBoundaries(pages, outline)), strategy: "pdf-outline" };
  }

  const caps = detectCapsHeadings(pages);
  if (caps.length >= 3) {
    return { sections: mergeTinySections(chaptersFromBoundaries(pages, caps)), strategy: "caps-headings" };
  }

  return { sections: mergeTinySections(fixedChunks(pages)), strategy: "fixed-8-page-chunks" };
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

function frontmatter(source: string, title: string): string {
  const safeTitle = title.replace(/"/g, "'");
  return `---\nsource: ${source}\ntitle: "${safeTitle}"\n---\n\n`;
}

function listSourceFiles(groundingDir: string): string[] {
  return readdirSync(groundingDir)
    .filter((name) => {
      const full = join(groundingDir, name);
      if (!statSync(full).isFile()) return false;
      if (IGNORED_FILES.has(name.toLowerCase())) return false;
      const ext = extname(name).toLowerCase();
      if (IGNORED_EXTENSIONS.has(ext)) return false;
      return ext === ".pdf" || ext === ".md";
    })
    .sort();
}

export async function ingestGrounding(groundingDir: string): Promise<IngestSourceReport[]> {
  const manifest = loadManifest(groundingDir);
  const reports: IngestSourceReport[] = [];

  for (const source of listSourceFiles(groundingDir)) {
    const fullPath = join(groundingDir, source);
    const raw = readFileSync(fullPath);
    const sourceSha = sha256(raw);

    const existing = manifest.sources[source];
    if (existing && existing.sha256 === sourceSha) {
      reports.push({ source, status: "unchanged", sections: existing.outputs.length });
      continue;
    }

    const sourceSlug = slugify(basename(source, extname(source)));
    const outDir = join(groundingDir, "normalized", sourceSlug);

    // re-ingest: drop previous outputs for this source
    if (existing) {
      for (const rel of existing.outputs) {
        rmSync(join(groundingDir, rel), { force: true });
        delete manifest.sections[rel];
      }
    }
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const ext = extname(source).toLowerCase();
    const { sections, strategy } =
      ext === ".pdf"
        ? await splitPdf(new Uint8Array(raw))
        : splitMarkdown(raw.toString("utf8"), source);

    const outputs: string[] = [];
    const usedSlugs = new Set<string>();
    sections.forEach((section, i) => {
      let slug = slugify(section.title);
      while (usedSlugs.has(slug)) slug = `${slug}-x`;
      usedSlugs.add(slug);
      const fileName = `${String(i + 1).padStart(2, "0")}-${slug}.md`;
      const rel = ["normalized", sourceSlug, fileName].join("/");
      const content = frontmatter(source, section.title) + section.body.trim() + "\n";
      writeFileSync(join(groundingDir, rel), content, "utf8");
      manifest.sections[rel] = { sha256: sha256(content), source, title: section.title };
      outputs.push(rel);
    });

    manifest.sources[source] = { sha256: sourceSha, ingestedAt: new Date().toISOString(), outputs };
    saveManifest(groundingDir, manifest);
    reports.push({ source, status: "ingested", sections: outputs.length, splitStrategy: strategy });
  }

  saveManifest(groundingDir, manifest);
  return reports;
}

// ---------------------------------------------------------------------------
// loading normalized sections back (used by Stage B)
// ---------------------------------------------------------------------------

export function loadNormalizedSections(groundingDir: string, manifest?: Manifest): NormalizedSection[] {
  const m = manifest ?? loadManifest(groundingDir);
  const sections: NormalizedSection[] = [];
  for (const [rel, record] of Object.entries(m.sections)) {
    const full = join(groundingDir, rel);
    if (!existsSync(full)) continue;
    const content = readFileSync(full, "utf8");
    const body = content.replace(/^---\n[\s\S]*?\n---\n+/, "");
    const parts = rel.split("/");
    const sourceSlug = parts[1] ?? "unknown";
    const fileSlug = basename(parts[2] ?? rel, ".md").replace(/^\d+-/, "");
    sections.push({
      relPath: rel,
      sourceSlug,
      sectionSlug: fileSlug,
      title: record.title,
      body,
      sha256: sha256(content),
      isHerNotes: /handbook-kzn/.test(sourceSlug),
    });
  }
  sections.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return sections;
}
