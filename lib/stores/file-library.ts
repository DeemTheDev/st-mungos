// Phase 6 library adapters over the local filesystem (STORE=file, the dev
// default — DECISIONS.md 2026-08-12: dev must work with zero services).
// Same ports as the Supabase adapter, over the layout that already exists:
//
//   docs   -> .library/docs/*.json  + blobs in .library/blobs/   (gitignored)
//   kb     -> grounding/kb/*.md + _index.json   (FsKbStore's format, unchanged)
//   cases  -> cases/drafts/*.json = "draft" · cases/bank/*.json = "bank";
//             setStatus moves the file, rejection deletes it (what
//             /admin/review has always done locally)
//   spend  -> .library/spend.jsonl
//
// Two sidecars under .library/ (kb-meta.json, case-meta.json) carry the
// library-only columns — provenance, review notes — that have nowhere to live
// on disk. Keeping them OUT of the KB markdown and the case JSON is
// deliberate: `pnpm distill` rebuilds _index.json from scratch and
// OsceCaseSchema strips unknown keys, so anything stored inline would be
// silently dropped on the next run.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { OsceCaseSchema, type OsceCase } from "../case-schema";
import type {
  Budget,
  CaseLibrary,
  CaseRecord,
  CaseStatus,
  KbLibrary,
  KbTopicRecord,
  Library,
  SourceDoc,
  SourceDocStore,
  SpendEntry,
  SpendLedger,
} from "../library/types";

const DEFAULT_SEARCH_LIMIT = 8;

// ---------------------------------------------------------------------------
// shared helpers (the Supabase adapter reuses the pure ones)

/** Ids and slugs become path segments — refuse anything that could escape. */
function isSafeSegment(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

/**
 * Write paths throw: a bad slug there is a bug in the caller. Read paths use
 * isSafeSegment directly and answer "not found" instead — the slug/id often
 * comes straight off a URL, and a 404 beats a 500 for a typo.
 */
function safeSegment(value: string): string {
  if (!isSafeSegment(value)) throw new Error(`unsafe library id/slug "${value}"`);
  return value;
}

/** Uploaded filenames are user input; they only ever land inside .library/. */
export function safeLibraryFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "upload";
}

/** ~4 chars per token. Display and budget arithmetic only — never billing. */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function titleKeywords(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2),
    ),
  ];
}

interface KbMarkdownMeta {
  title: string;
  system: string | null;
  keywords: string[];
}

/**
 * The distiller writes `# Title` followed by a one-line
 * `<!-- meta: {"system": ..., "keywords": [...]} -->` (lib/kb-pipeline/distill.ts).
 * Both library adapters read topics back out of that, so a topic keeps its
 * system and keywords no matter which store it round-trips through.
 */
export function parseKbMarkdown(content: string, fallbackTitle: string): KbMarkdownMeta {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const metaMatch = content.match(/<!--\s*meta:\s*(\{[\s\S]*?\})\s*-->/);
  let system: string | null = null;
  let keywords: string[] = [];
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]) as { system?: unknown; keywords?: unknown };
      if (typeof meta.system === "string" && meta.system.trim()) system = meta.system.trim();
      if (Array.isArray(meta.keywords)) {
        keywords = meta.keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean);
      }
    } catch {
      // A hand-edited meta line is not worth failing a read over.
    }
  }
  const title = titleMatch ? titleMatch[1].trim() : fallbackTitle;
  return { title, system, keywords: keywords.length > 0 ? keywords : titleKeywords(title) };
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    console.warn(`(!) ${path} is not valid JSON — treating it as empty`);
    return fallback;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileCreatedAt(path: string): string {
  const stat = statSync(path);
  // birthtime is 0 on some Linux filesystems; mtime is the honest fallback.
  return new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
}

/** Windows can refuse a rename over an existing file — replace explicitly. */
function movePath(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    if (existsSync(to)) unlinkSync(to);
    renameSync(from, to);
  }
}

// ---------------------------------------------------------------------------
// source documents

export class FileSourceDocStore implements SourceDocStore {
  constructor(private readonly base: string) {}

  private docsDir(): string {
    return join(this.base, "docs");
  }

  private pathFor(id: string): string {
    return join(this.docsDir(), `${safeSegment(id)}.json`);
  }

  async put(doc: SourceDoc): Promise<void> {
    mkdirSync(this.docsDir(), { recursive: true });
    writeFileSync(this.pathFor(doc.id), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }

  async get(id: string): Promise<SourceDoc | null> {
    if (!isSafeSegment(id)) return null;
    const path = this.pathFor(id);
    if (!existsSync(path)) return null;
    return readJsonFile<SourceDoc | null>(path, null);
  }

  async list(): Promise<SourceDoc[]> {
    const dir = this.docsDir();
    if (!existsSync(dir)) return [];
    const out: SourceDoc[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const doc = readJsonFile<SourceDoc | null>(join(dir, file), null);
      if (doc) out.push(doc);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async putBlob(id: string, filename: string, bytes: Uint8Array): Promise<string> {
    const dir = join(this.base, "blobs");
    mkdirSync(dir, { recursive: true });
    // Returned path is relative to .library/, mirroring the Supabase object key
    // — a stored SourceDoc.storagePath then means the same thing in both modes.
    const relative = `blobs/${safeSegment(id)}__${safeLibraryFilename(filename)}`;
    writeFileSync(join(this.base, relative), bytes);
    return relative;
  }

  async getBlob(storagePath: string): Promise<Uint8Array | null> {
    const absolute = resolve(this.base, storagePath);
    // storagePath is data, not code: it comes back off a stored row and must
    // never be able to read outside .library/.
    if (!absolute.startsWith(resolve(this.base) + sep)) return null;
    if (!existsSync(absolute)) return null;
    return new Uint8Array(readFileSync(absolute));
  }
}

// ---------------------------------------------------------------------------
// knowledge base

/** Exactly FsKbStore's / buildKbIndex's entry shape — do not widen. */
interface KbIndexEntry {
  slug: string;
  file: string;
  title: string;
  system: string;
  keywords: string[];
}

interface KbMetaEntry {
  sourceDoc: string | null;
  sourceRef: string | null;
  tokenCount: number;
  updatedAt: string;
}

export class FileKbLibrary implements KbLibrary {
  constructor(
    private readonly dir: string,
    private readonly metaPath: string,
  ) {}

  private indexPath(): string {
    return join(this.dir, "_index.json");
  }

  private readIndex(): KbIndexEntry[] {
    return readJsonFile<KbIndexEntry[]>(this.indexPath(), []);
  }

  private readMeta(): Record<string, KbMetaEntry> {
    return readJsonFile<Record<string, KbMetaEntry>>(this.metaPath, {});
  }

  private toRecord(file: string, entry: KbIndexEntry | undefined, meta: Record<string, KbMetaEntry>): KbTopicRecord {
    const slug = entry?.slug ?? file.replace(/\.md$/, "");
    const content = readFileSync(join(this.dir, file), "utf8");
    const parsed = parseKbMarkdown(content, slug);
    const side = meta[slug];
    return {
      slug,
      title: entry?.title ?? parsed.title,
      system: entry?.system ?? parsed.system ?? "other",
      content,
      sourceDoc: side?.sourceDoc ?? null,
      sourceRef: side?.sourceRef ?? null,
      tokenCount: side?.tokenCount ?? estimateTokens(content),
      updatedAt: side?.updatedAt ?? new Date(statSync(join(this.dir, file)).mtimeMs).toISOString(),
    };
  }

  async list(): Promise<KbTopicRecord[]> {
    if (!existsSync(this.dir)) return [];
    const byFile = new Map(this.readIndex().map((entry) => [entry.file, entry]));
    const meta = this.readMeta();
    // Files on disk win over the index: a topic distilled but not yet indexed
    // must still be visible, or a migration would silently leave it behind.
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((file) => this.toRecord(file, byFile.get(file), meta));
  }

  async get(slug: string): Promise<KbTopicRecord | null> {
    if (!isSafeSegment(slug)) return null;
    const file = `${slug}.md`;
    if (!existsSync(join(this.dir, file))) return null;
    return this.toRecord(file, this.readIndex().find((e) => e.slug === slug), this.readMeta());
  }

  async upsert(topic: KbTopicRecord): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const file = `${safeSegment(topic.slug)}.md`;
    const content = topic.content.endsWith("\n") ? topic.content : `${topic.content}\n`;
    writeFileSync(join(this.dir, file), content, "utf8");

    const parsed = parseKbMarkdown(content, topic.title);
    const index = this.readIndex().filter((e) => e.slug !== topic.slug);
    index.push({
      slug: topic.slug,
      file,
      title: topic.title,
      system: topic.system,
      keywords: parsed.keywords,
    });
    index.sort((a, b) => a.file.localeCompare(b.file)); // buildKbIndex writes sorted — stay diff-stable
    writeJsonFile(this.indexPath(), index);

    const meta = this.readMeta();
    meta[topic.slug] = {
      sourceDoc: topic.sourceDoc,
      sourceRef: topic.sourceRef,
      tokenCount: topic.tokenCount || estimateTokens(content),
      updatedAt: topic.updatedAt || new Date().toISOString(),
    };
    writeJsonFile(this.metaPath, meta);
  }

  /**
   * Keyword lookup, file-mode flavour: title/system/_index keywords are strong
   * evidence, a body hit is weak — the same A/B weighting the Postgres tsvector
   * uses, minus stemming. Good enough to pick grounding for a generation run.
   */
  async search(keywords: string[], limit = DEFAULT_SEARCH_LIMIT): Promise<KbTopicRecord[]> {
    const wanted = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
    if (wanted.length === 0) return [];
    const bySlug = new Map(this.readIndex().map((entry) => [entry.slug, entry]));
    const scored: Array<{ score: number; topic: KbTopicRecord }> = [];
    for (const topic of await this.list()) {
      const label = [topic.title, topic.system, ...(bySlug.get(topic.slug)?.keywords ?? [])]
        .join(" ")
        .toLowerCase();
      const body = topic.content.toLowerCase();
      let score = 0;
      for (const keyword of wanted) {
        if (label.includes(keyword)) score += 3;
        else if (body.includes(keyword)) score += 1;
      }
      if (score > 0) scored.push({ score, topic });
    }
    scored.sort((a, b) => b.score - a.score || a.topic.slug.localeCompare(b.topic.slug));
    return scored.slice(0, limit).map((entry) => entry.topic);
  }
}

// ---------------------------------------------------------------------------
// cases (the review side — CaseStore in lib/ports.ts stays the read side)

interface CaseMetaEntry {
  kbSource: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string | null;
}

type OnDiskStatus = Extract<CaseStatus, "draft" | "bank">;

export class FileCaseLibrary implements CaseLibrary {
  constructor(
    private readonly bankDir: string,
    private readonly draftsDir: string,
    private readonly metaPath: string,
  ) {}

  private dirFor(status: OnDiskStatus): string {
    return status === "bank" ? this.bankDir : this.draftsDir;
  }

  private readMeta(): Record<string, CaseMetaEntry> {
    return readJsonFile<Record<string, CaseMetaEntry>>(this.metaPath, {});
  }

  private writeMeta(meta: Record<string, CaseMetaEntry>): void {
    writeJsonFile(this.metaPath, meta);
  }

  private recordFrom(data: OsceCase, status: OnDiskStatus, path: string, meta: Record<string, CaseMetaEntry>): CaseRecord {
    const side = meta[data.id];
    return {
      id: data.id,
      status,
      stationType: data.stationType,
      discipline: data.discipline,
      diagnosis: data.diagnosis,
      commonness: data.commonness,
      difficulty: data.difficulty,
      data,
      kbSource: side?.kbSource ?? null,
      reviewNote: side?.reviewNote ?? null,
      reviewedAt: side?.reviewedAt ?? null,
      createdAt: side?.createdAt ?? fileCreatedAt(path),
    };
  }

  private records(status: OnDiskStatus): CaseRecord[] {
    const dir = this.dirFor(status);
    if (!existsSync(dir)) return [];
    const meta = this.readMeta();
    const out: CaseRecord[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const path = join(dir, file);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        console.warn(`(!) ${path} is not valid JSON — excluded from the library`);
        continue;
      }
      const parsed = OsceCaseSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(`(!) ${path} fails the case schema — excluded from the library`);
        continue;
      }
      out.push(this.recordFrom(parsed.data, status, path, meta));
    }
    return out;
  }

  private locate(id: string): { status: OnDiskStatus; path: string } | null {
    if (!isSafeSegment(id)) return null;
    for (const status of ["bank", "draft"] as const) {
      const path = join(this.dirFor(status), `${id}.json`);
      if (existsSync(path)) return { status, path };
    }
    return null;
  }

  async list(status?: CaseStatus): Promise<CaseRecord[]> {
    // "rejected" has no on-disk home: rejection deletes the file, so file mode
    // can never list one. Supabase keeps rejected rows for the audit trail.
    if (status === "rejected") return [];
    if (status) return this.records(status);
    return [...this.records("bank"), ...this.records("draft")];
  }

  async get(id: string): Promise<CaseRecord | null> {
    const found = this.locate(id);
    if (!found) return null;
    const parsed = OsceCaseSchema.safeParse(JSON.parse(readFileSync(found.path, "utf8")));
    if (!parsed.success) return null;
    return this.recordFrom(parsed.data, found.status, found.path, this.readMeta());
  }

  async put(record: CaseRecord): Promise<void> {
    if (record.status === "rejected") {
      throw new Error(`refusing to write case ${record.id} as "rejected" — file mode deletes rejections`);
    }
    if (record.data.id !== record.id) {
      throw new Error(`case record id "${record.id}" does not match its case JSON id "${record.data.id}"`);
    }
    const parsed = OsceCaseSchema.safeParse(record.data);
    if (!parsed.success) {
      throw new Error(`case ${record.id} fails the case schema — refusing to write it`);
    }
    if (this.locate(record.id)) {
      throw new Error(`case ${record.id} already exists — refusing to overwrite`);
    }
    const dir = this.dirFor(record.status);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${safeSegment(record.id)}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");

    const meta = this.readMeta();
    meta[record.id] = {
      kbSource: record.kbSource,
      reviewNote: record.reviewNote,
      reviewedAt: record.reviewedAt,
      createdAt: record.createdAt || new Date().toISOString(),
    };
    this.writeMeta(meta);
  }

  async setStatus(id: string, status: CaseStatus, note?: string | null): Promise<void> {
    const found = this.locate(id);
    if (!found) throw new Error(`case ${id} not found`);
    const meta = this.readMeta();

    if (status === "bank") {
      // The review gate. A case can be hand-edited between generation and
      // approval, so approval re-validates: nothing unvalidated becomes
      // playable (CLAUDE.md §2.3).
      const parsed = OsceCaseSchema.safeParse(JSON.parse(readFileSync(found.path, "utf8")));
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
        throw new Error(`case ${id} fails the case schema — refusing to approve:\n${issues}`);
      }
    }

    if (status === "rejected") {
      unlinkSync(found.path);
      delete meta[id];
      this.writeMeta(meta);
      return;
    }

    if (status !== found.status) {
      movePath(found.path, join(this.dirFor(status), `${id}.json`));
    }
    meta[id] = {
      kbSource: meta[id]?.kbSource ?? null,
      reviewNote: note ?? meta[id]?.reviewNote ?? null,
      reviewedAt: new Date().toISOString(),
      createdAt: meta[id]?.createdAt ?? null,
    };
    this.writeMeta(meta);
  }

  async takenDiagnoses(): Promise<string[]> {
    const taken = new Set<string>();
    for (const status of ["bank", "draft"] as const) {
      const dir = this.dirFor(status);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        try {
          // Read raw, not schema-validated: a case that currently fails the
          // schema still occupies its diagnosis, and paying a model to
          // regenerate a duplicate is the exact waste this guards against.
          const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as { diagnosis?: unknown };
          if (typeof raw.diagnosis === "string" && raw.diagnosis.trim()) taken.add(raw.diagnosis.trim());
        } catch {
          // unreadable file — nothing to claim
        }
      }
    }
    return [...taken].sort();
  }
}

// ---------------------------------------------------------------------------
// spend ledger

interface SpendLine extends SpendEntry {
  createdAt: string;
}

export class FileSpendLedger implements SpendLedger {
  constructor(private readonly path: string) {}

  private lines(): SpendLine[] {
    if (!existsSync(this.path)) return [];
    const out: SpendLine[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SpendLine);
      } catch {
        console.warn("(!) skipping an unparseable line in the spend ledger");
      }
    }
    return out;
  }

  async record(entry: SpendEntry): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    // Append-only JSONL: a crash mid-job can lose at most the last line, and
    // never corrupts the totals the budget guard reads.
    appendFileSync(this.path, `${JSON.stringify({ ...entry, createdAt: new Date().toISOString() })}\n`, "utf8");
  }

  async jobTotal(jobId: string): Promise<number> {
    return this.lines()
      .filter((line) => line.jobId === jobId)
      .reduce((sum, line) => sum + (Number(line.usd) || 0), 0);
  }

  async monthTotal(): Promise<number> {
    const now = new Date();
    // Local month start, matching the app's localISO rule (DECISIONS.md); the
    // Postgres view uses date_trunc('month', now()) and the few hours of
    // difference at a month boundary cannot move a $10 ceiling.
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return this.lines()
      .filter((line) => Date.parse(line.createdAt) >= monthStart)
      .reduce((sum, line) => sum + (Number(line.usd) || 0), 0);
  }
}

// ---------------------------------------------------------------------------

export class FileLibrary implements Library {
  readonly docs: FileSourceDocStore;
  readonly kb: FileKbLibrary;
  readonly cases: FileCaseLibrary;
  readonly spend: FileSpendLedger;

  constructor(
    readonly budget: Budget,
    root: string = process.cwd(),
  ) {
    const base = join(root, ".library");
    this.docs = new FileSourceDocStore(base);
    this.kb = new FileKbLibrary(join(root, "grounding", "kb"), join(base, "kb-meta.json"));
    this.cases = new FileCaseLibrary(
      join(root, "cases", "bank"),
      join(root, "cases", "drafts"),
      join(base, "case-meta.json"),
    );
    this.spend = new FileSpendLedger(join(base, "spend.jsonl"));
  }
}
