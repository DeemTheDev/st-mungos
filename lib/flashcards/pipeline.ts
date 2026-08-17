// The three-pass flashcard pipeline (docs/FLASHCARDS.md §2):
//   pass 1 — survey (document skeleton → layout/sections/answer-key/junk map)
//   pass 2 — windowed extraction (~3k-token windows, ~15% overlap; answer-key
//             layouts pair each window with its matching key slice by qnum)
//   pass 3 — reconciliation (deterministic qnum/prefix matching first, then
//             ONE cleanup call for survivors; unmatched → needs_review)
// Everything here is pure with respect to storage — the job runner (job.ts)
// owns persistence and checkpointing.

import { createHash } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";

import { fcStructuredCall, type CostTracker } from "./anthropic";
import type { ExtractedPage } from "./extract";
import {
  ReconcileSchema,
  SurveySchema,
  WindowExtractionSchema,
  type ExtractedCard,
  type OrphanAnswer,
  type OrphanQuestion,
  type ReconcilePair,
  type SurveyResult,
  type WindowExtraction,
} from "./schema";
import type { FcWindow } from "./types";

// ---------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------

/** ~3k tokens per window at ~4 chars/token. */
const WINDOW_TARGET_CHARS = 12_000;
/** ~15% overlap so a pair split across a boundary appears whole somewhere. */
const WINDOW_OVERLAP = 0.15;
/** Per-page skeleton excerpt for the survey pass. */
const SKELETON_PAGE_CHARS = 300;
const SKELETON_MAX_CHARS = 150_000;
/** Cap on the answer-key slice appended to a window. */
const KEY_SLICE_MAX_CHARS = 6_000;
/** Orphans beyond this go straight to needs_review instead of the LLM call. */
const RECONCILE_LLM_MAX_ITEMS = 250;

const SURVEY_MAX_TOKENS = 4_000;
const EXTRACT_MAX_TOKENS = 12_000;
const RECONCILE_MAX_TOKENS = 8_000;

// ---------------------------------------------------------------------------
// question normalisation + hashing (cross-window dedupe key)
// ---------------------------------------------------------------------------

export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/^\s*(?:q(?:uestion)?\s*)?\d{1,3}\s*[.):\-–]\s*/, "") // strip leading numbering
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function qhashOf(question: string): string {
  return createHash("sha256").update(normalizeQuestion(question)).digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// pass 1 — survey
// ---------------------------------------------------------------------------

const SURVEY_SYSTEM = `You are the SURVEY pass of a flashcard-extraction pipeline for a medical student's study documents. You receive a SKELETON of one document: for every page, its 1-based page number and the first ~300 characters, plus any heading-like lines; pages that look like a table of contents are included in full. Map the document so later passes know where to extract question/answer pairs and what to skip.

Classify the LAYOUT:
- "inline-qa": questions and their answers sit together in the text (e.g. "1. Question ... Answer: ..." or Q&A alternating).
- "answer-key": a bank of numbered questions whose answers are collected separately, typically at the end (e.g. an "Answers" section listing "1. C", "2. A — because ...").
- "notes-only": prose or study notes with no explicit question/answer structure.
- "mixed": a genuine mixture (e.g. some chapters inline Q&A, others notes, or several question banks each with its own key).

SECTIONS: split the document into its natural chapters/topics using headings and the table of contents. Use inclusive 1-based page ranges in reading order that cover the content without overlapping. Give each section a short clean title (e.g. "Cardiology — MCQs"). If the document shows no structure, return a single section spanning all pages, titled after the document's subject.

ANSWER_KEY_PAGES: the pages holding the collected answers, when layout is "answer-key" or "mixed". Empty array otherwise. Answer-key pages are NOT junk.

JUNK_PAGES: cover/title pages, tables of contents, indexes, blank pages, advertising, copyright or disclaimer pages — pages with no study content worth paying to extract. Be conservative: when unsure whether a page is junk, leave it in (do not list it).

Base everything strictly on the skeleton you are shown. Do not invent sections or page numbers.`;

function headingLines(pageText: string): string[] {
  const out: string[] = [];
  for (const raw of pageText.split("\n").slice(0, 25)) {
    const line = raw.trim();
    if (line.length < 3 || line.length > 80) continue;
    const letters = line.replace(/[^a-zA-Z]/g, "");
    if (letters.length < 3) continue;
    const upper = line.replace(/[^A-Z]/g, "");
    const isCaps = upper.length / letters.length >= 0.9;
    const isSectionish = /^(?:section|chapter|part|unit|topic|answers?)\b/i.test(line);
    if (isCaps || isSectionish) out.push(line);
    if (out.length >= 3) break;
  }
  return out;
}

function looksLikeToc(pageText: string): boolean {
  return /(?:table\s+of\s+)?contents/i.test(pageText.slice(0, 300));
}

/** Per-page first ~300 chars + heading-like lines + verbatim TOC pages. */
export function buildSkeleton(pages: ExtractedPage[]): string {
  const parts: string[] = [];
  for (const p of pages) {
    if (looksLikeToc(p.text)) {
      parts.push(`=== page ${p.page} (table of contents, verbatim) ===\n${p.text.slice(0, 4000)}`);
      continue;
    }
    const excerpt = p.text.slice(0, SKELETON_PAGE_CHARS).replace(/\n{2,}/g, "\n");
    const headings = headingLines(p.text);
    parts.push(
      `=== page ${p.page} ===\n${excerpt}${headings.length > 0 ? `\n[headings] ${headings.join(" | ")}` : ""}`,
    );
  }
  return parts.join("\n\n").slice(0, SKELETON_MAX_CHARS);
}

export async function runSurveyPass(
  client: Anthropic,
  cost: CostTracker,
  filename: string,
  pages: ExtractedPage[],
): Promise<SurveyResult> {
  const skeleton = buildSkeleton(pages);
  const user = `DOCUMENT: ${filename}\nTOTAL PAGES: ${pages.length}\n\nSKELETON:\n\n${skeleton}`;
  const survey = await fcStructuredCall({
    client,
    cost,
    system: SURVEY_SYSTEM,
    user,
    schema: SurveySchema,
    maxTokens: SURVEY_MAX_TOKENS,
    label: `survey ${filename}`,
  });
  // Clamp model-supplied page numbers to the document's real range.
  const maxPage = pages.length;
  const clamp = (n: number) => Math.min(Math.max(1, Math.round(n)), maxPage);
  return {
    layout: survey.layout,
    sections: survey.sections
      .map((s) => ({ title: s.title.trim() || "Untitled", page_start: clamp(s.page_start), page_end: clamp(s.page_end) }))
      .map((s) => (s.page_end < s.page_start ? { ...s, page_end: s.page_start } : s)),
    answer_key_pages: [...new Set(survey.answer_key_pages.map(clamp))].sort((a, b) => a - b),
    junk_pages: [...new Set(survey.junk_pages.map(clamp))].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------------------
// window planning
// ---------------------------------------------------------------------------

function answerKeyMode(survey: SurveyResult): boolean {
  return survey.answer_key_pages.length > 0 && (survey.layout === "answer-key" || survey.layout === "mixed");
}

/**
 * Chunk the content pages (junk and answer-key pages excluded) into ~3k-token
 * windows with ~15% page overlap. Windows are page spans, so re-running the
 * planner over the same extraction is deterministic.
 */
export function planWindows(pages: ExtractedPage[], survey: SurveyResult): FcWindow[] {
  const excluded = new Set<number>(survey.junk_pages);
  if (answerKeyMode(survey)) for (const p of survey.answer_key_pages) excluded.add(p);

  const content = pages.filter((p) => !excluded.has(p.page) && p.text.length > 0);
  const windows: FcWindow[] = [];
  let i = 0;
  while (i < content.length) {
    let chars = 0;
    let j = i;
    const span: number[] = [];
    while (j < content.length && (chars === 0 || chars + content[j].text.length <= WINDOW_TARGET_CHARS)) {
      chars += content[j].text.length;
      span.push(content[j].page);
      j += 1;
    }
    windows.push({ pages: span });
    if (j >= content.length) break;
    // Step the next window back by ~15% of this window's characters.
    let back = 0;
    let overlapChars = 0;
    while (back < span.length - 1 && overlapChars < chars * WINDOW_OVERLAP) {
      overlapChars += content[j - 1 - back].text.length;
      back += 1;
    }
    i = Math.max(i + 1, j - back);
  }
  return windows;
}

// ---------------------------------------------------------------------------
// answer-key parsing (deterministic, code-side)
// ---------------------------------------------------------------------------

const QNUM_LINE_RE = /(?:^|\n)\s*(?:q(?:uestion)?\s*)?(\d{1,3})\s*[.):\-–]\s+/gi;

/** Question numbers that appear at line starts within a text block. */
export function qnumsInText(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(QNUM_LINE_RE)) {
    found.add(String(parseInt(match[1], 10)));
  }
  return [...found];
}

/**
 * Parse the collected answer-key pages into qnum → answer-text segments.
 * A segment runs from its number to the next number (continuing across pages).
 */
export function buildAnswerKeyMap(pages: ExtractedPage[], keyPages: number[]): Map<string, string> {
  const keySet = new Set(keyPages);
  const keyText = pages
    .filter((p) => keySet.has(p.page))
    .map((p) => p.text)
    .join("\n");
  const map = new Map<string, string>();
  const matches = [...keyText.matchAll(QNUM_LINE_RE)];
  for (let k = 0; k < matches.length; k++) {
    const m = matches[k];
    const qnum = String(parseInt(m[1], 10));
    const start = (m.index ?? 0) + m[0].length;
    const end = k + 1 < matches.length ? (matches[k + 1].index ?? keyText.length) : keyText.length;
    const segment = keyText.slice(start, end).trim();
    if (segment.length > 0 && !map.has(qnum)) map.set(qnum, segment);
  }
  return map;
}

/** The key slice for one window: the segments for qnums that appear in it. */
export function keySliceForWindow(windowText: string, keyMap: Map<string, string>): string | null {
  const qnums = qnumsInText(windowText)
    .filter((q) => keyMap.has(q))
    .sort((a, b) => Number(a) - Number(b));
  if (qnums.length === 0) return null;
  let slice = "";
  for (const q of qnums) {
    const next = `${q}. ${keyMap.get(q)}\n`;
    if (slice.length + next.length > KEY_SLICE_MAX_CHARS) break;
    slice += next;
  }
  return slice.trim() || null;
}

// ---------------------------------------------------------------------------
// pass 2 — windowed extraction
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = `You are the EXTRACTION pass of a flashcard pipeline for a medical student's study documents. You receive a WINDOW of consecutive pages from one document; each page starts with a marker line like "[page 12]". For answer-key documents, a matching ANSWER KEY SLICE follows the window — the collected answers for the question numbers that appear in this window. Your job is to transcribe complete question/answer flashcards from what is actually on the pages.

THE HARD RULES

1. NEVER INVENT AN ANSWER. Every answer must be text that appears in the window or in the answer key slice. If a question has no answer anywhere in what you were given, it is an ORPHAN QUESTION — emit it under orphan_questions, not as a card with a guessed answer. A wrong flashcard is worse than no flashcard: she will be studying these for a medical exam.
2. TRANSCRIBE, DON'T REWRITE. Keep the document's own wording for both question and answer. You may fix obvious extraction noise (broken hyphen-ation across lines, stray page headers glued mid-sentence, repeated whitespace) but never paraphrase clinical content, change numbers/doses/units, or "improve" the phrasing.
3. ONE CARD PER QUESTION. A card is one self-contained question plus the document's answer for it. Split multi-part questions ("a) ... b) ...") into separate cards only when each part has its own distinct answer; otherwise keep them together as one card.
4. COMPLETE PAIRS ONLY AT WINDOW EDGES. Windows overlap, so a pair cut off at the start or end of your window will appear whole in a neighbouring window. If a question at the very edge is missing its ending or its answer is cut off, emit the fragment as an orphan (orphan_questions / orphan_answers) rather than a mangled card — the pipeline reconciles orphans across windows later.

MCQ HANDLING

When a question has multiple-choice options (A/B/C/D..., or numbered choices):
- Put the full stem in "question" and every option verbatim (with its letter, e.g. "A. Furosemide") in "options", in order. The options belong on the card front, like the real exam.
- "answer" = the correct option restated in full (letter + text), followed by any explanation the document gives for it. E.g. "C. Sputum GeneXpert MTB/RIF — first-line confirmatory test for pulmonary TB in South Africa."
- If the document only says "Answer: C", still restate the option text: "C. <the option C text>".
- If the options are present but no answer is given anywhere (window or key slice), emit an orphan question WITH its options.

FIELD RULES

- topic: a short study topic for the card. Prefer the document's own section/chapter heading (the SECTIONS list in the user message tells you which section the pages belong to); otherwise the clinical subject, e.g. "Nephrology — acid-base". Keep topics consistent within a window: cards from the same section share the same topic string.
- qnum: the question number exactly as printed, digits only where possible ("12", "3"). "" when the question is unnumbered.
- source_pages: the [page N] numbers the question (and answer, when inline) was read from. Always at least one page.
- confidence: 1.0 when the pairing is explicit (inline answer or key match by number); around 0.7 when you paired by adjacency/format without an explicit link; 0.5 or below when genuinely unsure — and if you are below 0.5, prefer emitting orphans instead.
- orphan_answers: answer fragments that clearly answer SOME numbered question you don't have the stem for (e.g. a key slice entry whose question isn't in this window). Carry the qnum.

WHAT NOT TO EXTRACT

- Page headers/footers, page numbers, watermark text, instructions blocks ("Answer all questions", "Time allowed: ..."), section title lines by themselves, references/bibliographies.
- Prose that isn't question-shaped. Do NOT manufacture questions out of notes paragraphs — if this window is pure notes, return empty arrays. The pipeline has a separate path for notes.
- Duplicate questions you can see are repeats within the window: emit once.

WORKED EXAMPLE

Window text:
[page 7]
14. A 28-year-old woman presents with a 6-week productive cough, night sweats and weight loss. Which investigation confirms the diagnosis?
A. Chest X-ray
B. Sputum culture
C. Sputum GeneXpert MTB/RIF
D. Mantoux test
15. Name two causes of a raised anion gap metabolic acidosis.

Answer key slice:
14. C — GeneXpert is the first-line confirmatory test for PTB in SA.

Correct output (shapes abbreviated):
- cards: [ { topic: "Respiratory — TB", question: "A 28-year-old woman presents with a 6-week productive cough, night sweats and weight loss. Which investigation confirms the diagnosis?", options: ["A. Chest X-ray", "B. Sputum culture", "C. Sputum GeneXpert MTB/RIF", "D. Mantoux test"], answer: "C. Sputum GeneXpert MTB/RIF — GeneXpert is the first-line confirmatory test for PTB in SA.", qnum: "14", confidence: 1, source_pages: [7] } ]
- orphan_questions: [ { qnum: "15", topic: "Renal — acid-base", question: "Name two causes of a raised anion gap metabolic acidosis.", options: [], source_pages: [7] } ]
- orphan_answers: []

(Question 15 is an orphan because no answer for it exists in this window or the key slice — its answer will be matched from another window later. It would be wrong to answer it from your own medical knowledge.)`;

export interface ExtractionInput {
  filename: string;
  survey: SurveyResult;
  pages: ExtractedPage[];
  window: FcWindow;
  windowIndex: number;
  windowCount: number;
  /** Prebuilt qnum → answer segment map (answer-key mode only). */
  keyMap: Map<string, string> | null;
}

function sectionsSummary(survey: SurveyResult): string {
  if (survey.sections.length === 0) return "(none detected)";
  return survey.sections.map((s) => `- ${s.title} (pages ${s.page_start}-${s.page_end})`).join("\n");
}

export function buildWindowText(pages: ExtractedPage[], window: FcWindow): string {
  const byPage = new Map(pages.map((p) => [p.page, p.text]));
  return window.pages.map((n) => `[page ${n}]\n${byPage.get(n) ?? ""}`).join("\n\n");
}

export async function runExtractionPass(
  client: Anthropic,
  cost: CostTracker,
  input: ExtractionInput,
): Promise<WindowExtraction> {
  const windowText = buildWindowText(input.pages, input.window);
  const keySlice = input.keyMap ? keySliceForWindow(windowText, input.keyMap) : null;
  const user =
    `DOCUMENT: ${input.filename}\n` +
    `DOCUMENT LAYOUT (from survey): ${input.survey.layout}\n` +
    `SECTIONS:\n${sectionsSummary(input.survey)}\n\n` +
    `WINDOW ${input.windowIndex + 1} of ${input.windowCount} — pages ${input.window.pages[0]}-${input.window.pages[input.window.pages.length - 1]}:\n\n` +
    `${windowText}\n\n` +
    `ANSWER KEY SLICE (collected answers for question numbers found in this window):\n` +
    `${keySlice ?? "(none — pair inline, or emit orphans)"}`;

  return fcStructuredCall({
    client,
    cost,
    system: EXTRACT_SYSTEM,
    user,
    schema: WindowExtractionSchema,
    maxTokens: EXTRACT_MAX_TOKENS,
    label: `extract ${input.filename} w${input.windowIndex + 1}/${input.windowCount}`,
  });
}

// ---------------------------------------------------------------------------
// pass 3 — reconciliation
// ---------------------------------------------------------------------------

export interface DeterministicReconcileResult {
  /** Materialised cards from qnum / prefix matches. */
  matched: ExtractedCard[];
  remainingQuestions: OrphanQuestion[];
  remainingAnswers: OrphanAnswer[];
  qnumPairs: number;
  prefixPairs: number;
}

function materializeCard(q: OrphanQuestion, a: OrphanAnswer, confidence: number): ExtractedCard {
  return {
    topic: q.topic,
    question: q.question,
    options: q.options,
    answer: a.answer,
    qnum: q.qnum,
    confidence,
    source_pages: [...new Set([...q.source_pages, ...a.source_pages])].sort((x, y) => x - y),
  };
}

/** Dedupe orphan questions by normalized-question hash (windows overlap). */
export function dedupeOrphans(questions: OrphanQuestion[], answers: OrphanAnswer[]): {
  questions: OrphanQuestion[];
  answers: OrphanAnswer[];
} {
  const seenQ = new Set<string>();
  const outQ: OrphanQuestion[] = [];
  for (const q of questions) {
    if (q.question.trim().length === 0) continue;
    const h = qhashOf(q.question);
    if (seenQ.has(h)) continue;
    seenQ.add(h);
    outQ.push(q);
  }
  const seenA = new Set<string>();
  const outA: OrphanAnswer[] = [];
  for (const a of answers) {
    if (a.answer.trim().length === 0) continue;
    const h = `${a.qnum}::${createHash("sha256").update(a.answer.toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 16)}`;
    if (seenA.has(h)) continue;
    seenA.add(h);
    outA.push(a);
  }
  return { questions: outQ, answers: outA };
}

/** Deterministic matching: by question number first, then normalized prefix. */
export function deterministicReconcile(
  questions: OrphanQuestion[],
  answers: OrphanAnswer[],
): DeterministicReconcileResult {
  const matched: ExtractedCard[] = [];
  const usedAnswers = new Set<number>();
  const remainingQuestions: OrphanQuestion[] = [];
  let qnumPairs = 0;
  let prefixPairs = 0;

  // qnum → first unused answer with the same number
  const answersByQnum = new Map<string, number[]>();
  answers.forEach((a, idx) => {
    const q = a.qnum.trim();
    if (!q) return;
    const list = answersByQnum.get(q) ?? [];
    list.push(idx);
    answersByQnum.set(q, list);
  });

  for (const q of questions) {
    const qn = q.qnum.trim();
    let matchedIdx: number | null = null;
    if (qn) {
      for (const idx of answersByQnum.get(qn) ?? []) {
        if (!usedAnswers.has(idx)) {
          matchedIdx = idx;
          break;
        }
      }
    }
    if (matchedIdx == null) {
      // Prefix match: the answer text repeats the question's opening words.
      const prefix = normalizeQuestion(q.question).slice(0, 32);
      if (prefix.length >= 16) {
        for (let idx = 0; idx < answers.length; idx++) {
          if (usedAnswers.has(idx)) continue;
          const normAnswer = answers[idx].answer.toLowerCase().replace(/[^a-z0-9]+/g, " ");
          if (normAnswer.includes(prefix)) {
            matchedIdx = idx;
            prefixPairs += 1;
            break;
          }
        }
      }
    } else {
      qnumPairs += 1;
    }

    if (matchedIdx != null) {
      usedAnswers.add(matchedIdx);
      matched.push(materializeCard(q, answers[matchedIdx], 0.85));
    } else {
      remainingQuestions.push(q);
    }
  }

  const remainingAnswers = answers.filter((_, idx) => !usedAnswers.has(idx));
  return { matched, remainingQuestions, remainingAnswers, qnumPairs, prefixPairs };
}

const RECONCILE_SYSTEM = `You are the RECONCILIATION pass of a flashcard pipeline. Earlier passes extracted question/answer pairs from a medical study document but were left with ORPHANS: questions with no answer found, and answers with no question found (they came from different extraction windows). Deterministic matching by question number has already run — you get the survivors.

You are given a numbered list of orphan QUESTIONS (ids Q1, Q2, ...) and orphan ANSWERS (ids A1, A2, ...). Output the pairs you are CONFIDENT belong together, judged by:
- question numbering hints inside the text,
- the answer clearly addressing exactly that question's subject,
- MCQ answers whose option letter/text matches one of the question's options.

Rules:
- NEVER force a match. An unmatched orphan is expected and fine; a wrong pairing puts a wrong answer on a study card for a medical exam.
- Each question id and each answer id may appear in at most one pair.
- confidence: 0.9+ only for numbering/option-letter matches; 0.6–0.8 for strong content matches; below 0.6, leave the items unpaired instead.
- You only output ids — never rewrite the text.`;

export async function runReconcilePass(
  client: Anthropic,
  cost: CostTracker,
  filename: string,
  questions: OrphanQuestion[],
  answers: OrphanAnswer[],
): Promise<{ cards: ExtractedCard[]; pairedQuestionIdx: Set<number>; pairedAnswerIdx: Set<number> }> {
  const qs = questions.slice(0, RECONCILE_LLM_MAX_ITEMS);
  const as = answers.slice(0, RECONCILE_LLM_MAX_ITEMS);
  const user =
    `DOCUMENT: ${filename}\n\nORPHAN QUESTIONS:\n` +
    qs
      .map(
        (q, i) =>
          `Q${i + 1}${q.qnum ? ` (printed number ${q.qnum})` : ""}: ${q.question}${q.options.length > 0 ? `\n  options: ${q.options.join(" | ")}` : ""}`,
      )
      .join("\n") +
    `\n\nORPHAN ANSWERS:\n` +
    as.map((a, i) => `A${i + 1}${a.qnum ? ` (printed number ${a.qnum})` : ""}: ${a.answer}`).join("\n");

  const result = await fcStructuredCall({
    client,
    cost,
    system: RECONCILE_SYSTEM,
    user,
    schema: ReconcileSchema,
    maxTokens: RECONCILE_MAX_TOKENS,
    label: `reconcile ${filename}`,
  });

  const cards: ExtractedCard[] = [];
  const pairedQuestionIdx = new Set<number>();
  const pairedAnswerIdx = new Set<number>();
  for (const pair of result.pairs as ReconcilePair[]) {
    const qi = parseInt(pair.question_id.replace(/^q/i, ""), 10) - 1;
    const ai = parseInt(pair.answer_id.replace(/^a/i, ""), 10) - 1;
    if (Number.isNaN(qi) || Number.isNaN(ai)) continue;
    if (qi < 0 || qi >= qs.length || ai < 0 || ai >= as.length) continue;
    if (pairedQuestionIdx.has(qi) || pairedAnswerIdx.has(ai)) continue;
    if (pair.confidence < 0.6) continue;
    pairedQuestionIdx.add(qi);
    pairedAnswerIdx.add(ai);
    cards.push(materializeCard(qs[qi], as[ai], Math.min(Math.max(pair.confidence, 0), 1)));
  }
  return { cards, pairedQuestionIdx, pairedAnswerIdx };
}
