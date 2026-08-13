// Filesystem adapters (the STORE=file default — dev is unblocked without any
// Supabase project, per DECISIONS.md 2026-08-12):
//  - FileSessionStore  → .sessions/*.json (gitignored)
//  - FsCaseStore       → cases/bank/*.json (the reviewed bank only — drafts
//                        never reach a student, CLAUDE.md §2.3)
//  - FsKbStore         → grounding/kb/*.md + _index.json

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OsceCaseSchema, type OsceCase } from "../case-schema";
import type {
  CaseStore,
  CaseSummary,
  KbStore,
  KbTopic,
  SessionState,
  SessionStore,
  SessionSummary,
} from "../ports";

// ---------------------------------------------------------------------------
// sessions

export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string = join(process.cwd(), ".sessions")) {}

  private pathFor(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error(`invalid session id "${id}"`);
    return join(this.dir, `${id}.json`);
  }

  async get(id: string): Promise<SessionState | null> {
    const path = this.pathFor(id);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as SessionState;
  }

  async save(state: SessionState): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const path = this.pathFor(state.id);
    // Write-then-rename so a crash mid-write never corrupts a resumable session.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    try {
      renameSync(tmp, path);
    } catch (err) {
      // Windows rename over an existing file can transiently fail — replace explicitly.
      unlinkSync(path);
      renameSync(tmp, path);
      void err;
    }
  }

  async list(): Promise<SessionSummary[]> {
    if (!existsSync(this.dir)) return [];
    const out: SessionSummary[] = [];
    for (const file of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      try {
        const state = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as SessionState;
        out.push({
          id: state.id,
          caseId: state.caseId,
          stationType: state.stationType,
          status: state.status,
          startedAt: state.startedAt,
          band: state.report?.band ?? null,
        });
      } catch {
        console.warn(`(!) .sessions/${file} is not readable — skipping`);
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

// ---------------------------------------------------------------------------
// cases

export class FsCaseStore implements CaseStore {
  constructor(private readonly dir: string = join(process.cwd(), "cases", "bank")) {}

  async list(): Promise<CaseSummary[]> {
    if (!existsSync(this.dir)) return [];
    const out: CaseSummary[] = [];
    for (const file of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      const parsed = this.read(join(this.dir, file));
      if (parsed) {
        out.push({
          id: parsed.id,
          stationType: parsed.stationType,
          discipline: parsed.discipline,
          diagnosis: parsed.diagnosis,
          commonness: parsed.commonness,
          difficulty: parsed.difficulty,
        });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<OsceCase | null> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
    const path = join(this.dir, `${id}.json`);
    if (!existsSync(path)) return null;
    return this.read(path);
  }

  private read(path: string): OsceCase | null {
    try {
      const result = OsceCaseSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!result.success) {
        console.warn(`(!) ${path} fails the case schema — hidden from the bank`);
        return null;
      }
      return result.data;
    } catch {
      console.warn(`(!) ${path} is not valid JSON — hidden from the bank`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// knowledge base

interface KbIndexEntry {
  slug: string;
  file: string;
  title: string;
  system: string;
  keywords: string[];
}

export class FsKbStore implements KbStore {
  constructor(private readonly dir: string = join(process.cwd(), "grounding", "kb")) {}

  private indexPath(): string {
    return join(this.dir, "_index.json");
  }

  private readIndex(): KbIndexEntry[] {
    if (!existsSync(this.indexPath())) return [];
    try {
      return JSON.parse(readFileSync(this.indexPath(), "utf8")) as KbIndexEntry[];
    } catch {
      return [];
    }
  }

  async search(keywords: string[]): Promise<KbTopic[]> {
    const wanted = keywords.map((k) => k.toLowerCase());
    const hits: KbTopic[] = [];
    for (const entry of this.readIndex()) {
      const haystack = [entry.title, entry.system, ...entry.keywords].join(" ").toLowerCase();
      if (!wanted.some((k) => haystack.includes(k))) continue;
      const path = join(this.dir, entry.file);
      if (!existsSync(path)) continue;
      hits.push({
        slug: entry.slug,
        title: entry.title,
        system: entry.system,
        keywords: entry.keywords,
        content: readFileSync(path, "utf8"),
      });
    }
    return hits;
  }

  async upsert(topic: KbTopic): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const file = `${topic.slug}.md`;
    writeFileSync(join(this.dir, file), topic.content, "utf8");
    const index = this.readIndex().filter((e) => e.slug !== topic.slug);
    index.push({ slug: topic.slug, file, title: topic.title, system: topic.system, keywords: topic.keywords });
    writeFileSync(this.indexPath(), JSON.stringify(index, null, 2), "utf8");
  }
}
