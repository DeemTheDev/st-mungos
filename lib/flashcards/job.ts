// One-step-per-invocation job runner over fc_documents.status
// (docs/FLASHCARDS.md §2 job orchestration):
//   uploaded → surveying → extracting (n/m) → reconciling → ready | failed
// Each call processes exactly ONE pipeline step and persists a checkpoint on
// the document row, so a killed job resumes at the last completed window and
// every step fits one serverless invocation. Transient errors (API hiccups)
// propagate — the checkpoint is untouched, so the next poll retries the same
// step. Only structurally hopeless documents (scans, unsupported, corrupt)
// are marked failed.

import type Anthropic from "@anthropic-ai/sdk";

import { CostTracker, createFcAnthropicClient } from "./anthropic";
import { ScanDetectedError, UnsupportedFileError, extractDocument, type ExtractedDocument } from "./extract";
import {
  buildAnswerKeyMap,
  dedupeOrphans,
  deterministicReconcile,
  planWindows,
  qhashOf,
  runExtractionPass,
  runReconcilePass,
  runSurveyPass,
} from "./pipeline";
import type { ExtractedCard, OrphanAnswer, OrphanQuestion } from "./schema";
import type { FcStore } from "./store";
import type { FcCheckpoint, FcDocument, FcSection, JobStepResult, NewFcCard } from "./types";

export interface JobStepOptions {
  client?: Anthropic;
  cost?: CostTracker;
  /**
   * Budget guard applied at planning time: when the projected extraction cost
   * (planned windows × ~$0.022) exceeds this, only the first `maxWindows`
   * windows are processed. Used by scripts/fc-extract-test.ts; the API routes
   * process everything.
   */
  docBudgetUsd?: number;
  maxWindows?: number;
}

/** Empirical per-window cost estimate (Haiku 4.5, ~6k in / ~2.5k out). */
const EST_WINDOW_USD = 0.022;
const DEFAULT_WINDOW_CAP = 25;

export async function runJobStep(
  store: FcStore,
  documentId: string,
  opts: JobStepOptions = {},
): Promise<JobStepResult> {
  const doc = await store.getDocument(documentId);
  if (!doc) throw new Error(`flashcard document ${documentId} not found`);

  switch (doc.status) {
    case "ready":
      return { status: "ready", progress: doc.progress, cardCount: doc.cardCount };
    case "failed":
      return { status: "failed", progress: doc.progress, message: doc.error ?? "processing failed" };
    case "uploaded":
    case "surveying":
      return surveyStep(store, doc, opts);
    case "extracting":
      return extractStep(store, doc, opts);
    case "reconciling":
      return reconcileStep(store, doc, opts);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function loadAndExtract(store: FcStore, doc: FcDocument): Promise<ExtractedDocument> {
  const raw = await store.loadRawFile(doc.id);
  if (!raw) throw new Error(`raw file for document ${doc.id} is missing`);
  return extractDocument(doc.filename, raw.bytes);
}

async function markFailed(store: FcStore, doc: FcDocument, message: string): Promise<JobStepResult> {
  await store.updateDocument(doc.id, { status: "failed", error: message });
  return { status: "failed", progress: doc.progress, message };
}

function isFatal(err: unknown): err is Error {
  return err instanceof ScanDetectedError || err instanceof UnsupportedFileError;
}

function sectionFor(sections: FcSection[], page: number | undefined): FcSection | null {
  if (page == null) return null;
  return (
    sections.find((s) => s.pageStart != null && s.pageEnd != null && page >= s.pageStart && page <= s.pageEnd) ??
    null
  );
}

function toNewCard(
  documentId: string,
  sections: FcSection[],
  card: ExtractedCard,
  status: NewFcCard["status"],
): NewFcCard | null {
  const question = card.question.trim();
  if (question.length === 0) return null;
  const sourcePages = [...new Set(card.source_pages.filter((p) => p > 0))].sort((a, b) => a - b);
  const section = sectionFor(sections, sourcePages[0]);
  const topic = card.topic.trim() || section?.title || "General";
  return {
    documentId,
    sectionId: section?.id ?? null,
    topic,
    question,
    options: card.options.map((o) => o.trim()).filter((o) => o.length > 0),
    answer: card.answer.trim(),
    qnum: card.qnum.trim() || null,
    sourcePages,
    confidence: Math.min(Math.max(card.confidence, 0), 1),
    status,
    qhash: qhashOf(question),
  };
}

function requireCheckpoint(doc: FcDocument): FcCheckpoint {
  if (!doc.checkpoint) {
    throw new Error(`document ${doc.id} is in status "${doc.status}" but has no checkpoint — re-upload it`);
  }
  return doc.checkpoint;
}

function ensureClient(opts: JobStepOptions): { client: Anthropic; cost: CostTracker } {
  return { client: opts.client ?? createFcAnthropicClient(), cost: opts.cost ?? new CostTracker() };
}

// ---------------------------------------------------------------------------
// step 1 — survey
// ---------------------------------------------------------------------------

async function surveyStep(store: FcStore, doc: FcDocument, opts: JobStepOptions): Promise<JobStepResult> {
  if (doc.status === "uploaded") {
    await store.updateDocument(doc.id, { status: "surveying" });
  }

  let extracted: ExtractedDocument;
  try {
    extracted = await loadAndExtract(store, doc);
  } catch (err) {
    if (isFatal(err)) return markFailed(store, doc, err.message);
    throw err;
  }

  const { client, cost } = ensureClient(opts);
  const survey = await runSurveyPass(client, cost, doc.filename, extracted.pages);

  let windows = planWindows(extracted.pages, survey);
  const plannedWindows = windows.length;
  let capped = false;
  if (opts.docBudgetUsd != null && plannedWindows * EST_WINDOW_USD > opts.docBudgetUsd) {
    const cap = opts.maxWindows ?? DEFAULT_WINDOW_CAP;
    if (plannedWindows > cap) {
      windows = windows.slice(0, cap);
      capped = true;
    }
  }

  const sections = survey.sections.map((s, i) => ({
    title: s.title,
    ord: i,
    pageStart: s.page_start,
    pageEnd: s.page_end,
  }));
  await store.replaceSections(doc.id, sections);

  const checkpoint: FcCheckpoint = {
    survey,
    windows,
    plannedWindows,
    capped,
    orphanQuestions: [],
    orphanAnswers: [],
    stats: { autoCards: 0, deterministicPairs: 0, llmPairs: 0, needsReview: 0 },
  };
  const progress = { done: 0, total: windows.length };
  const status = windows.length === 0 ? ("reconciling" as const) : ("extracting" as const);
  await store.updateDocument(doc.id, {
    status,
    layout: survey.layout,
    toc: survey.sections,
    checkpoint,
    progress,
    pageCount: extracted.pageCount,
  });

  const message = capped
    ? `survey done — layout "${survey.layout}"; projected cost over budget, capped to first ${windows.length} of ${plannedWindows} windows`
    : `survey done — layout "${survey.layout}", ${survey.sections.length} sections, ${windows.length} windows planned`;
  return { status, progress, message };
}

// ---------------------------------------------------------------------------
// step 2..n — one extraction window per invocation
// ---------------------------------------------------------------------------

async function extractStep(store: FcStore, doc: FcDocument, opts: JobStepOptions): Promise<JobStepResult> {
  const checkpoint = requireCheckpoint(doc);
  const index = doc.progress.done;
  const total = doc.progress.total;
  const window = checkpoint.windows[index];
  if (!window) {
    // Progress already covers every window (e.g. crash after the final update).
    await store.updateDocument(doc.id, { status: "reconciling" });
    return { status: "reconciling", progress: doc.progress };
  }

  let extracted: ExtractedDocument;
  try {
    extracted = await loadAndExtract(store, doc);
  } catch (err) {
    if (isFatal(err)) return markFailed(store, doc, err.message);
    throw err;
  }

  const { client, cost } = ensureClient(opts);
  const keyMode =
    checkpoint.survey.answer_key_pages.length > 0 &&
    (checkpoint.survey.layout === "answer-key" || checkpoint.survey.layout === "mixed");
  const keyMap = keyMode ? buildAnswerKeyMap(extracted.pages, checkpoint.survey.answer_key_pages) : null;

  const result = await runExtractionPass(client, cost, {
    filename: doc.filename,
    survey: checkpoint.survey,
    pages: extracted.pages,
    window,
    windowIndex: index,
    windowCount: total,
    keyMap,
  });

  const sections = await store.listSections(doc.id);
  const autoCards: NewFcCard[] = [];
  for (const card of result.cards) {
    const built = toNewCard(doc.id, sections, card, "auto");
    if (!built) continue;
    if (built.answer.length === 0) {
      // A card without an answer is an orphan question, whatever the model called it.
      checkpoint.orphanQuestions.push({
        qnum: built.qnum ?? "",
        topic: built.topic,
        question: built.question,
        options: built.options,
        source_pages: built.sourcePages,
      });
      continue;
    }
    autoCards.push(built);
  }
  const inserted = await store.insertCards(autoCards);

  checkpoint.orphanQuestions.push(...result.orphan_questions.filter((q) => q.question.trim().length > 0));
  checkpoint.orphanAnswers.push(...result.orphan_answers.filter((a) => a.answer.trim().length > 0));
  checkpoint.stats.autoCards += inserted;

  const done = index + 1;
  const status = done >= total ? ("reconciling" as const) : ("extracting" as const);
  const progress = { done, total };
  const cardCount = await store.countCards(doc.id);
  await store.updateDocument(doc.id, { checkpoint, progress, status, cardCount });

  return {
    status,
    progress,
    cardCount,
    message: `window ${done}/${total}: ${inserted} new cards, ${result.orphan_questions.length}+${result.orphan_answers.length} orphans`,
  };
}

// ---------------------------------------------------------------------------
// final step — reconciliation
// ---------------------------------------------------------------------------

async function reconcileStep(store: FcStore, doc: FcDocument, opts: JobStepOptions): Promise<JobStepResult> {
  const checkpoint = requireCheckpoint(doc);
  const sections = await store.listSections(doc.id);

  const { questions, answers } = dedupeOrphans(checkpoint.orphanQuestions, checkpoint.orphanAnswers);
  const det = deterministicReconcile(questions, answers);

  let llmCards: ExtractedCard[] = [];
  let remainingQuestions: OrphanQuestion[] = det.remainingQuestions;
  let remainingAnswers: OrphanAnswer[] = det.remainingAnswers;
  if (remainingQuestions.length > 0 && remainingAnswers.length > 0) {
    const { client, cost } = ensureClient(opts);
    const llm = await runReconcilePass(client, cost, doc.filename, remainingQuestions, remainingAnswers);
    llmCards = llm.cards;
    remainingQuestions = remainingQuestions.filter((_, i) => !llm.pairedQuestionIdx.has(i));
    remainingAnswers = remainingAnswers.filter((_, i) => !llm.pairedAnswerIdx.has(i));
  }

  const resolved: NewFcCard[] = [];
  for (const card of [...det.matched, ...llmCards]) {
    const built = toNewCard(doc.id, sections, card, "auto");
    if (built && built.answer.length > 0) resolved.push(built);
  }

  // Unmatched → needs_review, so nothing silently disappears (§2 pass 3).
  const needsReview: NewFcCard[] = [];
  for (const q of remainingQuestions) {
    const built = toNewCard(
      doc.id,
      sections,
      { topic: q.topic, question: q.question, options: q.options, answer: "", qnum: q.qnum, confidence: 0, source_pages: q.source_pages },
      "needs_review",
    );
    if (built) needsReview.push(built);
  }
  for (const a of remainingAnswers) {
    const syntheticQuestion = `[Unmatched answer${a.qnum ? ` for Q${a.qnum}` : ""}] ${a.answer.slice(0, 80)}`;
    const built = toNewCard(
      doc.id,
      sections,
      { topic: "", question: syntheticQuestion, options: [], answer: a.answer, qnum: a.qnum, confidence: 0, source_pages: a.source_pages },
      "needs_review",
    );
    if (built) needsReview.push(built);
  }

  const insertedResolved = await store.insertCards(resolved);
  const insertedNeedsReview = await store.insertCards(needsReview);

  checkpoint.stats.deterministicPairs = det.qnumPairs + det.prefixPairs;
  checkpoint.stats.llmPairs = llmCards.length;
  checkpoint.stats.needsReview = insertedNeedsReview;
  // Orphans are resolved — drop them from the stored checkpoint, keep the map + stats.
  checkpoint.orphanQuestions = [];
  checkpoint.orphanAnswers = [];

  const cardCount = await store.countCards(doc.id);
  await store.updateDocument(doc.id, { status: "ready", checkpoint, cardCount });

  return {
    status: "ready",
    progress: doc.progress,
    cardCount,
    message:
      `reconciled: ${insertedResolved} recovered pairs ` +
      `(${det.qnumPairs} by number, ${det.prefixPairs} by prefix, ${llmCards.length} by cleanup call), ` +
      `${insertedNeedsReview} sent to needs_review`,
  };
}
