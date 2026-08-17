// Phase 6 library adapters over Supabase (STORE=supabase) — the four tables in
// supabase/schema-library.sql plus the private "grounding" Storage bucket.
// Server-only: every call uses the secret key, which never reaches the browser,
// and the tables have RLS with no policies, so nothing else can read them.
//
// This is what makes production autonomous: uploading a study guide, distilling
// it, generating stations, approving them and PLAYING them all become table
// reads and writes instead of filesystem operations on Nadeem's laptop.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { OsceCaseSchema, type OsceCase } from "../case-schema";
import type { CaseStore, CaseSummary, KbStore, KbTopic } from "../ports";
import type {
  Budget,
  CaseLibrary,
  CaseRecord,
  CaseStatus,
  KbLibrary,
  KbTopicRecord,
  Library,
  SourceDoc,
  SourceDocStatus,
  SourceDocStore,
  SpendEntry,
  SpendLedger,
} from "../library/types";
import { estimateTokens, parseKbMarkdown, safeLibraryFilename } from "./file-library";

const DOCS_TABLE = "st_source_docs";
const KB_TABLE = "st_kb_topics";
const CASES_TABLE = "st_cases";
const SPEND_TABLE = "st_spend";
const SPEND_MONTH_VIEW = "st_spend_this_month";

/** Her course material — the bucket must be PRIVATE (schema-library.sql). */
const BUCKET = "grounding";

const DEFAULT_SEARCH_LIMIT = 8;

/**
 * One client factory for every library adapter, with the same two guards the
 * session store learned the hard way (lib/stores/supabase-store.ts).
 */
export function createLibraryClient(client?: SupabaseClient): SupabaseClient {
  if (client) return client;
  // Tolerate the URL as copied from the dashboard's REST snippet
  // ("https://xxx.supabase.co/rest/v1/") — supabase-js needs the bare origin.
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("STORE=supabase requires SUPABASE_URL and SUPABASE_SECRET_KEY (server only)");
  }
  if (key.startsWith("sb_publishable_")) {
    throw new Error(
      "SUPABASE_SECRET_KEY holds the PUBLISHABLE key — the library tables have RLS with no policies, " +
        "so every read returns empty and every write is rejected. " +
        "Use the sb_secret_... key: Supabase dashboard → Settings → API Keys → Secret keys.",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// source documents

interface SourceDocRow {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  storage_path: string | null;
  status: SourceDocStatus;
  done_steps: number;
  total_steps: number;
  checkpoint: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function docFromRow(row: SourceDocRow): SourceDoc {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    storagePath: row.storage_path,
    status: row.status,
    progress: { done: row.done_steps, total: row.total_steps },
    checkpoint: row.checkpoint ?? null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupabaseSourceDocStore implements SourceDocStore {
  constructor(private readonly client: SupabaseClient) {}

  async put(doc: SourceDoc): Promise<void> {
    const row: Record<string, unknown> = {
      id: doc.id,
      filename: doc.filename,
      mime: doc.mime,
      size_bytes: doc.sizeBytes,
      storage_path: doc.storagePath,
      status: doc.status,
      done_steps: doc.progress.done,
      total_steps: doc.progress.total,
      checkpoint: doc.checkpoint ?? null,
      error: doc.error,
      created_at: doc.createdAt,
      updated_at: new Date().toISOString(),
    };
    const { error } = await this.client.from(DOCS_TABLE).upsert(row);
    if (error) throw new Error(`supabase source doc put failed: ${error.message}`);
  }

  async get(id: string): Promise<SourceDoc | null> {
    const { data, error } = await this.client.from(DOCS_TABLE).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`supabase source doc get failed: ${error.message}`);
    return data ? docFromRow(data as SourceDocRow) : null;
  }

  async list(): Promise<SourceDoc[]> {
    const { data, error } = await this.client
      .from(DOCS_TABLE)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`supabase source doc list failed: ${error.message}`);
    return ((data ?? []) as SourceDocRow[]).map(docFromRow);
  }

  async putBlob(id: string, filename: string, bytes: Uint8Array): Promise<string> {
    const path = `docs/${id}/${safeLibraryFilename(filename)}`;
    const { error } = await this.client.storage.from(BUCKET).upload(path, bytes, {
      contentType: "application/octet-stream",
      upsert: true,
    });
    if (error) {
      throw new Error(
        `supabase storage upload failed: ${error.message} — does the PRIVATE "${BUCKET}" bucket exist? (dashboard → Storage → New bucket, Public OFF)`,
      );
    }
    return path;
  }

  async getBlob(storagePath: string): Promise<Uint8Array | null> {
    const { data, error } = await this.client.storage.from(BUCKET).download(storagePath);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  }
}

// ---------------------------------------------------------------------------
// knowledge base

interface KbTopicRow {
  slug: string;
  title: string;
  system: string;
  content: string;
  source_doc: string | null;
  source_ref: string | null;
  token_count: number;
  updated_at: string;
}

function kbFromRow(row: KbTopicRow): KbTopicRecord {
  return {
    slug: row.slug,
    title: row.title,
    system: row.system,
    content: row.content,
    sourceDoc: row.source_doc,
    sourceRef: row.source_ref,
    tokenCount: Number(row.token_count),
    updatedAt: row.updated_at,
  };
}

const KB_COLUMNS = "slug, title, system, content, source_doc, source_ref, token_count, updated_at";

/**
 * websearch_to_tsquery ANDs bare terms, so passing eight keywords straight
 * through would match nothing. Callers mean "any of these", which is `or`.
 * Multi-word keywords become quoted phrases; quotes are stripped from the
 * input so a keyword can never restructure the query.
 */
function websearchQuery(keywords: string[]): string {
  const terms = keywords
    .map((k) => k.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean)
    .map((k) => (k.includes(" ") ? `"${k}"` : k));
  return [...new Set(terms)].join(" or ");
}

export class SupabaseKbLibrary implements KbLibrary {
  constructor(private readonly client: SupabaseClient) {}

  async list(): Promise<KbTopicRecord[]> {
    const { data, error } = await this.client
      .from(KB_TABLE)
      .select(KB_COLUMNS)
      .order("slug", { ascending: true })
      .limit(1000);
    if (error) throw new Error(`supabase kb list failed: ${error.message}`);
    return ((data ?? []) as unknown as KbTopicRow[]).map(kbFromRow);
  }

  async get(slug: string): Promise<KbTopicRecord | null> {
    const { data, error } = await this.client.from(KB_TABLE).select(KB_COLUMNS).eq("slug", slug).maybeSingle();
    if (error) throw new Error(`supabase kb get failed: ${error.message}`);
    return data ? kbFromRow(data as unknown as KbTopicRow) : null;
  }

  async upsert(topic: KbTopicRecord): Promise<void> {
    const { error } = await this.client.from(KB_TABLE).upsert({
      slug: topic.slug,
      title: topic.title,
      system: topic.system,
      content: topic.content,
      source_doc: topic.sourceDoc,
      source_ref: topic.sourceRef,
      token_count: topic.tokenCount || estimateTokens(topic.content),
      updated_at: topic.updatedAt || new Date().toISOString(),
    });
    if (error) throw new Error(`supabase kb upsert failed: ${error.message}`);
  }

  async search(keywords: string[], limit = DEFAULT_SEARCH_LIMIT): Promise<KbTopicRecord[]> {
    const query = websearchQuery(keywords);
    if (!query) return [];
    // The generated `tsv` column is built with the 'english' config; the query
    // must name the same one or stems silently stop matching.
    const { data, error } = await this.client
      .from(KB_TABLE)
      .select(KB_COLUMNS)
      .textSearch("tsv", query, { type: "websearch", config: "english" })
      .limit(limit);
    if (error) throw new Error(`supabase kb search failed: ${error.message}`);
    return ((data ?? []) as unknown as KbTopicRow[]).map(kbFromRow);
  }
}

/**
 * The narrow KbStore port (lib/ports.ts) over the same table, so `getKbStore()`
 * follows STORE like everything else. Keywords are not a column: they live in
 * the distiller's `<!-- meta: -->` line inside the markdown, which is the one
 * place they have ever lived.
 */
export class SupabaseKbStore implements KbStore {
  private readonly library: SupabaseKbLibrary;

  constructor(client?: SupabaseClient) {
    this.library = new SupabaseKbLibrary(createLibraryClient(client));
  }

  async search(keywords: string[]): Promise<KbTopic[]> {
    const topics = await this.library.search(keywords);
    return topics.map((topic) => ({
      slug: topic.slug,
      title: topic.title,
      system: topic.system,
      keywords: parseKbMarkdown(topic.content, topic.title).keywords,
      content: topic.content,
    }));
  }

  async upsert(topic: KbTopic): Promise<void> {
    await this.library.upsert({
      slug: topic.slug,
      title: topic.title,
      system: topic.system,
      content: topic.content,
      sourceDoc: null,
      sourceRef: null,
      tokenCount: estimateTokens(topic.content),
      updatedAt: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// cases — the review (write) side

interface CaseRow {
  id: string;
  status: CaseStatus;
  station_type: "clinical" | "interpretation";
  discipline: string;
  diagnosis: string;
  commonness: "common" | "uncommon";
  difficulty: number;
  data: OsceCase;
  kb_source: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
}

const CASE_COLUMNS =
  "id, status, station_type, discipline, diagnosis, commonness, difficulty, data, kb_source, review_note, reviewed_at, created_at";

function caseFromRow(row: CaseRow): CaseRecord {
  return {
    id: row.id,
    status: row.status,
    stationType: row.station_type,
    discipline: row.discipline,
    diagnosis: row.diagnosis,
    commonness: row.commonness,
    difficulty: row.difficulty,
    data: row.data,
    kbSource: row.kb_source,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

function caseRow(record: CaseRecord): Record<string, unknown> {
  return {
    id: record.id,
    status: record.status,
    station_type: record.stationType,
    discipline: record.discipline,
    diagnosis: record.diagnosis,
    commonness: record.commonness,
    difficulty: record.difficulty,
    data: record.data,
    kb_source: record.kbSource,
    review_note: record.reviewNote,
    reviewed_at: record.reviewedAt,
    created_at: record.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export class SupabaseCaseLibrary implements CaseLibrary {
  constructor(private readonly client: SupabaseClient) {}

  async list(status?: CaseStatus): Promise<CaseRecord[]> {
    let query = this.client.from(CASES_TABLE).select(CASE_COLUMNS).order("id", { ascending: true }).limit(1000);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw new Error(`supabase case list failed: ${error.message}`);
    return ((data ?? []) as unknown as CaseRow[]).map(caseFromRow);
  }

  async get(id: string): Promise<CaseRecord | null> {
    const { data, error } = await this.client.from(CASES_TABLE).select(CASE_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw new Error(`supabase case get failed: ${error.message}`);
    return data ? caseFromRow(data as unknown as CaseRow) : null;
  }

  async put(record: CaseRecord): Promise<void> {
    const parsed = OsceCaseSchema.safeParse(record.data);
    if (!parsed.success) {
      throw new Error(`case ${record.id} fails the case schema — refusing to insert it`);
    }
    // INSERT, not upsert: the contract says a duplicate id must be rejected, and
    // a generation run silently overwriting a reviewed case would be a very
    // expensive kind of quiet.
    const { error } = await this.client.from(CASES_TABLE).insert(caseRow({ ...record, data: parsed.data }));
    if (error) throw new Error(`supabase case put failed: ${error.message}`);
  }

  /**
   * NOT part of CaseLibrary — the migration's idempotent write path
   * (scripts/migrate-library.ts), which must be safe to re-run. Everything in
   * the app proper goes through put() + setStatus(), so the review gate stays
   * the only way a row becomes 'bank'.
   */
  async upsert(record: CaseRecord): Promise<void> {
    const parsed = OsceCaseSchema.safeParse(record.data);
    if (!parsed.success) {
      throw new Error(`case ${record.id} fails the case schema — refusing to upsert it`);
    }
    const { error } = await this.client
      .from(CASES_TABLE)
      .upsert(caseRow({ ...record, data: parsed.data }), { onConflict: "id" });
    if (error) throw new Error(`supabase case upsert failed: ${error.message}`);
  }

  async setStatus(id: string, status: CaseStatus, note?: string | null): Promise<void> {
    if (status === "bank") {
      // The review gate. A case can be hand-edited between generation and
      // approval, so approval re-validates: nothing unvalidated ever becomes
      // playable (CLAUDE.md §2.3).
      const existing = await this.get(id);
      if (!existing) throw new Error(`case ${id} not found`);
      const parsed = OsceCaseSchema.safeParse(existing.data);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
        throw new Error(`case ${id} fails the case schema — refusing to approve:\n${issues}`);
      }
    }
    const patch: Record<string, unknown> = {
      status,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (note !== undefined) patch.review_note = note;
    const { error } = await this.client.from(CASES_TABLE).update(patch).eq("id", id);
    if (error) throw new Error(`supabase case setStatus failed: ${error.message}`);
  }

  async takenDiagnoses(): Promise<string[]> {
    // Rejected cases release their diagnosis — that is the point of rejecting.
    const { data, error } = await this.client
      .from(CASES_TABLE)
      .select("diagnosis")
      .neq("status", "rejected")
      .limit(1000);
    if (error) throw new Error(`supabase takenDiagnoses failed: ${error.message}`);
    return [...new Set(((data ?? []) as { diagnosis: string }[]).map((r) => r.diagnosis.trim()).filter(Boolean))].sort();
  }
}

// ---------------------------------------------------------------------------
// cases — the READ side production plays from

const BANK_STATUS = "bank";

/**
 * `CaseStore` (lib/ports.ts) over st_cases. This is what lets production play
 * cases straight from the database instead of from whatever was committed to
 * git.
 *
 * SAFETY — the status filter below is the ENTIRE guarantee that an unreviewed
 * draft can never be served to a student (CLAUDE.md §2.3). It is deliberately
 * not reachable from outside:
 *   · every query is built by summaryRows()/caseRows(), which both pin
 *     .eq("status", BANK_STATUS);
 *   · no method here takes a status, a filter, or a table name, so there is no
 *     argument a caller could pass to widen it;
 *   · get() re-asserts row.status === "bank" AFTER the fetch, so even a future
 *     refactor that loosened the query would fail closed rather than hand back
 *     a draft;
 *   · rows are re-validated against OsceCaseSchema, mirroring FsCaseStore —
 *     a row that no longer parses is hidden, not half-played.
 * Drafts are reached only through CaseLibrary (the review side). Keeping the
 * two apart is the whole design.
 */
export class SupabaseCaseStore implements CaseStore {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = createLibraryClient(client);
  }

  private summaryRows() {
    return this.client
      .from(CASES_TABLE)
      .select("id, station_type, discipline, diagnosis, commonness, difficulty")
      .eq("status", BANK_STATUS);
  }

  private caseRows() {
    return this.client.from(CASES_TABLE).select("id, status, data").eq("status", BANK_STATUS);
  }

  async list(): Promise<CaseSummary[]> {
    const { data, error } = await this.summaryRows().order("id", { ascending: true }).limit(1000);
    if (error) throw new Error(`supabase case store list failed: ${error.message}`);
    return (
      (data ?? []) as unknown as Array<{
        id: string;
        station_type: "clinical" | "interpretation";
        discipline: string;
        diagnosis: string;
        commonness: "common" | "uncommon";
        difficulty: number;
      }>
    ).map((row) => ({
      id: row.id,
      stationType: row.station_type,
      discipline: row.discipline,
      diagnosis: row.diagnosis,
      commonness: row.commonness,
      difficulty: row.difficulty,
    }));
  }

  async get(id: string): Promise<OsceCase | null> {
    const { data, error } = await this.caseRows().eq("id", id).maybeSingle();
    if (error) throw new Error(`supabase case store get failed: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as { id: string; status: string; data: unknown };
    // Belt and braces: the query already filtered, and this proves it.
    if (row.status !== BANK_STATUS) return null;
    const parsed = OsceCaseSchema.safeParse(row.data);
    if (!parsed.success) {
      console.warn(`(!) st_cases row ${row.id} fails the case schema — hidden from the bank`);
      return null;
    }
    return parsed.data;
  }
}

// ---------------------------------------------------------------------------
// spend ledger

export class SupabaseSpendLedger implements SpendLedger {
  constructor(private readonly client: SupabaseClient) {}

  async record(entry: SpendEntry): Promise<void> {
    const { error } = await this.client.from(SPEND_TABLE).insert({
      job_id: entry.jobId,
      kind: entry.kind,
      model: entry.model,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      cache_read_tokens: entry.cacheReadTokens,
      cache_write_tokens: entry.cacheWriteTokens,
      usd: entry.usd,
    });
    if (error) throw new Error(`supabase spend record failed: ${error.message}`);
  }

  async jobTotal(jobId: string): Promise<number> {
    // A job writes a handful of rows; summing them here beats maintaining an
    // RPC for a table this small.
    const { data, error } = await this.client.from(SPEND_TABLE).select("usd").eq("job_id", jobId).limit(10000);
    if (error) throw new Error(`supabase spend jobTotal failed: ${error.message}`);
    return ((data ?? []) as { usd: number | string }[]).reduce((sum, row) => sum + (Number(row.usd) || 0), 0);
  }

  async monthTotal(): Promise<number> {
    const { data, error } = await this.client.from(SPEND_MONTH_VIEW).select("usd").maybeSingle();
    if (error) throw new Error(`supabase spend monthTotal failed: ${error.message}`);
    return Number((data as { usd: number | string } | null)?.usd ?? 0);
  }
}

// ---------------------------------------------------------------------------

export class SupabaseLibrary implements Library {
  readonly docs: SupabaseSourceDocStore;
  readonly kb: SupabaseKbLibrary;
  readonly cases: SupabaseCaseLibrary;
  readonly spend: SupabaseSpendLedger;

  constructor(
    readonly budget: Budget,
    client?: SupabaseClient,
  ) {
    // One client for all four adapters — one connection pool, one place the
    // key guards live.
    const shared = createLibraryClient(client);
    this.docs = new SupabaseSourceDocStore(shared);
    this.kb = new SupabaseKbLibrary(shared);
    this.cases = new SupabaseCaseLibrary(shared);
    this.spend = new SupabaseSpendLedger(shared);
  }
}
