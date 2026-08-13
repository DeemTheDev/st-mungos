// Aggregated study notes (CLAUDE.md §8 "Notes popup") — every completed session
// plus the thing that actually makes it a study tool: what she keeps forgetting,
// counted across all of them.
//
// Read path: SessionStore.list() gives summaries only (no score, no checklist),
// so completed sessions are re-fetched individually for their persisted report.
// Every fetch goes through Promise.allSettled — one unreadable session must
// degrade the page, never 500 it (same posture as the /session picker).
import type { Band } from "./marking-schema";
import type { SessionMode, SessionState } from "./ports";
import { getCaseStore, getSessionStore } from "./stores";

/** Cap on how many completed sessions get their full state loaded. */
const DEFAULT_LIMIT = 100;

export interface NotesEntry {
  id: string;
  startedAt: string;
  caseId: string;
  /** From the case bank; falls back to the case id if the case was removed. */
  diagnosis: string;
  discipline: string | null;
  stationType: "clinical" | "interpretation";
  mode: SessionMode;
  band: Band;
  globalScore: number;
  state: SessionState;
}

export interface MissedItem {
  key: string;
  item: string;
  phase: string;
  critical: boolean;
  missed: number;
  partial: number;
  /** missed + partial — the sort key. */
  slips: number;
  /** How many sessions had this item on the mark sheet at all. */
  seen: number;
}

export interface NotesAggregate {
  /** Aggregates cover full stations only — see comment in computeAggregate. */
  fullStations: number;
  managementVivas: number;
  meanScore: number | null;
  bands: Record<Band, number>;
  mostMissed: MissedItem[];
  criticalMissed: MissedItem[];
}

export interface NotesData {
  entries: NotesEntry[];
  aggregate: NotesAggregate;
  storeError: string | null;
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Management-focus vivas are marked against the WHOLE station checklist (the
 * marking pass is not mode-aware), so their scores and their missed history /
 * examination rows are not comparable to a full station. They are listed, but
 * excluded from the aggregates — otherwise "most missed" would just be a list
 * of everything a management viva never had the chance to cover.
 */
export function computeAggregate(entries: NotesEntry[]): NotesAggregate {
  const full = entries.filter((e) => e.mode !== "management");
  const bands: Record<Band, number> = { distinction: 0, pass: 0, borderline: 0, fail: 0 };
  for (const e of full) bands[e.band] += 1;

  const byItem = new Map<string, MissedItem>();
  for (const entry of full) {
    for (const row of entry.state.report?.checklist ?? []) {
      const key = row.item.trim().toLowerCase();
      const acc = byItem.get(key) ?? {
        key,
        item: row.item,
        phase: row.phase,
        critical: false,
        missed: 0,
        partial: 0,
        slips: 0,
        seen: 0,
      };
      acc.seen += 1;
      // An item counts as critical if ANY case marks it so — the strictest read.
      acc.critical = acc.critical || row.critical;
      if (row.status === "missed") acc.missed += 1;
      if (row.status === "partial") acc.partial += 1;
      acc.slips = acc.missed + acc.partial;
      byItem.set(key, acc);
    }
  }

  const slipped = [...byItem.values()].filter((i) => i.slips > 0);
  const rank = (a: MissedItem, b: MissedItem): number =>
    b.missed - a.missed || b.slips - a.slips || a.item.localeCompare(b.item);

  return {
    fullStations: full.length,
    managementVivas: entries.length - full.length,
    meanScore: full.length > 0 ? full.reduce((sum, e) => sum + e.globalScore, 0) / full.length : null,
    bands,
    mostMissed: [...slipped].sort(rank).slice(0, 8),
    criticalMissed: slipped.filter((i) => i.critical && i.missed > 0).sort(rank),
  };
}

export async function loadNotes(limit: number = DEFAULT_LIMIT): Promise<NotesData> {
  const sessionStore = getSessionStore();
  const errors: string[] = [];

  const [summariesRes, casesRes] = await Promise.allSettled([sessionStore.list(), getCaseStore().list()]);
  if (summariesRes.status === "rejected") errors.push(reasonText(summariesRes.reason));
  if (casesRes.status === "rejected") errors.push(reasonText(casesRes.reason));

  const summaries = summariesRes.status === "fulfilled" ? summariesRes.value : [];
  const caseIndex = new Map(
    (casesRes.status === "fulfilled" ? casesRes.value : []).map((c) => [c.id, c]),
  );

  const completed = summaries
    .filter((s) => s.status === "completed")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);

  const states = await Promise.allSettled(completed.map((s) => sessionStore.get(s.id)));

  const entries: NotesEntry[] = [];
  for (const result of states) {
    if (result.status === "rejected") {
      errors.push(reasonText(result.reason));
      continue;
    }
    const state = result.value;
    // A completed session without a persisted report has nothing to study from.
    if (!state?.report) continue;
    const bankCase = caseIndex.get(state.caseId);
    entries.push({
      id: state.id,
      startedAt: state.startedAt,
      caseId: state.caseId,
      diagnosis: bankCase?.diagnosis ?? state.caseId,
      discipline: bankCase?.discipline ?? null,
      stationType: state.stationType,
      mode: state.mode ?? "full",
      band: state.report.band,
      globalScore: state.report.globalScore,
      state,
    });
  }

  return {
    entries,
    aggregate: computeAggregate(entries),
    storeError: errors.length > 0 ? [...new Set(errors)].join("; ") : null,
  };
}
