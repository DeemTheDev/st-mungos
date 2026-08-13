// Store selection: STORE=file|supabase, default file (DECISIONS.md — dev works
// with zero external services; the Supabase adapter is a one-env-var switch).
import type { CaseStore, KbStore, SessionStore } from "../ports";
import { FileSessionStore, FsCaseStore, FsKbStore } from "./file-store";
import { SupabaseSessionStore } from "./supabase-store";

export function getSessionStore(): SessionStore {
  const kind = (process.env.STORE ?? "file").toLowerCase();
  if (kind === "supabase") return new SupabaseSessionStore();
  if (kind !== "file") {
    console.warn(`(!) Unknown STORE="${process.env.STORE}" — falling back to file`);
  }
  return new FileSessionStore();
}

export function getCaseStore(): CaseStore {
  return new FsCaseStore();
}

export function getKbStore(): KbStore {
  return new FsKbStore();
}

export { FileSessionStore, FsCaseStore, FsKbStore } from "./file-store";
export { SupabaseSessionStore } from "./supabase-store";
