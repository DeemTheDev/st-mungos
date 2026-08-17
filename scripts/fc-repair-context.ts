// pnpm fc:repair [--dry-run | --apply] [--store file|supabase] [--dir <path>] [--doc <id>] [--all]
//
// Deterministic repair of ALREADY-EXTRACTED cards that lost their governing
// vignette (docs/FLASHCARDS.md §5.5). ZERO model calls, zero cost — this is
// pure data surgery over what is already in the store.
//
// Four passes, most-reliable first. Each one only ever moves text that is
// already on some card; nothing is generated, nothing is guessed.
//
//   1 SPLIT     A card whose question is "<clinical narrative> <question?>"
//               is split: the narrative becomes `context`, the trailing
//               interrogative stays as `question`. Recovers the vignette
//               verbatim from the card itself.
//   2 TWIN      A context-free card whose question is the exact tail of a
//               longer card's question in the same topic inherits that card's
//               narrative prefix as `context`. This is the overlapping-window
//               artefact: the same sub-question was extracted twice, once with
//               the stem and once without. The redundant twin is then removed.
//   3 STEM      A card that is a bare stem (declarative clinical narrative, no
//               question, no MCQ options, no usable answer) becomes the
//               `context` for the cards that follow it in document order until
//               the next stem — and is itself removed, because a stem with no
//               question is context, not a card.
//   4 SIBLING   A card numbered X.Y inherits `context` from card X (or X.1) in
//               the same topic when that card is a stem or carries a vignette.
//
// Whatever is still not self-contained after all four is marked `needs_review`
// — never guessed at. Those vignettes are simply absent from the card data and
// can only come back from the source document via a re-extraction
// (`pnpm fc:rebuild`).
//
// --dry-run is the DEFAULT. Nothing is written without --apply.

import { createHash } from "node:crypto";

import { normalizeQuestion, qhashOf } from "../lib/flashcards/pipeline";
import { isSelfContained } from "../lib/flashcards/self-contained";
import { FileFcStore, getFcStore, type FcStore } from "../lib/flashcards/store";
import type { FcCard } from "../lib/flashcards/types";

// ---------------------------------------------------------------------------
// shape detection
// ---------------------------------------------------------------------------

/** Sentence-ish split that keeps the terminator on the piece it belongs to. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const INTERROGATIVE_RE =
  /^\s*(?:\(?[a-z0-9]{1,4}[).]\s*)?(?:how|what|why|when|where|which|who|whose|list|name|describe|give|explain|state|outline|discuss|mention|define|identify|classify|interpret|comment|elaborate|is|are|was|were|do|does|did|can|could|would|should|will|has|have)\b/i;

/** A sentence that asks something, rather than telling you something. */
function isQuestionSentence(s: string): boolean {
  return s.trim().endsWith("?") || INTERROGATIVE_RE.test(s);
}

/**
 * Clinical narrative cues. Deliberately strict: only prose that clearly
 * presents a case may be lifted into `context`, so a normal declarative MCQ
 * lead-in ("The hallmark of varicella is:") is never mistaken for a vignette.
 */
const VIGNETTE_CUE_RE =
  /\b(?:\d{1,3}[\s-]?(?:year|yr|month|week|day)[\s-]?old|presents?\s+with|presented\s+with|presenting\s+with|complains?\s+of|complaining\s+of|on\s+examination|on\s+history|is\s+brought\s+in|was\s+admitted|was\s+referred|attends?\s+with|comes\s+in\s+with|patient\s+(?:with|who|that)|known\s+(?:diabetic|hypertensive|epileptic))\b/i;

function looksLikeVignette(text: string): boolean {
  const t = text.trim();
  return t.length >= 40 && VIGNETTE_CUE_RE.test(t);
}

/** MCQ lead-in: "X is caused by:" — a real card front, never a stem. */
function isMcqLeadIn(card: FcCard): boolean {
  return card.options.length > 0 || /[:：]\s*$/.test(card.question.trim());
}

interface Split {
  context: string;
  question: string;
}

/**
 * Pass 1 shape: split "<narrative sentences> <trailing question>" so the
 * vignette can be lifted out. Returns null when the question isn't that shape.
 */
export function splitVignette(question: string): Split | null {
  const parts = sentences(question);
  if (parts.length < 2) return null;
  let firstQuestion = -1;
  for (let i = 0; i < parts.length; i++) {
    if (isQuestionSentence(parts[i])) {
      firstQuestion = i;
      break;
    }
  }
  // Needs at least one narrative sentence before the first question, and the
  // rest of the card from there on must be the asking part.
  if (firstQuestion <= 0) return null;
  const context = parts.slice(0, firstQuestion).join(" ").trim();
  const rest = parts.slice(firstQuestion).join(" ").trim();
  if (!looksLikeVignette(context) || rest.length === 0) return null;
  return { context, question: rest };
}

/** A bare stem: clinical narrative, nothing asked, nothing answered. */
function isBareStem(card: FcCard): boolean {
  if (isMcqLeadIn(card)) return false;
  if (card.answer.trim().length > 0) return false;
  const q = card.question.trim();
  if (sentences(q).some(isQuestionSentence)) return false;
  return looksLikeVignette(q);
}

function groupIdFor(context: string): string | null {
  const key = normalizeQuestion(context);
  if (key.length === 0) return null;
  return `ctx-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// the repair
// ---------------------------------------------------------------------------

type Action =
  | "split"
  | "twin"
  | "stem"
  | "sibling"
  | "needs_review"
  | "remove-stem"
  | "remove-twin"
  | "remove-dup";

interface Change {
  card: FcCard;
  action: Action;
  context?: string;
  question?: string;
  /** Where the recovered context came from, for the report. */
  source?: string;
}

export interface RepairPlan {
  updates: Change[];
  removals: Change[];
  counts: Record<Action, number>;
}

function emptyCounts(): Record<Action, number> {
  return {
    split: 0,
    twin: 0,
    stem: 0,
    sibling: 0,
    needs_review: 0,
    "remove-stem": 0,
    "remove-twin": 0,
    "remove-dup": 0,
  };
}

/** "5.8" → "5". null when the qnum isn't hierarchical. */
function baseQnum(qnum: string | null): string | null {
  const m = /^(\d+)\.(\d+)$/.exec((qnum ?? "").trim());
  return m ? m[1] : null;
}

/** "5.8" → [5, 8]. Empty when unnumbered. */
function qnumTuple(qnum: string | null): number[] {
  return ((qnum ?? "").match(/\d+(?:\.\d+)*/)?.[0] ?? "").split(".").filter(Boolean).map(Number);
}

/** <0, 0, >0 — numeric ordering of two printed question numbers. */
function compareQnum(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

function sameAnswer(a: string, b: string): boolean {
  return normalizeQuestion(a) === normalizeQuestion(b);
}

/**
 * The part of `longQ` that precedes the (normalized) tail `shortNorm`.
 *
 * The suffix match happens on normalized text, so the two raw strings differ in
 * punctuation and spacing — subtracting lengths lands mid-word ("…turning
 * white. Ho"). Instead: count the tail's word tokens and find where that many
 * word tokens begin in the raw string.
 */
function prefixBeforeTail(longQ: string, shortNorm: string): string | null {
  const tailTokens = shortNorm.split(" ").filter(Boolean).length;
  if (tailTokens === 0) return null;
  const starts = [...longQ.matchAll(/[a-zA-Z0-9]+/g)].map((m) => m.index ?? 0);
  if (tailTokens >= starts.length) return null;
  return longQ.slice(0, starts[starts.length - tailTokens]).trim();
}

interface Work {
  card: FcCard;
  context: string;
  question: string;
  action: Action | null;
  source: string;
}

function firstPage(card: FcCard): number | null {
  return card.sourcePages.length > 0 ? Math.min(...card.sourcePages) : null;
}

/**
 * May an inherited vignette be attached to this card? Only when the card
 * actually needs one. A card that already names its own subject
 * ("Which virus is associated with Kaposi Sarcoma?") must NEVER be given a
 * neighbouring case — that would invent a link the document doesn't make, and
 * it is exactly how a naive "carry the stem forward" pass corrupts a whole
 * MCQ bank.
 */
function needsInheritedContext(w: Work): boolean {
  if (w.context.trim().length > 0) return false;
  if (w.card.options.length > 0) return false; // MCQs stand on their own
  return !isSelfContained({ context: "", question: w.question, options: w.card.options });
}

/**
 * Plan the repair for one document's cards, in document order. Pure: takes
 * cards, returns the changes. That is what makes --dry-run trustworthy — the
 * same function produces the preview and the applied result.
 */
export function planRepair(cards: FcCard[]): RepairPlan {
  const counts = emptyCounts();
  const updates: Change[] = [];
  const removals: Change[] = [];

  // Working copy so later passes see what earlier passes decided.
  const work: Work[] = cards.map((c) => ({
    card: c,
    context: c.context ?? "",
    question: c.question,
    action: null,
    source: "",
  }));

  const byTopic = new Map<string, Work[]>();
  for (const w of work) {
    const list = byTopic.get(w.card.topic) ?? [];
    list.push(w);
    byTopic.set(w.card.topic, list);
  }

  // --- pass 1: twin recovery (overlapping-window duplicates) ---------------
  // Runs FIRST, against the untouched question text: overlapping windows
  // extracted some sub-questions twice, once with the vignette prefix and once
  // without. The long twin still holds the stem the short one lost.
  for (const [, list] of byTopic) {
    const normed = list.map((w) => ({ w, n: normalizeQuestion(w.question) }));
    for (const short of normed) {
      if (short.w.context.trim().length > 0 || short.w.action !== null) continue;
      if (short.n.length < 8) continue;
      for (const long of normed) {
        if (long.w.card.id === short.w.card.id || long.w.action === "remove-twin") continue;
        if (long.n.length <= short.n.length + 12) continue;
        if (!long.n.endsWith(` ${short.n}`)) continue;

        // Two guards against a false twin. Generic questions repeat verbatim
        // across unrelated cases — "What is the diagnosis?" is the tail of
        // EVERY vignette card in the topic — so a shared tail alone proves
        // nothing. Real twins are the same extraction seen through two
        // overlapping windows: same pages, and the same answer.
        const shortPage = firstPage(short.w.card);
        const longPage = firstPage(long.w.card);
        if (shortPage !== null && longPage !== null && Math.abs(shortPage - longPage) > 1) continue;
        if (!sameAnswer(short.w.card.answer, long.w.card.answer)) continue;

        const prefix = prefixBeforeTail(long.w.question, short.n);
        if (!prefix || !looksLikeVignette(prefix)) continue;

        short.w.context = prefix;
        short.w.action = "twin";
        short.w.source = `twin card ${long.w.card.id.slice(0, 8)}`;
        // Both cards now say the same thing. Keep the one with the fuller
        // answer — they came from the same source, so the longer text is the
        // one that wasn't truncated — and drop the other.
        if (long.w.card.answer.trim().length > short.w.card.answer.trim().length) {
          short.w.action = "remove-twin";
          short.w.source = `duplicate of ${long.w.card.id.slice(0, 8)}`;
          long.w.context = prefix;
          long.w.question = long.w.question.slice(prefix.length).trim();
          long.w.action = "split";
          long.w.source = "own question (twin kept for its fuller answer)";
        } else {
          long.w.action = "remove-twin";
          long.w.source = `duplicate of ${short.w.card.id.slice(0, 8)}`;
        }
        break;
      }
    }
  }

  // --- pass 2: split a vignette out of the card's own question -------------
  for (const w of work) {
    if (w.context.trim().length > 0 || w.action !== null) continue;
    const split = splitVignette(w.question);
    if (!split) continue;
    w.context = split.context;
    w.question = split.question;
    w.action = "split";
    w.source = "own question";
  }

  // --- pass 3: a stem governs the cards that follow it ---------------------
  // The run is deliberately fenced: same topic, same/adjacent page, no MCQ, and
  // only cards that genuinely dangle. Anything else ends the run.
  let running = "";
  let runningFrom = "";
  let runningTopic = "";
  let runningPage: number | null = null;
  let runningQnum: number[] = [];
  for (const w of work) {
    const page = firstPage(w.card);
    const qnum = qnumTuple(w.card.qnum);

    const open = (context: string, from: string) => {
      running = context;
      runningFrom = from;
      runningTopic = w.card.topic;
      runningPage = page;
      runningQnum = qnum;
    };

    if (isBareStem(w.card)) {
      open(w.card.question.trim(), `stem card ${w.card.id.slice(0, 8)}`);
      w.action = "remove-stem";
      continue;
    }
    // A card carrying a vignette (its own, or one just recovered) opens a run.
    if (w.context.trim().length > 0) {
      open(w.context.trim(), `card ${w.card.qnum ?? "—"} (${w.card.id.slice(0, 8)})`);
      continue;
    }
    if (running.length === 0) continue;

    // A run ends at a topic change, a page gap, or a question-number reset —
    // these documents restart numbering at every new case, so a number that
    // goes backwards is the clearest possible "different patient" signal.
    const sameTopic = w.card.topic === runningTopic;
    const nearby = runningPage === null || page === null || Math.abs(page - runningPage) <= 1;
    const ascending = qnum.length === 0 || runningQnum.length === 0 || compareQnum(qnum, runningQnum) > 0;
    if (!sameTopic || !nearby || !ascending) {
      running = "";
      continue;
    }
    if (!needsInheritedContext(w)) continue; // self-contained: leave it alone

    w.context = running;
    w.action = "stem";
    w.source = runningFrom;
    if (page !== null) runningPage = page; // the run travels with the pages
    if (qnum.length > 0) runningQnum = qnum;
  }

  // --- pass 4: X.Y inherits from X / X.1 in the same topic -----------------
  // Hierarchical numbering is an EXPLICIT parent link, so this one applies
  // even to questions that would scrape past the dangling check — 5.4 really
  // is a sub-question of 5.1's case.
  for (const [, list] of byTopic) {
    const byQnum = new Map<string, Work>();
    for (const w of list) {
      const q = (w.card.qnum ?? "").trim();
      if (q && !byQnum.has(q)) byQnum.set(q, w);
    }
    for (const w of list) {
      if (w.context.trim().length > 0 || w.action === "remove-twin" || w.action === "remove-stem") continue;
      const base = baseQnum(w.card.qnum);
      if (!base) continue;
      const parent = byQnum.get(`${base}.1`) ?? byQnum.get(base);
      if (!parent || parent.card.id === w.card.id) continue;
      const context = parent.context.trim();
      if (!looksLikeVignette(context)) continue;
      const page = firstPage(w.card);
      const parentPage = firstPage(parent.card);
      if (page !== null && parentPage !== null && Math.abs(page - parentPage) > 1) continue;
      w.context = context;
      w.action = "sibling";
      w.source = `card ${parent.card.qnum ?? "—"} (${parent.card.id.slice(0, 8)})`;
    }
  }

  // --- pass 5: dedupe on the repaired identity -----------------------------
  // Adding context can make two cards identical — the same sub-question was
  // extracted once under its flat number and once under its hierarchical one,
  // and both now carry the same stem. qhash is (context + question), and it is
  // UNIQUE per document, so the losers have to go or the write would be
  // rejected. Keep the copy with the fuller answer.
  const byHash = new Map<string, Work[]>();
  for (const w of work) {
    if (w.action === "remove-stem" || w.action === "remove-twin") continue;
    const key = qhashOf(w.question, w.context);
    const list = byHash.get(key) ?? [];
    list.push(w);
    byHash.set(key, list);
  }
  for (const [, list] of byHash) {
    if (list.length < 2) continue;
    const ranked = [...list].sort(
      (a, b) =>
        b.card.answer.trim().length - a.card.answer.trim().length ||
        (a.card.status === "auto" ? -1 : 1) - (b.card.status === "auto" ? -1 : 1),
    );
    for (const loser of ranked.slice(1)) {
      loser.action = "remove-dup";
      loser.source = `identical to ${ranked[0].card.id.slice(0, 8)} once the case was restored`;
    }
  }

  // --- final: anything still dangling is flagged, never guessed ------------
  for (const w of work) {
    if (w.action === "remove-stem" || w.action === "remove-twin" || w.action === "remove-dup") {
      counts[w.action] += 1;
      removals.push({ card: w.card, action: w.action, source: w.source });
      continue;
    }

    const stillDangling =
      w.card.status === "auto" &&
      !isSelfContained({ context: w.context, question: w.question, options: w.card.options });

    if (w.action) {
      counts[w.action] += 1;
      if (stillDangling) counts.needs_review += 1;
      updates.push({
        card: w.card,
        action: stillDangling ? "needs_review" : w.action,
        context: w.context,
        question: w.question,
        source: w.source,
      });
      continue;
    }

    if (stillDangling) {
      counts.needs_review += 1;
      updates.push({ card: w.card, action: "needs_review", context: w.context, question: w.question, source: "" });
    }
  }

  return { updates, removals, counts };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function truncate(text: string, n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

const ACTION_LABEL: Record<Action, string> = {
  split: "SPLIT",
  twin: "TWIN",
  stem: "STEM",
  sibling: "SIBLING",
  needs_review: "FLAG",
  "remove-stem": "DROP-STEM",
  "remove-twin": "DROP-TWIN",
  "remove-dup": "DROP-DUP",
};

function printTable(changes: Change[], limit: number): void {
  for (const c of changes.slice(0, limit)) {
    console.log(`\n  ${ACTION_LABEL[c.action].padEnd(9)} [${c.card.topic} · q${c.card.qnum ?? "—"}]`);
    console.log(`    before   Q: ${truncate(c.card.question, 96)}`);
    if (!c.card.context) console.log(`             (no case)`);
    if (c.action === "remove-stem" || c.action === "remove-twin" || c.action === "remove-dup") {
      const why =
        c.action === "remove-stem"
          ? "it is context, not a card"
          : c.action === "remove-twin"
            ? "redundant twin"
            : "identical to another card once the case was restored";
      console.log(`    after    (removed — ${why})`);
      continue;
    }
    console.log(`    after    case: ${c.context ? truncate(c.context, 92) : "(still none)"}`);
    console.log(`             Q: ${truncate(c.question ?? c.card.question, 96)}`);
    if (c.source) console.log(`             via ${c.source}`);
  }
  if (changes.length > limit) console.log(`\n  … and ${changes.length - limit} more`);
}

/**
 * STORE=supabase → the real tables; otherwise the JSON file store, whose
 * directory can be overridden with --dir (the fc:test harness writes to
 * .flashcards/fc-test rather than .flashcards).
 */
function resolveStore(argv: string[]): FcStore {
  const dirArg = argv.indexOf("--dir");
  const dir = dirArg >= 0 ? argv[dirArg + 1] : undefined;
  if (!dir) return getFcStore();
  if ((process.env.STORE ?? "file").toLowerCase() === "supabase") {
    throw new Error("--dir only applies to the file store; drop --store supabase or drop --dir");
  }
  return new FileFcStore(dir);
}

async function loadCards(store: FcStore, documentId?: string): Promise<FcCard[]> {
  const docs = documentId ? [{ id: documentId }] : await store.listDocuments();
  const out: FcCard[] = [];
  for (const doc of docs) {
    // searchCards returns document order (created_at ascending on both stores),
    // which is the order the extractor walked the pages — the run-of-cards
    // logic in pass 3 depends on it.
    const { cards } = await store.searchCards({ documentId: doc.id, limit: 100_000, offset: 0 });
    out.push(...cards);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const docArg = argv.indexOf("--doc");
  const documentId = docArg >= 0 ? argv[docArg + 1] : undefined;
  const storeArg = argv.indexOf("--store");
  if (storeArg >= 0 && argv[storeArg + 1]) process.env.STORE = argv[storeArg + 1];
  const limit = argv.includes("--all") ? Number.MAX_SAFE_INTEGER : 25;

  const store = resolveStore(argv);
  const cards = await loadCards(store, documentId);
  if (cards.length === 0) {
    console.log("No cards found — nothing to repair.");
    return;
  }

  // Group by document: pass 3 walks document order, and a run of cards must
  // never bleed from one document into another.
  const byDoc = new Map<string, FcCard[]>();
  for (const c of cards) {
    const list = byDoc.get(c.documentId) ?? [];
    list.push(c);
    byDoc.set(c.documentId, list);
  }

  const totals = emptyCounts();
  const allUpdates: Change[] = [];
  const allRemovals: Change[] = [];
  for (const [, docCards] of byDoc) {
    const plan = planRepair(docCards);
    for (const k of Object.keys(totals) as Action[]) totals[k] += plan.counts[k];
    allUpdates.push(...plan.updates);
    allRemovals.push(...plan.removals);
  }

  const danglingBefore = cards.filter(
    (c) => c.status === "auto" && !isSelfContained({ context: c.context ?? "", question: c.question, options: c.options }),
  ).length;

  console.log(`${"=".repeat(74)}`);
  console.log(`fc:repair — ${apply ? "APPLY" : "DRY RUN (default; pass --apply to commit)"}`);
  console.log(`store: ${(process.env.STORE ?? "file").toLowerCase()}   documents: ${byDoc.size}   cards: ${cards.length}`);
  console.log(`${"=".repeat(74)}`);

  console.log(`\nBEFORE / AFTER${limit === 25 ? " (first 25 changes; pass --all for every row)" : ""}`);
  printTable([...allUpdates, ...allRemovals], limit);

  console.log(`\n${"-".repeat(74)}\nSUMMARY`);
  console.log(`  context recovered from the card's own question (SPLIT):   ${totals.split}`);
  console.log(`  context recovered from a duplicate twin card (TWIN):      ${totals.twin}`);
  console.log(`  context inherited from a preceding stem card (STEM):      ${totals.stem}`);
  console.log(`  context inherited from sibling X / X.1 (SIBLING):         ${totals.sibling}`);
  console.log(`  ------------------------------------------------------------`);
  console.log(
    `  repaired deterministically:                               ${totals.split + totals.twin + totals.stem + totals.sibling}`,
  );
  console.log(`  stem-only cards removed:                                  ${totals["remove-stem"]}`);
  console.log(`  redundant twin cards removed:                             ${totals["remove-twin"]}`);
  console.log(`  duplicates removed (identical once the case was added):   ${totals["remove-dup"]}`);
  console.log(`  marked needs_review (context could not be recovered):     ${totals.needs_review}`);
  console.log(`\n  not self-contained before repair: ${danglingBefore}`);

  if (!apply) {
    console.log(`\nNothing was written. Re-run with --apply to commit.`);
    return;
  }

  let written = 0;
  for (const c of allUpdates) {
    const context = c.context ?? "";
    const question = c.question ?? c.card.question;
    await store.updateCard(c.card.id, {
      context,
      question,
      groupId: groupIdFor(context),
      // qhash includes context, so a repaired card must be rehashed or the
      // dedupe key would no longer match how the card is now stored.
      qhash: qhashOf(question, context),
      status: c.action === "needs_review" ? "needs_review" : c.card.status,
    });
    written += 1;
  }
  const removed = await store.deleteCards(allRemovals.map((c) => c.card.id));
  console.log(`\nApplied: ${written} cards updated, ${removed} removed.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
