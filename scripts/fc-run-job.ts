// pnpm fc:run --doc <id>            drive one document's job to completion
// pnpm fc:run --all                 ...every document that isn't ready
//
// The pipeline is designed as one-step-per-HTTP-poll so a Vercel function never
// times out, which means the browser normally drives it. That is fine for her
// uploading a file, and useless for an operator rebuilding a document from the
// terminal — closing the tab would strand the job mid-extraction. This runs the
// exact same runJobStep() in a loop, so there is no second implementation of
// the pipeline to drift.
//
// Spends real money (extraction is ~$0.022/window). Prints a running total and
// stops on the first step that fails.
import Anthropic from "@anthropic-ai/sdk";
import { CostTracker } from "../lib/flashcards/anthropic";
import { runJobStep } from "../lib/flashcards/job";
import { getFcStore } from "../lib/flashcards/store";

function loadLocalEnv(): void {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Absent is fine for STORE=file.
  }
}

const TERMINAL = new Set(["ready", "failed"]);

async function main(): Promise<void> {
  loadLocalEnv();
  const argv = process.argv.slice(2);
  const docArg = argv.indexOf("--doc");
  const all = argv.includes("--all");
  const capArg = argv.indexOf("--budget");
  const budgetUsd = capArg >= 0 ? Number(argv[capArg + 1]) : 5;

  if (!all && docArg < 0) {
    console.error("Usage: pnpm fc:run --doc <id> | --all   [--budget <usd>]");
    process.exit(1);
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    console.error("--budget must be a positive number of dollars");
    process.exit(1);
  }

  const store = getFcStore();
  const targets = all
    ? (await store.listDocuments()).filter((d) => d.status !== "ready").map((d) => d.id)
    : [argv[docArg + 1]];

  if (targets.length === 0) {
    console.log("Nothing to run — every document is already ready.");
    return;
  }

  const client = new Anthropic();
  // One tracker across all documents so --budget is a run-wide ceiling, not
  // per-document (which would let three documents spend 3x the stated cap).
  const cost = new CostTracker(budgetUsd);

  for (const id of targets) {
    console.log(`\n=== ${id} ===`);
    let step = 0;
    for (;;) {
      const result = await runJobStep(store, id, { client, cost });
      step += 1;
      const pct = result.progress.total > 0
        ? ` ${Math.round((result.progress.done / result.progress.total) * 100)}%`
        : "";
      console.log(
        `  [${String(step).padStart(3)}] ${result.status.padEnd(11)}` +
          ` ${result.progress.done}/${result.progress.total}${pct}` +
          ` | $${cost.totalUsd.toFixed(4)}` +
          (result.message ? ` | ${result.message}` : "") +
          (result.cardCount != null ? ` | ${result.cardCount} cards` : ""),
      );
      if (TERMINAL.has(result.status)) {
        if (result.status === "failed") process.exitCode = 1;
        break;
      }
    }
  }
  console.log(`\nTotal spend: $${cost.totalUsd.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
