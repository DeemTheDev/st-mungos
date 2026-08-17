// pnpm fc:test — runs the FULL flashcard pipeline (file-store mode, REAL
// Anthropic calls) against grounding/flashcard-ref-1.pdf AND .docx
// (docs/FLASHCARDS.md). Prints the survey result, window count, per-doc card
// counts, orphan/reconciled/needs_review stats, 5 sample cards verbatim, and
// total tokens + cost. Budget guards: a doc projected over ~$0.60 is capped to
// its first 25 windows; the whole run hard-stops at $1.40.
//
// These are her real study documents — the content is private. Nothing beyond
// the 5 sample cards per document should be quoted out of this run.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CostTracker, createFcAnthropicClient } from "../lib/flashcards/anthropic";
import { runJobStep } from "../lib/flashcards/job";
import { gradeReview, parseExamDate } from "../lib/flashcards/fsrs";
import { FileFcStore } from "../lib/flashcards/store";
import type { FcCard, FcDocument } from "../lib/flashcards/types";

const RUN_BUDGET_USD = 1.4; // hard stop, comfortably under the $1.50 cap
const DOC_BUDGET_USD = 0.6;
const MAX_WINDOWS = 25;

const STORE_DIR = join(process.cwd(), ".flashcards", "fc-test");

function loadLocalEnv(): void {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    console.warn("(!) .env.local not found — relying on ambient environment variables");
  }
}

function sampleIndices(count: number, want = 5): number[] {
  if (count <= want) return [...Array(count).keys()];
  const out = new Set<number>();
  for (let i = 0; i < want; i++) out.add(Math.round((i * (count - 1)) / (want - 1)));
  return [...out].sort((a, b) => a - b);
}

function printCard(card: FcCard, label: string): void {
  console.log(`\n  --- ${label} ---`);
  console.log(`  topic:  ${card.topic}`);
  console.log(`  pages:  ${card.sourcePages.join(", ") || "(none)"}${card.qnum ? `   qnum: ${card.qnum}` : ""}   status: ${card.status}   confidence: ${card.confidence}`);
  // Context first: a sample card is only useful if you can see whether the
  // governing vignette survived extraction.
  if (card.context) console.log(`  CASE: ${card.context}`);
  console.log(`  Q: ${card.question}`);
  for (const opt of card.options) console.log(`     ${opt}`);
  console.log(`  A: ${card.answer || "(needs review — no answer matched)"}`);
}

async function runDocument(
  store: FileFcStore,
  client: ReturnType<typeof createFcAnthropicClient>,
  cost: CostTracker,
  filePath: string,
): Promise<void> {
  const filename = filePath.split(/[\\/]/).pop() ?? filePath;
  console.log(`\n${"=".repeat(74)}\nDOCUMENT: ${filename}\n${"=".repeat(74)}`);

  const bytes = new Uint8Array(readFileSync(filePath));
  const mime = filename.endsWith(".pdf")
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const doc = await store.createDocument({ filename, mime, sizeBytes: bytes.length });
  await store.saveRawFile(doc.id, filename, bytes, mime);

  // Drive the job exactly like the PWA would: one step per call, until done.
  let steps = 0;
  for (;;) {
    steps += 1;
    if (steps > 400) throw new Error("job did not converge in 400 steps — aborting");
    const result = await runJobStep(store, doc.id, {
      client,
      cost,
      docBudgetUsd: DOC_BUDGET_USD,
      maxWindows: MAX_WINDOWS,
    });
    console.log(
      `[step] status=${result.status} progress=${result.progress.done}/${result.progress.total}` +
        `${result.cardCount != null ? ` cards=${result.cardCount}` : ""}${result.message ? ` — ${result.message}` : ""}`,
    );
    if (result.status === "ready" || result.status === "failed") break;
  }

  const finished = (await store.getDocument(doc.id)) as FcDocument;
  if (finished.status === "failed") {
    console.log(`\nRESULT: FAILED — ${finished.error}`);
    return;
  }

  const checkpoint = finished.checkpoint;
  const sections = await store.listSections(doc.id);
  const { cards } = await store.searchCards({ documentId: doc.id, limit: 10_000, offset: 0 });
  const auto = cards.filter((c) => c.status === "auto");
  const needsReview = cards.filter((c) => c.status === "needs_review");

  console.log(`\nSURVEY RESULT`);
  console.log(`  layout: ${finished.layout}`);
  console.log(`  pages:  ${finished.pageCount}`);
  console.log(`  answer-key pages: ${checkpoint?.survey.answer_key_pages.join(", ") || "(none)"}`);
  console.log(`  junk pages:       ${checkpoint?.survey.junk_pages.join(", ") || "(none)"}`);
  console.log(`  sections (${sections.length}):`);
  for (const s of sections) console.log(`    - ${s.title} (pages ${s.pageStart}-${s.pageEnd})`);

  console.log(`\nPIPELINE`);
  console.log(
    `  windows: ${finished.progress.total} processed` +
      `${checkpoint?.capped ? ` (CAPPED from ${checkpoint.plannedWindows} planned — projected cost exceeded $${DOC_BUDGET_USD})` : ` (${checkpoint?.plannedWindows ?? "?"} planned)`}`,
  );
  console.log(`  cards extracted (auto): ${auto.length}`);
  console.log(
    `  reconciled pairs: ${checkpoint?.stats.deterministicPairs ?? 0} deterministic + ${checkpoint?.stats.llmPairs ?? 0} via cleanup call`,
  );
  console.log(`  needs_review: ${needsReview.length}`);
  console.log(`  total cards: ${cards.length}`);
  // The self-containment invariant, measured (docs/FLASHCARDS.md §5.5).
  const withContext = cards.filter((c) => c.context.trim().length > 0);
  console.log(`  cards carrying their case vignette: ${withContext.length}/${cards.length}`);
  console.log(`  vignette groups: ${new Set(cards.map((c) => c.groupId).filter(Boolean)).size}`);

  console.log(`\n5 SAMPLE CARDS (verbatim)`);
  const pool = auto.length >= 5 ? auto : cards;
  for (const [n, idx] of sampleIndices(pool.length).entries()) {
    printCard(pool[idx], `sample ${n + 1}/${Math.min(5, pool.length)}`);
  }

  // FSRS smoke: grade the first card "good" and show the scheduled due date.
  if (cards.length > 0) {
    const review = gradeReview(cards[0].id, null, "good");
    const exam = parseExamDate();
    console.log(
      `\nFSRS smoke: graded sample card "good" → next due ${review.dueAt}` +
        `${exam ? ` (EXAM_DATE cram cap active: ${exam.toDateString()})` : " (EXAM_DATE unset — no cram cap)"}`,
    );
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const client = createFcAnthropicClient();
  const cost = new CostTracker(RUN_BUDGET_USD);

  const store = new FileFcStore(STORE_DIR);
  store.reset(); // fresh run every time — this is a test harness, not her data

  const groundingDir = join(process.cwd(), "grounding");
  const targets = [join(groundingDir, "flashcard-ref-1.pdf"), join(groundingDir, "flashcard-ref-1.docx")];
  for (const target of targets) {
    if (!existsSync(target)) {
      console.error(`(!) ${target} not found — skipping`);
      continue;
    }
    try {
      await runDocument(store, client, cost, target);
    } catch (err) {
      // A budget stop (or any per-doc failure) must not lose the run report.
      console.error(`(!) ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${"=".repeat(74)}\nTOTALS`);
  console.log(`  API calls:          ${cost.calls}`);
  console.log(`  input tokens:       ${cost.inputTokens}`);
  console.log(`  output tokens:      ${cost.outputTokens}`);
  console.log(`  cache write tokens: ${cost.cacheWriteTokens}`);
  console.log(`  cache read tokens:  ${cost.cacheReadTokens}`);
  console.log(`  TOTAL COST:         $${cost.totalUsd.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
