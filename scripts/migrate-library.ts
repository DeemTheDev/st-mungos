// pnpm migrate:library [--dry-run]
//
// One-way push of the LOCAL library into Supabase: every KB topic in
// grounding/kb/*.md and every case in cases/bank + cases/drafts, into the
// tables from supabase/schema-library.sql. Until this runs, production can only
// replay whatever was committed to git.
//
// Properties that matter:
//  · IDEMPOTENT — KB topics upsert by slug, cases upsert by id. Re-running is
//    the intended way to push local edits.
//  · NEVER DEMOTES — if a case already exists in Supabase, that row's status,
//    review note and reviewed_at win. A station Azra approved in production
//    must not fall back to "draft" just because the local copy still sits in
//    cases/drafts, and a rejected case must not be resurrected.
//  · VALIDATED — every case is checked against OsceCaseSchema first; anything
//    that fails is skipped and reported, never inserted and never fatal.
//  · $0 — no model calls anywhere in here.
//
// --dry-run makes no network calls at all: it validates locally and prints the
// plan, so it works (and proves the source data) with no Supabase keys set.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { OsceCaseSchema } from "../lib/case-schema";
import { resolveBudget } from "../lib/library";
import type { CaseRecord, KbTopicRecord } from "../lib/library/types";
import { FileLibrary, SupabaseLibrary } from "../lib/stores";

const CASE_DIRS = [
  { dir: "bank", status: "bank" as const },
  { dir: "drafts", status: "draft" as const },
];

function loadLocalEnv(): void {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    console.warn("(!) .env.local not found — relying on ambient environment variables");
  }
}

// ---------------------------------------------------------------------------
// formatting

const padEnd = (value: string, width: number) => value.padEnd(width);
const padStart = (value: string | number, width: number) => String(value).padStart(width);
const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const rule = (widths: number[]) => widths.map((w) => "-".repeat(w)).join("-+-");

function heading(title: string): void {
  console.log(`\n${title}\n${"=".repeat(title.length)}`);
}

// ---------------------------------------------------------------------------
// local sources

interface InvalidCase {
  path: string;
  reason: string;
}

/**
 * Cases the FileLibrary refused to hand over, with the reason. FileCaseLibrary
 * skips them (correctly — an invalid case is not a case), but a migration that
 * silently dropped files would be the worst possible kind of quiet.
 */
function scanInvalidCases(validIds: Set<string>): InvalidCase[] {
  const out: InvalidCase[] = [];
  for (const { dir } of CASE_DIRS) {
    const abs = join(process.cwd(), "cases", dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs).filter((f) => f.endsWith(".json")).sort()) {
      const path = `cases/${dir}/${file}`;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(abs, file), "utf8"));
      } catch (err) {
        out.push({ path, reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      const id = (raw as { id?: unknown }).id;
      if (typeof id === "string" && validIds.has(id)) continue;
      const parsed = OsceCaseSchema.safeParse(raw);
      const reason = parsed.success
        ? "id missing or duplicated across cases/bank and cases/drafts"
        : parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join(" · ");
      out.push({ path, reason });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// plan printing (dry run)

function printKbPlan(topics: KbTopicRecord[]): void {
  heading(`KB topics to upsert by slug (${topics.length})`);
  const widths = [40, 8, 44, 7];
  console.log(
    [padEnd("slug", widths[0]), padEnd("system", widths[1]), padEnd("title", widths[2]), padStart("~tokens", widths[3])].join(" | "),
  );
  console.log(rule(widths));
  for (const topic of topics) {
    console.log(
      [
        padEnd(truncate(topic.slug, widths[0]), widths[0]),
        padEnd(truncate(topic.system, widths[1]), widths[1]),
        padEnd(truncate(topic.title, widths[2]), widths[2]),
        padStart(topic.tokenCount, widths[3]),
      ].join(" | "),
    );
  }
}

function printCasePlan(cases: CaseRecord[]): void {
  heading(`Cases to upsert by id (${cases.length})`);
  const widths = [6, 46, 14, 52];
  console.log(
    [padEnd("status", widths[0]), padEnd("id", widths[1]), padEnd("type/system", widths[2]), padEnd("diagnosis", widths[3])].join(" | "),
  );
  console.log(rule(widths));
  for (const record of cases) {
    console.log(
      [
        padEnd(record.status, widths[0]),
        padEnd(truncate(record.id, widths[1]), widths[1]),
        padEnd(truncate(`${record.stationType === "interpretation" ? "interp" : "clin"}/${record.discipline}`, widths[2]), widths[2]),
        padEnd(truncate(record.diagnosis, widths[3]), widths[3]),
      ].join(" | "),
    );
  }
}

// ---------------------------------------------------------------------------

interface Tally {
  inserted: number;
  updated: number;
  failed: number;
}

function printSummary(kb: Tally, cases: Tally, preserved: number, invalid: InvalidCase[], failures: string[]): void {
  heading("Summary");
  const widths = [10, 9, 9, 8];
  console.log([padEnd("table", widths[0]), padStart("new", widths[1]), padStart("updated", widths[2]), padStart("failed", widths[3])].join(" | "));
  console.log(rule(widths));
  console.log([padEnd("kb topics", widths[0]), padStart(kb.inserted, widths[1]), padStart(kb.updated, widths[2]), padStart(kb.failed, widths[3])].join(" | "));
  console.log([padEnd("cases", widths[0]), padStart(cases.inserted, widths[1]), padStart(cases.updated, widths[2]), padStart(cases.failed, widths[3])].join(" | "));
  if (preserved > 0) {
    console.log(`\n${preserved} case(s) already reviewed in Supabase — their status/review note was preserved.`);
  }
  if (invalid.length > 0) {
    console.log(`\n(!) ${invalid.length} case file(s) skipped (failed OsceCaseSchema — run \`pnpm validate:cases\` for detail):`);
    for (const item of invalid) console.log(`    ${item.path} — ${item.reason}`);
  }
  if (failures.length > 0) {
    console.log(`\n(!) ${failures.length} write failure(s):`);
    for (const failure of failures) console.log(`    ${failure}`);
  }
  console.log("\nCost: $0 — this script makes no model calls.");
}

function explain(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/does not exist|schema cache|PGRST205/i.test(message)) {
    return `${message}\n      → run supabase/schema-library.sql in the Supabase SQL editor first`;
  }
  if (/st_cases_diagnosis_idx|duplicate key/i.test(message)) {
    return `${message}\n      → another row already claims this diagnosis (the dedupe index); reject or rename it first`;
  }
  return message;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const unknown = args.filter((a) => !["--dry-run", "-n"].includes(a));
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}\nUsage: pnpm migrate:library [--dry-run]`);
    process.exit(1);
  }

  loadLocalEnv();
  const budget = resolveBudget();
  const local = new FileLibrary(budget);

  const topics = (await local.kb.list()).filter((topic) => topic.content.trim().length > 0);
  const localCases = await local.cases.list();
  const invalid = scanInvalidCases(new Set(localCases.map((c) => c.id)));

  heading(`St Mungo's — library migration${dryRun ? "  (DRY RUN — no writes, no network)" : ""}`);
  console.log(`  ${padEnd("KB topics (grounding/kb)", 26)} ${padStart(topics.length, 3)}`);
  for (const { dir, status } of CASE_DIRS) {
    const count = localCases.filter((c) => c.status === status).length;
    console.log(`  ${padEnd(`Cases (cases/${dir})`, 26)} ${padStart(count, 3)}  → status '${status}'`);
  }
  console.log(`  ${padEnd("Cases failing the schema", 26)} ${padStart(invalid.length, 3)}`);

  if (dryRun) {
    printKbPlan(topics);
    printCasePlan(localCases);
    printSummary(
      { inserted: topics.length, updated: 0, failed: 0 },
      { inserted: localCases.length, updated: 0, failed: 0 },
      0,
      invalid,
      [],
    );
    console.log("\nDry run — nothing was written. Re-run without --dry-run to push");
    console.log("(needs SUPABASE_URL + SUPABASE_SECRET_KEY, and supabase/schema-library.sql applied).");
    console.log("New/updated counts above assume an empty target; a real run reports them exactly.");
    return;
  }

  const remote = new SupabaseLibrary(budget);
  const failures: string[] = [];

  let existingSlugs: Set<string>;
  let existingCases: Map<string, CaseRecord>;
  try {
    existingSlugs = new Set((await remote.kb.list()).map((t) => t.slug));
    existingCases = new Map((await remote.cases.list()).map((c) => [c.id, c]));
  } catch (err) {
    console.error(`\nCould not read the target tables: ${explain(err)}`);
    process.exit(1);
  }
  console.log(`\nTarget already holds: ${existingSlugs.size} KB topic(s), ${existingCases.size} case(s).`);

  const kbTally: Tally = { inserted: 0, updated: 0, failed: 0 };
  heading("Pushing KB topics");
  for (const [i, topic] of topics.entries()) {
    const label = `[kb ${padStart(i + 1, 2)}/${topics.length}] ${topic.slug}`;
    try {
      await remote.kb.upsert(topic);
      const isNew = !existingSlugs.has(topic.slug);
      if (isNew) kbTally.inserted += 1;
      else kbTally.updated += 1;
      console.log(`${label} — ${isNew ? "new" : "updated"}`);
    } catch (err) {
      kbTally.failed += 1;
      failures.push(`kb ${topic.slug}: ${explain(err)}`);
      console.log(`${label} — FAILED`);
    }
  }

  const caseTally: Tally = { inserted: 0, updated: 0, failed: 0 };
  let preserved = 0;
  heading("Pushing cases");
  for (const [i, record] of localCases.entries()) {
    const label = `[case ${padStart(i + 1, 2)}/${localCases.length}] ${record.id}`;
    const existing = existingCases.get(record.id);
    // The remote review state is authoritative: only the case JSON is refreshed.
    const merged: CaseRecord = {
      ...record,
      status: existing?.status ?? record.status,
      kbSource: record.kbSource ?? existing?.kbSource ?? null,
      reviewNote: existing?.reviewNote ?? record.reviewNote,
      reviewedAt: existing?.reviewedAt ?? record.reviewedAt,
      createdAt: existing?.createdAt ?? record.createdAt,
    };
    try {
      await remote.cases.upsert(merged);
      if (existing) {
        caseTally.updated += 1;
        const kept = existing.status !== record.status;
        if (kept) preserved += 1;
        console.log(`${label} — updated${kept ? ` (kept remote status '${existing.status}', local is '${record.status}')` : ""}`);
      } else {
        caseTally.inserted += 1;
        console.log(`${label} — new (status '${merged.status}')`);
      }
    } catch (err) {
      caseTally.failed += 1;
      failures.push(`case ${record.id}: ${explain(err)}`);
      console.log(`${label} — FAILED`);
    }
  }

  printSummary(kbTally, caseTally, preserved, invalid, failures);
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
