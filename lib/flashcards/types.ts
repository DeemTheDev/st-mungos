// Shared types for the flashcards wing (docs/FLASHCARDS.md).
// Pure types only — no imports from Next, Supabase or the Anthropic SDK, so
// both the API routes and the CLI test script can use them freely.

import type { OrphanAnswer, OrphanQuestion, SurveyResult, SurveySection } from "./schema";

export type FcDocStatus =
  | "uploaded"
  | "surveying"
  | "extracting"
  | "reconciling"
  | "ready"
  | "failed";

export type FcLayout = "inline-qa" | "answer-key" | "notes-only" | "mixed";

export interface FcProgress {
  done: number;
  total: number;
}

/** One extraction window = a run of consecutive content pages. */
export interface FcWindow {
  pages: number[];
}

/**
 * Pipeline checkpoint, persisted on the document row so a killed job resumes
 * at the last completed window (docs/FLASHCARDS.md §2 job orchestration).
 */
export interface FcCheckpoint {
  survey: SurveyResult;
  windows: FcWindow[];
  /** Window count before any budget cap was applied. */
  plannedWindows: number;
  /** True when the window list was truncated to stay under a cost budget. */
  capped: boolean;
  orphanQuestions: OrphanQuestion[];
  orphanAnswers: OrphanAnswer[];
  stats: FcPipelineStats;
}

export interface FcPipelineStats {
  autoCards: number;
  deterministicPairs: number;
  llmPairs: number;
  needsReview: number;
}

export interface FcDocument {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  status: FcDocStatus;
  progress: FcProgress;
  layout: FcLayout | null;
  /** Survey section map (document "table of contents"). */
  toc: SurveySection[] | null;
  checkpoint: FcCheckpoint | null;
  pageCount: number | null;
  cardCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FcSection {
  id: string;
  documentId: string;
  title: string;
  ord: number;
  pageStart: number | null;
  pageEnd: number | null;
}

export type FcCardStatus = "auto" | "needs_review";

export interface FcCard {
  id: string;
  documentId: string;
  sectionId: string | null;
  topic: string;
  question: string;
  /** MCQ options, kept on the card front. Empty for open questions. */
  options: string[];
  answer: string;
  qnum: string | null;
  /** 1-based source pages (approximate character-offset pages for DOCX). */
  sourcePages: number[];
  confidence: number | null;
  status: FcCardStatus;
  /** Normalized-question hash — the per-document dedupe key. */
  qhash: string;
  createdAt: string;
}

export type NewFcCard = Omit<FcCard, "id" | "createdAt">;

export type FcGrade = "again" | "hard" | "good" | "easy";

export type FcReviewState = "New" | "Learning" | "Review" | "Relearning";

/** FSRS scheduling state for one card (docs/FLASHCARDS.md §4 fc_reviews). */
export interface FcReview {
  cardId: string;
  dueAt: string; // ISO timestamp
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: FcReviewState;
  scheduledDays: number;
  learningSteps: number;
  lastGrade: FcGrade | null;
  lastReviewedAt: string | null; // ISO timestamp
}

/** Slim card+review projection used by deck summaries and the review queue. */
export interface FcCardMeta {
  id: string;
  documentId: string;
  sectionId: string | null;
  topic: string;
  status: FcCardStatus;
  /** Due timestamp when a review row exists; null = never studied ("new"). */
  dueAt: string | null;
  state: FcReviewState | null;
}

/** Result of one job-runner step (the /job/[id]/step response body). */
export interface JobStepResult {
  status: FcDocStatus;
  progress: FcProgress;
  message?: string;
  cardCount?: number;
}
