// Stage B CLI — distil normalized sections into grounding/kb/ via claude-sonnet-5.
// Usage:
//   pnpm distill                                  # all pending sections
//   pnpm distill --limit 5                        # cap the number of API calls
//   pnpm distill --only diabetes,pulmonary-tb     # slug-prefix filter (comma-separated,
//                                                 #   matches "<section-slug>" or "<source-slug>/<section-slug>")
//   pnpm distill --force ...                      # re-distill even if unchanged

import { resolve } from "node:path";

import { distillKb } from "../lib/kb-pipeline/distill";

process.loadEnvFile(".env.local");

function parseArgs(argv: string[]): { only?: string[]; limit?: number; force: boolean } {
  const only: string[] = [];
  let limit: number | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only") {
      const value = argv[++i] ?? "";
      only.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith("--only=")) {
      only.push(...arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg === "--limit") {
      limit = Number(argv[++i]);
    } else if (arg.startsWith("--limit=")) {
      limit = Number(arg.slice("--limit=".length));
    } else if (arg === "--force") {
      force = true;
    } else {
      console.warn(`[distill] unknown arg ignored: ${arg}`);
    }
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive number`);
  }
  return { only: only.length > 0 ? only : undefined, limit, force };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set (expected in .env.local)");
  }
  const { only, limit, force } = parseArgs(process.argv.slice(2));
  const groundingDir = resolve(process.cwd(), "grounding");
  const result = await distillKb({ groundingDir, only, limit, force });
  console.log(
    `[distill] done: ${result.distilled.length} distilled, ${result.skipped} skipped, index ${result.indexEntries.length} entries, est. cost $${result.totalCostUsd.toFixed(4)}`,
  );
}

main().catch((error) => {
  console.error("[distill] fatal:", error);
  process.exit(1);
});
