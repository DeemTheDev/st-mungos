// Stage A CLI — ingest /grounding sources into normalized per-topic markdown.
// Usage: pnpm ingest        (run from the repo root)

import { resolve } from "node:path";

import { ingestGrounding } from "../lib/kb-pipeline/ingest";

process.loadEnvFile(".env.local");

async function main(): Promise<void> {
  const groundingDir = resolve(process.cwd(), "grounding");
  console.log(`[ingest] grounding dir: ${groundingDir}`);
  console.log("[ingest] note: PDF image extraction (stimuli candidates) is deferred — text only this pass");

  const reports = await ingestGrounding(groundingDir);
  let total = 0;
  for (const report of reports) {
    if (report.status === "unchanged") {
      console.log(`  = ${report.source} — unchanged (${report.sections} section(s))`);
    } else {
      console.log(`  + ${report.source} — ${report.sections} section(s) [${report.splitStrategy}]`);
    }
    total += report.sections;
  }
  console.log(`[ingest] done: ${reports.length} source(s), ${total} normalized section(s)`);
}

main().catch((error) => {
  console.error("[ingest] fatal:", error);
  process.exit(1);
});
