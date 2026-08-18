// pnpm fc:selfcheck — offline, ZERO model calls, zero cost.
//
// Two jobs:
//   1. Assert the self-containment detector (lib/flashcards/self-contained.ts)
//      against hand-picked cases — including the real card that failed her in
//      production ("How do you manage the patient?") and the real card that
//      must NOT be flagged ("What is the management of cirrhosis?").
//   2. Report how the detector scores the local file store, so a lexicon change
//      that starts pulling good cards out of study is visible immediately.
//
// Exit code 1 on any failed assertion — this is the regression gate for the
// safety net, so it has to be runnable without an API key.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { danglingReferentReason } from "../lib/flashcards/self-contained";
import type { FcCard } from "../lib/flashcards/types";

interface Expectation {
  question: string;
  context?: string;
  options?: string[];
  /** true = must be caught by the safety net. */
  dangling: boolean;
  why: string;
}

// Every "dangling: true" question below is verbatim from her real extracted
// cards (.flashcards/fc-test) — these are the failures, not invented examples.
const CASES: Expectation[] = [
  {
    question: "How do you manage the patient?",
    dangling: true,
    why: "the production failure — WHICH patient? (Respiratory, qnum 6)",
  },
  { question: "What is the diagnosis?", dangling: true, why: "Respiratory qnum 1 — stem discarded" },
  {
    question: "How is it diagnosed? Is how many major and how many minor criteria?",
    dangling: true,
    why: "Cardiology qnum 1.12 — truncated AND context-free",
  },
  { question: "What are the likely organisms causing the disease?", dangling: true, why: "which disease?" },
  { question: "What are 5 complications of this condition?", dangling: true, why: "which condition?" },
  { question: "What is the definition of the condition?", dangling: true, why: "which condition?" },
  { question: "What are 3 complication of the condition?", dangling: true, why: "which condition?" },

  {
    question: "What is the management of cirrhosis?",
    dangling: false,
    why: "genuinely self-contained — names its own subject",
  },
  {
    question: "What does CURB -65 stand for?",
    dangling: false,
    why: "self-contained — names a specific score",
  },
  {
    question: "What are signs of respiratory distress?",
    dangling: false,
    why: "self-contained — names a specific syndrome",
  },
  {
    question:
      "A 45-year-old male presents with blurred vision and dizziness. He has a BP of 168/100mmHg. How would you manage this patient?",
    dangling: false,
    why: "carries its own vignette — the shape every card should have",
  },
  {
    question: "What is the pathophysiology of a wheeze?",
    dangling: false,
    why: "self-contained — names the finding it asks about",
  },
  {
    question: "How do you manage the patient?",
    context:
      "A patient presents with cough, dyspnoea and chest pain. They have a stony dull area over the right lower zone with bronchial breathing above it.",
    dangling: false,
    why: "same question, but the vignette is now ON the card — this is the whole fix",
  },
  {
    question: "How is it treated?",
    options: ["A. Aciclovir", "B. Fluconazole", "C. Permethrin 5% cream", "D. Oral prednisone"],
    dangling: false,
    why: "MCQ options are on the front, so the card is answerable as a recognition task",
  },
];

function assertCases(): number {
  let failures = 0;
  console.log("DETECTOR ASSERTIONS");
  for (const c of CASES) {
    const actual = danglingReferentReason({
      context: c.context ?? "",
      question: c.question,
      options: c.options,
    });
    const ok = (actual !== null) === c.dangling;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  expect ${c.dangling ? "DANGLING" : "self-contained"}  ${JSON.stringify(
        c.question.length > 84 ? `${c.question.slice(0, 84)}…` : c.question,
      )}`,
    );
    if (!ok) console.log(`        ^ ${c.why}`);
  }
  return failures;
}

/** Read every card JSON in a FileFcStore directory without booting the store. */
function readStoreCards(baseDir: string): FcCard[] {
  const cardsDir = join(baseDir, "cards");
  if (!existsSync(cardsDir)) return [];
  const out: FcCard[] = [];
  for (const f of readdirSync(cardsDir)) {
    if (!f.endsWith(".json")) continue;
    out.push(...(JSON.parse(readFileSync(join(cardsDir, f), "utf8")) as FcCard[]));
  }
  return out;
}

function reportStore(baseDir: string): void {
  const cards = readStoreCards(baseDir);
  if (cards.length === 0) {
    console.log(`\n(no cards under ${baseDir} — skipping the corpus report)`);
    return;
  }
  const flagged = cards.filter(
    (c) =>
      danglingReferentReason({ context: c.context ?? "", question: c.question, options: c.options }) !== null,
  );
  console.log(`\nCORPUS REPORT — ${baseDir}`);
  console.log(`  cards:                 ${cards.length}`);
  console.log(`  with context:          ${cards.filter((c) => (c.context ?? "").trim().length > 0).length}`);
  console.log(`  caught by the net:     ${flagged.length}`);
  const byTopic = new Map<string, number>();
  for (const c of flagged) byTopic.set(c.topic, (byTopic.get(c.topic) ?? 0) + 1);
  const worst = [...byTopic.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [topic, n] of worst) console.log(`      ${String(n).padStart(4)}  ${topic}`);
}

/** The same report, but against whatever store STORE points at (--store). */
async function reportLiveStore(): Promise<void> {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Fine — the store constructor says what it needs.
  }
  const { getFcStore } = await import("../lib/flashcards/store");
  const store = getFcStore();
  const docs = await store.listDocuments();
  const cards = [];
  for (const d of docs) {
    // Paged: one document can hold ~1000 cards and searchCards caps a page.
    for (let offset = 0; ; offset += 500) {
      const page = await store.searchCards({ documentId: d.id, limit: 500, offset });
      cards.push(...page.cards);
      if (page.cards.length < 500) break;
    }
  }
  if (cards.length === 0) {
    console.log("\n(live store holds no cards — skipping)");
    return;
  }
  const flagged = cards.filter(
    (c) => danglingReferentReason({ context: c.context ?? "", question: c.question, options: c.options }) !== null,
  );
  console.log(`\nCORPUS REPORT — live store (STORE=${process.env.STORE ?? "file"})`);
  console.log(`  documents:             ${docs.length}`);
  console.log(`  cards:                 ${cards.length}`);
  console.log(`  with context:          ${cards.filter((c) => (c.context ?? "").trim().length > 0).length}`);
  console.log(`  caught by the net:     ${flagged.length}`);
  for (const c of flagged.slice(0, 10)) {
    console.log(`      [${c.topic} q${c.qnum ?? "?"}] ${c.question.slice(0, 90)}`);
  }
}

async function main(): Promise<void> {
  const failures = assertCases();
  reportStore(join(process.cwd(), ".flashcards", "fc-test"));
  reportStore(join(process.cwd(), ".flashcards"));
  if (process.argv.includes("--live")) await reportLiveStore();
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed — the safety net has regressed.`);
    process.exit(1);
  }
  console.log("\nAll detector assertions passed.");
}

void main();
