// Zod schemas for every LLM pass of the flashcard pipeline
// (docs/FLASHCARDS.md §2). These are API-enforced via structured outputs
// (zodOutputFormat), which forces additionalProperties:false and requires
// every field — so nothing here is .optional(); "absent" is modelled as an
// empty string / empty array (same constraint noted in DECISIONS.md
// 2026-08-13 for the case generators).

import { z } from "zod";

// ---------------------------------------------------------------------------
// Pass 1 — survey
// ---------------------------------------------------------------------------

export const SurveySectionSchema = z.object({
  title: z.string(),
  /** Inclusive 1-based page range. */
  page_start: z.number().int(),
  page_end: z.number().int(),
});

export const SurveySchema = z.object({
  layout: z.enum(["inline-qa", "answer-key", "notes-only", "mixed"]),
  sections: z.array(SurveySectionSchema),
  /** Pages holding the collected answers (answer-key / mixed layouts). Empty otherwise. */
  answer_key_pages: z.array(z.number().int()),
  /** Cover pages, TOC, indexes, blank/ad pages — nothing worth extracting. */
  junk_pages: z.array(z.number().int()),
});

export type SurveySection = z.infer<typeof SurveySectionSchema>;
export type SurveyResult = z.infer<typeof SurveySchema>;

// ---------------------------------------------------------------------------
// Pass 2 — windowed extraction
// ---------------------------------------------------------------------------

export const ExtractedCardSchema = z.object({
  /** Short study topic, e.g. "Cardiology — heart failure". "" when unclear. */
  topic: z.string(),
  /**
   * The governing vignette/case stem, copied VERBATIM. Required (structured
   * outputs allow no optionals) — "" when the question is already
   * self-contained. This is the fix for the sub-questions that shipped with
   * their case stem discarded ("How do you manage the patient?" — which one?).
   */
  context: z.string(),
  /**
   * Shared id for every sub-question hanging off one stem, unique within the
   * window (e.g. "v1", "v2"). "" for standalone questions.
   */
  group_id: z.string(),
  /** The complete question stem, verbatim from the document. */
  question: z.string(),
  /** MCQ options verbatim (with their letters), in order. Empty for open questions. */
  options: z.array(z.string()),
  /** The document's answer (for MCQs: the correct option restated + any explanation). */
  answer: z.string(),
  /** The question number as printed ("12", "3b"). "" when unnumbered. */
  qnum: z.string(),
  /** 0..1 — how certain the Q and A genuinely belong together. */
  confidence: z.number(),
  /** 1-based page numbers (from the [page N] markers) the card was read from. */
  source_pages: z.array(z.number().int()),
});

export const OrphanQuestionSchema = z.object({
  qnum: z.string(),
  topic: z.string(),
  /** The governing vignette, verbatim, so an orphan keeps its stem through reconciliation. */
  context: z.string(),
  group_id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  source_pages: z.array(z.number().int()),
});

export const OrphanAnswerSchema = z.object({
  qnum: z.string(),
  answer: z.string(),
  source_pages: z.array(z.number().int()),
});

export const WindowExtractionSchema = z.object({
  cards: z.array(ExtractedCardSchema),
  orphan_questions: z.array(OrphanQuestionSchema),
  orphan_answers: z.array(OrphanAnswerSchema),
});

export type ExtractedCard = z.infer<typeof ExtractedCardSchema>;
export type OrphanQuestion = z.infer<typeof OrphanQuestionSchema>;
export type OrphanAnswer = z.infer<typeof OrphanAnswerSchema>;
export type WindowExtraction = z.infer<typeof WindowExtractionSchema>;

// ---------------------------------------------------------------------------
// Pass 3 — reconciliation (LLM cleanup for survivors of deterministic matching)
// ---------------------------------------------------------------------------

// The model only *matches* — it never rewrites content. Cards are materialised
// in code from the original orphan text, so a hallucinated pair can at worst
// mispair existing text, never invent an answer.
export const ReconcilePairSchema = z.object({
  /** Id of the orphan question, as given ("Q1", "Q2", ...). */
  question_id: z.string(),
  /** Id of the orphan answer, as given ("A1", "A2", ...). */
  answer_id: z.string(),
  /** 0..1 — confidence the two belong together. */
  confidence: z.number(),
});

export const ReconcileSchema = z.object({
  pairs: z.array(ReconcilePairSchema),
});

export type ReconcilePair = z.infer<typeof ReconcilePairSchema>;
export type ReconcileResult = z.infer<typeof ReconcileSchema>;
