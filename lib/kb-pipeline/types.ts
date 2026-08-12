// Shared types for the grounding KB pipeline (CLAUDE.md §5 Stage A + B).
// Plain Node library — no Next.js imports anywhere in lib/kb-pipeline/.

export const SYSTEMS = [
  "resp", "cardio", "gi-hep", "endo", "neuro", "renal", "haem", "id", "rheum",
] as const;
export type System = (typeof SYSTEMS)[number];

export interface SourceRecord {
  sha256: string;
  ingestedAt: string;
  /** Paths relative to the grounding dir, e.g. "normalized/<source>/<nn>-<slug>.md". */
  outputs: string[];
}

export interface SectionRecord {
  sha256: string; // sha of the normalized section file content
  source: string; // original source filename
  title: string;
}

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  estCostUsd: number;
}

export interface DistillRecord {
  sectionSha256: string; // sha of the normalized section at distill time
  kbFile: string; // "kb/<topic-slug>.md" relative to grounding dir
  title: string;
  distilledAt: string;
  model: string;
  usage: UsageRecord;
}

export interface Manifest {
  version: 1;
  /** Keyed by source filename (e.g. "Approach-To-Everything.pdf"). */
  sources: Record<string, SourceRecord>;
  /** Keyed by normalized section path relative to grounding dir. */
  sections: Record<string, SectionRecord>;
  /** Keyed by normalized section path relative to grounding dir. */
  distilled: Record<string, DistillRecord>;
}

/** A normalized section loaded back from disk, ready for distillation. */
export interface NormalizedSection {
  relPath: string; // relative to grounding dir
  sourceSlug: string;
  sectionSlug: string; // filename slug without the nn- prefix
  title: string;
  body: string; // text without frontmatter
  sha256: string;
  /** KZN handbook sections are the student's own notes (CLAUDE.md §5 Stage B). */
  isHerNotes: boolean;
}

export interface KbIndexEntry {
  slug: string;
  file: string; // "<topic-slug>.md" within grounding/kb/
  title: string;
  system: System;
  keywords: string[];
}

export interface IngestSourceReport {
  source: string;
  status: "ingested" | "unchanged";
  sections: number;
  splitStrategy?: string;
}
