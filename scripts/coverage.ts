// Stage C — coverage matrix (CLAUDE.md §5).
// Usage: tsx scripts/coverage.ts
// Prints a system × commonness matrix across cases/bank + cases/drafts, plus
// per-stationType counts and the systems with no cases at all, so bank gaps
// stay visible against the ~50-case, ~80/20 target.

import { DisciplineSchema, type Discipline } from "../lib/case-schema";
import { readExistingCases } from "./gen-common";

const cases = readExistingCases();
const valid = cases.filter((c) => c.parsed !== null);
const invalid = cases.filter((c) => c.parsed === null);

type Row = { common: number; uncommon: number };
const matrix = new Map<Discipline, Row>(
  DisciplineSchema.options.map((d) => [d, { common: 0, uncommon: 0 }]),
);
const stationTypes = { clinical: 0, interpretation: 0 };
const dirTotals = { bank: 0, drafts: 0 };

for (const c of valid) {
  const parsed = c.parsed!;
  matrix.get(parsed.discipline)![parsed.commonness]++;
  stationTypes[parsed.stationType]++;
  dirTotals[c.dir]++;
}

const pad = (s: string | number, w: number) => String(s).padStart(w);
const padEnd = (s: string, w: number) => s.padEnd(w);

console.log("Case coverage — cases/bank + cases/drafts\n");
console.log(`${padEnd("system", 8)} | ${pad("common", 6)} | ${pad("uncommon", 8)} | ${pad("total", 5)}`);
console.log(`${"-".repeat(8)}-+-${"-".repeat(6)}-+-${"-".repeat(8)}-+-${"-".repeat(5)}`);

let totalCommon = 0;
let totalUncommon = 0;
const gaps: Discipline[] = [];

for (const discipline of DisciplineSchema.options) {
  const row = matrix.get(discipline)!;
  const total = row.common + row.uncommon;
  totalCommon += row.common;
  totalUncommon += row.uncommon;
  if (total === 0) gaps.push(discipline);
  console.log(`${padEnd(discipline, 8)} | ${pad(row.common, 6)} | ${pad(row.uncommon, 8)} | ${pad(total, 5)}`);
}

const grandTotal = totalCommon + totalUncommon;
console.log(`${"-".repeat(8)}-+-${"-".repeat(6)}-+-${"-".repeat(8)}-+-${"-".repeat(5)}`);
console.log(`${padEnd("TOTAL", 8)} | ${pad(totalCommon, 6)} | ${pad(totalUncommon, 8)} | ${pad(grandTotal, 5)}`);

const pct = (n: number) => (grandTotal === 0 ? "–" : `${Math.round((n / grandTotal) * 100)}%`);
console.log(`\nCommonness split: ${pct(totalCommon)} common / ${pct(totalUncommon)} uncommon  (target ~80/20)`);
console.log(`Station types:    clinical ${stationTypes.clinical} · interpretation ${stationTypes.interpretation}`);
console.log(`Location:         bank ${dirTotals.bank} · drafts (awaiting review) ${dirTotals.drafts}`);

if (invalid.length > 0) {
  console.log(`\n(!) ${invalid.length} file(s) failed schema validation and are excluded from the matrix:`);
  for (const c of invalid) console.log(`    cases/${c.dir}/${c.file}`);
  console.log("    Run `pnpm validate:cases` for the specific issues.");
}

if (gaps.length > 0) {
  console.log(`\nGaps (systems with 0 cases): ${gaps.join(", ")}`);
} else {
  console.log("\nNo system gaps — every system has at least one case.");
}
console.log(`Bank target: ~50 cases (CLAUDE.md §5). Currently ${grandTotal} total.`);
