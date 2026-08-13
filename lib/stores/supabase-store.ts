// Supabase SessionStore adapter (STORE=supabase). Server-only: uses the secret
// key, which never reaches the browser. Table DDL lives in
// supabase/schema.sql — run it once in the Supabase SQL editor.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SessionState, SessionStore, SessionSummary } from "../ports";

const TABLE = "st_sessions";

export class SupabaseSessionStore implements SessionStore {
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
      this.client = createClient(url, key, { auth: { persistSession: false } });
    }
  }

  async get(id: string): Promise<SessionState | null> {
    const { data, error } = await this.client.from(TABLE).select("data").eq("id", id).maybeSingle();
    if (error) throw new Error(`supabase get failed: ${error.message}`);
    return data ? (data.data as SessionState) : null;
  }

  async save(state: SessionState): Promise<void> {
    const { error } = await this.client
      .from(TABLE)
      .upsert({ id: state.id, data: state, updated_at: new Date().toISOString() });
    if (error) throw new Error(`supabase save failed: ${error.message}`);
  }

  async list(): Promise<SessionSummary[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("data")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`supabase list failed: ${error.message}`);
    return (data ?? []).map((row) => {
      const s = row.data as SessionState;
      return {
        id: s.id,
        caseId: s.caseId,
        stationType: s.stationType,
        status: s.status,
        startedAt: s.startedAt,
        band: s.report?.band ?? null,
      };
    });
  }
}
