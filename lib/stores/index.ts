// Store selection: STORE=file|supabase, default file (DECISIONS.md — dev works
// with zero external services; the Supabase adapter is a one-env-var switch).
import type { CaseStore, KbStore, SessionStore } from "../ports";
import { FileSessionStore, FsCaseStore, FsKbStore } from "./file-store";
import { SupabaseSessionStore } from "./supabase-store";
import { SupabaseCaseStore, SupabaseKbStore } from "./supabase-library";

function storeKind(label: string): "file" | "supabase" {
  const kind = (process.env.STORE ?? "file").toLowerCase();
  if (kind === "supabase") return "supabase";
  if (kind !== "file") {
    console.warn(`(!) Unknown STORE="${process.env.STORE}" — ${label} falling back to file`);
  }
  return "file";
}

export function getSessionStore(): SessionStore {
  return storeKind("sessions") === "supabase" ? new SupabaseSessionStore() : new FileSessionStore();
}

/**
 * The READ side the session engine plays from. Both adapters serve reviewed
 * cases ONLY — cases/bank/*.json on disk, status='bank' rows in Supabase — so
 * an unreviewed draft is unreachable from here in either mode (CLAUDE.md §2.3).
 * Drafts live behind CaseLibrary (lib/library), which is the review side.
 */
export function getCaseStore(): CaseStore {
  return storeKind("cases") === "supabase" ? new SupabaseCaseStore() : new FsCaseStore();
}

export function getKbStore(): KbStore {
  return storeKind("kb") === "supabase" ? new SupabaseKbStore() : new FsKbStore();
}

export { FileSessionStore, FsCaseStore, FsKbStore } from "./file-store";
export { SupabaseSessionStore } from "./supabase-store";
export { FileLibrary } from "./file-library";
export { SupabaseCaseStore, SupabaseKbStore, SupabaseLibrary } from "./supabase-library";
