// FcStore port + adapters (docs/FLASHCARDS.md §4).
//   STORE=supabase → SupabaseFcStore: Postgres tables (schema-flashcards.sql,
//     server-only via the sb_secret_ key) + the private "flashcards" Storage
//     bucket for raw uploads.
//   STORE=file (default) → FileFcStore: JSON under .flashcards/ (gitignored),
//     raw uploads under .flashcards/raw/ — zero external services for dev.
// Same env-var switch as lib/stores (DECISIONS.md 2026-08-13).

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type {
  FcCard,
  FcCardMeta,
  FcCardStatus,
  FcDocument,
  FcReview,
  FcSection,
  NewFcCard,
} from "./types";

export interface SearchCardsOptions {
  query?: string;
  topic?: string;
  documentId?: string;
  status?: FcCardStatus;
  limit: number;
  offset: number;
}

export interface FcStore {
  createDocument(input: { filename: string; mime: string; sizeBytes: number }): Promise<FcDocument>;
  getDocument(id: string): Promise<FcDocument | null>;
  updateDocument(id: string, patch: Partial<Omit<FcDocument, "id" | "createdAt">>): Promise<void>;
  listDocuments(): Promise<FcDocument[]>;

  saveRawFile(documentId: string, filename: string, bytes: Uint8Array, mime: string): Promise<void>;
  loadRawFile(documentId: string): Promise<{ bytes: Uint8Array; filename: string } | null>;

  replaceSections(
    documentId: string,
    sections: Omit<FcSection, "id" | "documentId">[],
  ): Promise<FcSection[]>;
  listSections(documentId?: string): Promise<FcSection[]>;

  /** Insert with (documentId, qhash) dedupe. Returns the number actually inserted. */
  insertCards(cards: NewFcCard[]): Promise<number>;
  countCards(documentId: string): Promise<number>;
  getCard(id: string): Promise<FcCard | null>;
  searchCards(opts: SearchCardsOptions): Promise<{ cards: FcCard[]; total: number }>;
  /** Slim card+review projection for deck summaries and the review queue. */
  listCardMeta(opts?: { topic?: string; documentId?: string }): Promise<FcCardMeta[]>;

  getReview(cardId: string): Promise<FcReview | null>;
  upsertReview(review: FcReview): Promise<void>;
}

export function getFcStore(): FcStore {
  const kind = (process.env.STORE ?? "file").toLowerCase();
  if (kind === "supabase") return new SupabaseFcStore();
  if (kind !== "file") {
    console.warn(`(!) Unknown STORE="${process.env.STORE}" — flashcards falling back to file`);
  }
  return new FileFcStore();
}

// ---------------------------------------------------------------------------
// file adapter
// ---------------------------------------------------------------------------

interface DocFile {
  document: FcDocument;
  sections: FcSection[];
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "upload";
}

export class FileFcStore implements FcStore {
  private readonly base: string;

  constructor(baseDir?: string) {
    this.base = baseDir ?? join(process.cwd(), ".flashcards");
  }

  private docPath(id: string): string {
    return join(this.base, "docs", `${id}.json`);
  }
  private cardsPath(documentId: string): string {
    return join(this.base, "cards", `${documentId}.json`);
  }
  private reviewsPath(): string {
    return join(this.base, "reviews.json");
  }

  private readDocFile(id: string): DocFile | null {
    const path = this.docPath(id);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as DocFile;
  }
  private writeDocFile(file: DocFile): void {
    mkdirSync(join(this.base, "docs"), { recursive: true });
    writeFileSync(this.docPath(file.document.id), JSON.stringify(file, null, 2), "utf8");
  }
  private readCards(documentId: string): FcCard[] {
    const path = this.cardsPath(documentId);
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf8")) as FcCard[];
  }
  private writeCards(documentId: string, cards: FcCard[]): void {
    mkdirSync(join(this.base, "cards"), { recursive: true });
    writeFileSync(this.cardsPath(documentId), JSON.stringify(cards, null, 2), "utf8");
  }
  private readReviews(): Record<string, FcReview> {
    const path = this.reviewsPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, FcReview>;
  }
  private writeReviews(reviews: Record<string, FcReview>): void {
    mkdirSync(this.base, { recursive: true });
    writeFileSync(this.reviewsPath(), JSON.stringify(reviews, null, 2), "utf8");
  }
  private documentIds(): string[] {
    const dir = join(this.base, "docs");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  }

  /** Test helper: wipe the whole store directory. */
  reset(): void {
    rmSync(this.base, { recursive: true, force: true });
  }

  async createDocument(input: { filename: string; mime: string; sizeBytes: number }): Promise<FcDocument> {
    const now = new Date().toISOString();
    const document: FcDocument = {
      id: randomUUID(),
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      status: "uploaded",
      progress: { done: 0, total: 0 },
      layout: null,
      toc: null,
      checkpoint: null,
      pageCount: null,
      cardCount: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.writeDocFile({ document, sections: [] });
    return document;
  }

  async getDocument(id: string): Promise<FcDocument | null> {
    return this.readDocFile(id)?.document ?? null;
  }

  async updateDocument(id: string, patch: Partial<Omit<FcDocument, "id" | "createdAt">>): Promise<void> {
    const file = this.readDocFile(id);
    if (!file) throw new Error(`flashcard document ${id} not found`);
    file.document = { ...file.document, ...patch, id, updatedAt: new Date().toISOString() };
    this.writeDocFile(file);
  }

  async listDocuments(): Promise<FcDocument[]> {
    const docs = this.documentIds()
      .map((id) => this.readDocFile(id)?.document)
      .filter((d): d is FcDocument => Boolean(d));
    docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return docs;
  }

  async saveRawFile(documentId: string, filename: string, bytes: Uint8Array, mime: string): Promise<void> {
    void mime; // unused on the file adapter — kept for FcStore signature parity
    const dir = join(this.base, "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${documentId}__${safeFilename(filename)}`), bytes);
  }

  async loadRawFile(documentId: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
    const dir = join(this.base, "raw");
    if (!existsSync(dir)) return null;
    const prefix = `${documentId}__`;
    const match = readdirSync(dir).find((f) => f.startsWith(prefix));
    if (!match) return null;
    return { bytes: new Uint8Array(readFileSync(join(dir, match))), filename: match.slice(prefix.length) };
  }

  async replaceSections(
    documentId: string,
    sections: Omit<FcSection, "id" | "documentId">[],
  ): Promise<FcSection[]> {
    const file = this.readDocFile(documentId);
    if (!file) throw new Error(`flashcard document ${documentId} not found`);
    file.sections = sections.map((s) => ({ ...s, id: randomUUID(), documentId }));
    this.writeDocFile(file);
    return file.sections;
  }

  async listSections(documentId?: string): Promise<FcSection[]> {
    const ids = documentId ? [documentId] : this.documentIds();
    const out: FcSection[] = [];
    for (const id of ids) out.push(...(this.readDocFile(id)?.sections ?? []));
    out.sort((a, b) => (a.documentId + a.ord).localeCompare(b.documentId + b.ord));
    return out;
  }

  async insertCards(cards: NewFcCard[]): Promise<number> {
    let inserted = 0;
    const byDoc = new Map<string, NewFcCard[]>();
    for (const c of cards) {
      const list = byDoc.get(c.documentId) ?? [];
      list.push(c);
      byDoc.set(c.documentId, list);
    }
    for (const [documentId, docCards] of byDoc) {
      const existing = this.readCards(documentId);
      const seen = new Set(existing.map((c) => c.qhash));
      for (const c of docCards) {
        if (seen.has(c.qhash)) continue;
        seen.add(c.qhash);
        existing.push({ ...c, id: randomUUID(), createdAt: new Date().toISOString() });
        inserted += 1;
      }
      this.writeCards(documentId, existing);
    }
    return inserted;
  }

  async countCards(documentId: string): Promise<number> {
    return this.readCards(documentId).length;
  }

  async getCard(id: string): Promise<FcCard | null> {
    for (const documentId of this.documentIds()) {
      const card = this.readCards(documentId).find((c) => c.id === id);
      if (card) return card;
    }
    return null;
  }

  async searchCards(opts: SearchCardsOptions): Promise<{ cards: FcCard[]; total: number }> {
    const ids = opts.documentId ? [opts.documentId] : this.documentIds();
    let all: FcCard[] = [];
    for (const id of ids) all.push(...this.readCards(id));
    if (opts.topic) all = all.filter((c) => c.topic === opts.topic);
    if (opts.status) all = all.filter((c) => c.status === opts.status);
    if (opts.query) {
      const needle = opts.query.toLowerCase();
      all = all.filter((c) =>
        `${c.topic}\n${c.question}\n${c.answer}`.toLowerCase().includes(needle),
      );
    }
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { cards: all.slice(opts.offset, opts.offset + opts.limit), total: all.length };
  }

  async listCardMeta(opts?: { topic?: string; documentId?: string }): Promise<FcCardMeta[]> {
    const reviews = this.readReviews();
    const ids = opts?.documentId ? [opts.documentId] : this.documentIds();
    const out: FcCardMeta[] = [];
    for (const id of ids) {
      for (const c of this.readCards(id)) {
        if (opts?.topic && c.topic !== opts.topic) continue;
        const review = reviews[c.id];
        out.push({
          id: c.id,
          documentId: c.documentId,
          sectionId: c.sectionId,
          topic: c.topic,
          status: c.status,
          dueAt: review?.dueAt ?? null,
          state: review?.state ?? null,
        });
      }
    }
    return out;
  }

  async getReview(cardId: string): Promise<FcReview | null> {
    return this.readReviews()[cardId] ?? null;
  }

  async upsertReview(review: FcReview): Promise<void> {
    const reviews = this.readReviews();
    reviews[review.cardId] = review;
    this.writeReviews(reviews);
  }
}

// ---------------------------------------------------------------------------
// supabase adapter
// ---------------------------------------------------------------------------

const BUCKET = "flashcards";

interface DocumentRow {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  status: FcDocument["status"];
  progress: FcDocument["progress"] | null;
  layout: FcDocument["layout"];
  toc: FcDocument["toc"];
  checkpoint: FcDocument["checkpoint"];
  page_count: number | null;
  card_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface CardRow {
  id: string;
  document_id: string;
  section_id: string | null;
  topic: string;
  question: string;
  options: string[] | null;
  answer: string;
  qnum: string | null;
  source_pages: number[] | null;
  confidence: number | null;
  status: FcCardStatus;
  qhash: string;
  created_at: string;
}

function docFromRow(row: DocumentRow): FcDocument {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    status: row.status,
    progress: row.progress ?? { done: 0, total: 0 },
    layout: row.layout,
    toc: row.toc,
    checkpoint: row.checkpoint,
    pageCount: row.page_count,
    cardCount: row.card_count,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cardFromRow(row: CardRow): FcCard {
  return {
    id: row.id,
    documentId: row.document_id,
    sectionId: row.section_id,
    topic: row.topic,
    question: row.question,
    options: row.options ?? [],
    answer: row.answer,
    qnum: row.qnum,
    sourcePages: row.source_pages ?? [],
    confidence: row.confidence,
    status: row.status,
    qhash: row.qhash,
    createdAt: row.created_at,
  };
}

export class SupabaseFcStore implements FcStore {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    if (client) {
      this.client = client;
    } else {
      // Tolerate the URL as copied from the dashboard's REST snippet
      // ("https://xxx.supabase.co/rest/v1/") — supabase-js needs the bare origin.
      const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
      const key = process.env.SUPABASE_SECRET_KEY;
      if (!url || !key) {
        throw new Error("STORE=supabase requires SUPABASE_URL and SUPABASE_SECRET_KEY (server only)");
      }
      if (key.startsWith("sb_publishable_")) {
        throw new Error(
          "SUPABASE_SECRET_KEY holds the PUBLISHABLE key — flashcard tables have RLS with no policies, so nothing would ever read. " +
            "Use the sb_secret_... key: Supabase dashboard → Settings → API Keys → Secret keys.",
        );
      }
      this.client = createClient(url, key, { auth: { persistSession: false } });
    }
  }

  async createDocument(input: { filename: string; mime: string; sizeBytes: number }): Promise<FcDocument> {
    const { data, error } = await this.client
      .from("fc_documents")
      .insert({ filename: input.filename, mime: input.mime, size_bytes: input.sizeBytes })
      .select("*")
      .single();
    if (error) throw new Error(`supabase createDocument failed: ${error.message}`);
    return docFromRow(data as DocumentRow);
  }

  async getDocument(id: string): Promise<FcDocument | null> {
    const { data, error } = await this.client.from("fc_documents").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`supabase getDocument failed: ${error.message}`);
    return data ? docFromRow(data as DocumentRow) : null;
  }

  async updateDocument(id: string, patch: Partial<Omit<FcDocument, "id" | "createdAt">>): Promise<void> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.filename !== undefined) row.filename = patch.filename;
    if (patch.mime !== undefined) row.mime = patch.mime;
    if (patch.sizeBytes !== undefined) row.size_bytes = patch.sizeBytes;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.progress !== undefined) row.progress = patch.progress;
    if (patch.layout !== undefined) row.layout = patch.layout;
    if (patch.toc !== undefined) row.toc = patch.toc;
    if (patch.checkpoint !== undefined) row.checkpoint = patch.checkpoint;
    if (patch.pageCount !== undefined) row.page_count = patch.pageCount;
    if (patch.cardCount !== undefined) row.card_count = patch.cardCount;
    if (patch.error !== undefined) row.error = patch.error;
    const { error } = await this.client.from("fc_documents").update(row).eq("id", id);
    if (error) throw new Error(`supabase updateDocument failed: ${error.message}`);
  }

  async listDocuments(): Promise<FcDocument[]> {
    const { data, error } = await this.client
      .from("fc_documents")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`supabase listDocuments failed: ${error.message}`);
    return ((data ?? []) as DocumentRow[]).map(docFromRow);
  }

  private rawPath(documentId: string, filename: string): string {
    return `raw/${documentId}/${safeFilename(filename)}`;
  }

  async saveRawFile(documentId: string, filename: string, bytes: Uint8Array, mime: string): Promise<void> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(this.rawPath(documentId, filename), bytes, { contentType: mime || "application/octet-stream", upsert: true });
    if (error) {
      throw new Error(
        `supabase storage upload failed: ${error.message} — does the private "${BUCKET}" bucket exist? (dashboard → Storage → New bucket)`,
      );
    }
  }

  async loadRawFile(documentId: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
    const doc = await this.getDocument(documentId);
    if (!doc) return null;
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .download(this.rawPath(documentId, doc.filename));
    if (error || !data) return null;
    return { bytes: new Uint8Array(await data.arrayBuffer()), filename: doc.filename };
  }

  async replaceSections(
    documentId: string,
    sections: Omit<FcSection, "id" | "documentId">[],
  ): Promise<FcSection[]> {
    const del = await this.client.from("fc_sections").delete().eq("document_id", documentId);
    if (del.error) throw new Error(`supabase replaceSections delete failed: ${del.error.message}`);
    if (sections.length === 0) return [];
    const { data, error } = await this.client
      .from("fc_sections")
      .insert(
        sections.map((s) => ({
          document_id: documentId,
          title: s.title,
          ord: s.ord,
          page_start: s.pageStart,
          page_end: s.pageEnd,
        })),
      )
      .select("*");
    if (error) throw new Error(`supabase replaceSections insert failed: ${error.message}`);
    return ((data ?? []) as { id: string; document_id: string; title: string; ord: number; page_start: number | null; page_end: number | null }[]).map(
      (r) => ({ id: r.id, documentId: r.document_id, title: r.title, ord: r.ord, pageStart: r.page_start, pageEnd: r.page_end }),
    );
  }

  async listSections(documentId?: string): Promise<FcSection[]> {
    let q = this.client.from("fc_sections").select("*").order("ord", { ascending: true });
    if (documentId) q = q.eq("document_id", documentId);
    const { data, error } = await q;
    if (error) throw new Error(`supabase listSections failed: ${error.message}`);
    return ((data ?? []) as { id: string; document_id: string; title: string; ord: number; page_start: number | null; page_end: number | null }[]).map(
      (r) => ({ id: r.id, documentId: r.document_id, title: r.title, ord: r.ord, pageStart: r.page_start, pageEnd: r.page_end }),
    );
  }

  async insertCards(cards: NewFcCard[]): Promise<number> {
    if (cards.length === 0) return 0;
    const rows = cards.map((c) => ({
      document_id: c.documentId,
      section_id: c.sectionId,
      topic: c.topic,
      question: c.question,
      options: c.options,
      answer: c.answer,
      qnum: c.qnum,
      source_pages: c.sourcePages,
      confidence: c.confidence,
      status: c.status,
      qhash: c.qhash,
    }));
    // ON CONFLICT (document_id, qhash) DO NOTHING — only inserted rows return.
    const { data, error } = await this.client
      .from("fc_cards")
      .upsert(rows, { onConflict: "document_id,qhash", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`supabase insertCards failed: ${error.message}`);
    return data?.length ?? 0;
  }

  async countCards(documentId: string): Promise<number> {
    const { count, error } = await this.client
      .from("fc_cards")
      .select("id", { count: "exact", head: true })
      .eq("document_id", documentId);
    if (error) throw new Error(`supabase countCards failed: ${error.message}`);
    return count ?? 0;
  }

  async getCard(id: string): Promise<FcCard | null> {
    const { data, error } = await this.client.from("fc_cards").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`supabase getCard failed: ${error.message}`);
    return data ? cardFromRow(data as CardRow) : null;
  }

  async searchCards(opts: SearchCardsOptions): Promise<{ cards: FcCard[]; total: number }> {
    let q = this.client.from("fc_cards").select("*", { count: "exact" });
    if (opts.documentId) q = q.eq("document_id", opts.documentId);
    if (opts.topic) q = q.eq("topic", opts.topic);
    if (opts.status) q = q.eq("status", opts.status);
    if (opts.query) q = q.textSearch("tsv", opts.query, { type: "websearch", config: "english" });
    q = q.order("created_at", { ascending: true }).range(opts.offset, opts.offset + opts.limit - 1);
    const { data, error, count } = await q;
    if (error) throw new Error(`supabase searchCards failed: ${error.message}`);
    return { cards: ((data ?? []) as CardRow[]).map(cardFromRow), total: count ?? 0 };
  }

  async listCardMeta(opts?: { topic?: string; documentId?: string }): Promise<FcCardMeta[]> {
    let q = this.client.from("fc_cards").select("id, document_id, section_id, topic, status");
    if (opts?.topic) q = q.eq("topic", opts.topic);
    if (opts?.documentId) q = q.eq("document_id", opts.documentId);
    const cardsRes = await q.limit(20000);
    if (cardsRes.error) throw new Error(`supabase listCardMeta failed: ${cardsRes.error.message}`);
    const reviewsRes = await this.client.from("fc_reviews").select("card_id, due_at, state").limit(20000);
    if (reviewsRes.error) throw new Error(`supabase listCardMeta reviews failed: ${reviewsRes.error.message}`);
    const reviewByCard = new Map(
      ((reviewsRes.data ?? []) as { card_id: string; due_at: string; state: FcReview["state"] }[]).map((r) => [
        r.card_id,
        r,
      ]),
    );
    return ((cardsRes.data ?? []) as { id: string; document_id: string; section_id: string | null; topic: string; status: FcCardStatus }[]).map(
      (c) => {
        const r = reviewByCard.get(c.id);
        return {
          id: c.id,
          documentId: c.document_id,
          sectionId: c.section_id,
          topic: c.topic,
          status: c.status,
          dueAt: r?.due_at ?? null,
          state: r?.state ?? null,
        };
      },
    );
  }

  async getReview(cardId: string): Promise<FcReview | null> {
    const { data, error } = await this.client.from("fc_reviews").select("*").eq("card_id", cardId).maybeSingle();
    if (error) throw new Error(`supabase getReview failed: ${error.message}`);
    if (!data) return null;
    const r = data as {
      card_id: string;
      due_at: string;
      stability: number;
      difficulty: number;
      reps: number;
      lapses: number;
      state: FcReview["state"];
      scheduled_days: number;
      learning_steps: number;
      last_grade: FcReview["lastGrade"];
      last_reviewed_at: string | null;
    };
    return {
      cardId: r.card_id,
      dueAt: r.due_at,
      stability: r.stability,
      difficulty: r.difficulty,
      reps: r.reps,
      lapses: r.lapses,
      state: r.state,
      scheduledDays: r.scheduled_days,
      learningSteps: r.learning_steps,
      lastGrade: r.last_grade,
      lastReviewedAt: r.last_reviewed_at,
    };
  }

  async upsertReview(review: FcReview): Promise<void> {
    const { error } = await this.client.from("fc_reviews").upsert({
      card_id: review.cardId,
      due_at: review.dueAt,
      stability: review.stability,
      difficulty: review.difficulty,
      reps: review.reps,
      lapses: review.lapses,
      state: review.state,
      scheduled_days: review.scheduledDays,
      learning_steps: review.learningSteps,
      last_grade: review.lastGrade,
      last_reviewed_at: review.lastReviewedAt,
    });
    if (error) throw new Error(`supabase upsertReview failed: ${error.message}`);
  }
}
