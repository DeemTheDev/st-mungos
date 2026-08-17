// FSRS scheduling (docs/FLASHCARDS.md §5) via ts-fsrs.
// - grade(card, again|hard|good|easy) → next FSRS state
// - cram mode: EXAM_DATE (YYYY-MM-DD, optional) caps intervals so due_at never
//   lands after the exam — retention targeted at the exam, not the ideal curve
// - review queue: due cards interleaved across topics, shuffled by a seeded
//   hash that is stable within a (local) day; new cards follow the same way.
//   Two invariants ride on top of the interleaving:
//     * cards that share a group_id (the sub-questions of one vignette) move as
//       one block, so the case she is reasoning about isn't scattered across
//       weeks. Interleaving still happens BETWEEN blocks — it is the
//       evidence-based bit and it stays.
//     * cards that are not self-contained never enter the queue at all.

import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from "ts-fsrs";

import { isSelfContained } from "./self-contained";
import type { FcGrade, FcReview, FcReviewState } from "./types";

const RATING: Record<FcGrade, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const STATE_TO_NAME: Record<State, FcReviewState> = {
  [State.New]: "New",
  [State.Learning]: "Learning",
  [State.Review]: "Review",
  [State.Relearning]: "Relearning",
};

const NAME_TO_STATE: Record<FcReviewState, State> = {
  New: State.New,
  Learning: State.Learning,
  Review: State.Review,
  Relearning: State.Relearning,
};

export function isFcGrade(value: unknown): value is FcGrade {
  return value === "again" || value === "hard" || value === "good" || value === "easy";
}

/**
 * EXAM_DATE=YYYY-MM-DD → end of that local day, or null when unset/invalid.
 * Local date parts, never toISOString — a UTC shift moves the exam a day.
 */
export function parseExamDate(raw: string | undefined = process.env.EXAM_DATE): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toFsrsCard(review: FcReview): Card {
  return {
    due: new Date(review.dueAt),
    stability: review.stability,
    difficulty: review.difficulty,
    elapsed_days: 0, // deprecated in ts-fsrs; not used by next()
    scheduled_days: review.scheduledDays,
    learning_steps: review.learningSteps,
    reps: review.reps,
    lapses: review.lapses,
    state: NAME_TO_STATE[review.state],
    last_review: review.lastReviewedAt ? new Date(review.lastReviewedAt) : undefined,
  };
}

/**
 * Grade one card. `prev` is null for a never-studied card. Deterministic
 * (fuzz disabled) so re-grading in tests is reproducible.
 */
export function gradeReview(
  cardId: string,
  prev: FcReview | null,
  grade: FcGrade,
  now: Date = new Date(),
  examDate: Date | null = parseExamDate(),
): FcReview {
  const scheduler = fsrs({ enable_fuzz: false });
  const card: Card = prev ? toFsrsCard(prev) : createEmptyCard(now);
  const { card: next } = scheduler.next(card, now, RATING[grade]);

  // Cram mode: never schedule past the exam. Only caps future-dated exams —
  // once the exam has passed, normal FSRS scheduling resumes.
  let due = next.due;
  if (examDate && examDate.getTime() > now.getTime() && due.getTime() > examDate.getTime()) {
    due = examDate;
  }

  return {
    cardId,
    dueAt: due.toISOString(),
    stability: next.stability,
    difficulty: next.difficulty,
    reps: next.reps,
    lapses: next.lapses,
    state: STATE_TO_NAME[next.state],
    scheduledDays: next.scheduled_days,
    learningSteps: next.learning_steps,
    lastGrade: grade,
    lastReviewedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// review queue (interleaving, docs/FLASHCARDS.md §5.3)
// ---------------------------------------------------------------------------

export interface QueueEntry {
  id: string;
  topic: string;
  /** Due timestamp; null = new (never studied). */
  dueAt: string | null;
  /** Front-of-card text — the queue re-checks self-containment before serving. */
  question: string;
  context: string;
  /** Sub-questions of one vignette share this; they are kept adjacent. */
  groupId: string | null;
  /** Printed question number ("5.8"), used to order siblings within a vignette. */
  qnum: string | null;
}

/** Local-date key (never toISOString — UTC shift breaks day bucketing). */
export function localDayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function endOfLocalDay(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A scheduling unit: one standalone card, or every sub-question of one
 * vignette. Groups move through the queue as a block so the case she is
 * reasoning about stays intact — interleaving happens BETWEEN units, not
 * inside them (docs/FLASHCARDS.md §5.5).
 */
interface QueueUnit {
  key: string;
  topic: string;
  entries: QueueEntry[];
}

/** Sub-question order within a vignette: 5.2 before 5.10, unnumbered last. */
function qnumLess(a: QueueEntry, b: QueueEntry): number {
  const parse = (qnum: string | null): number[] =>
    (qnum?.match(/\d+(?:\.\d+)*/)?.[0] ?? "").split(".").filter(Boolean).map(Number);
  const pa = parse(a.qnum);
  const pb = parse(b.qnum);
  if (pa.length === 0 !== (pb.length === 0)) return pa.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return a.id.localeCompare(b.id);
}

function toUnits(entries: QueueEntry[]): QueueUnit[] {
  const groups = new Map<string, QueueUnit>();
  const units: QueueUnit[] = [];
  for (const e of entries) {
    if (!e.groupId) {
      units.push({ key: e.id, topic: e.topic, entries: [e] });
      continue;
    }
    const existing = groups.get(e.groupId);
    if (existing) {
      existing.entries.push(e);
      continue;
    }
    const unit: QueueUnit = { key: e.groupId, topic: e.topic, entries: [e] };
    groups.set(e.groupId, unit);
    units.push(unit);
  }
  for (const unit of units) if (unit.entries.length > 1) unit.entries.sort(qnumLess);
  return units;
}

/**
 * Interleave units across topics: topics and units-within-topic are ordered
 * by a hash seeded with the local day (stable within a day, reshuffles
 * tomorrow), then merged round-robin so consecutive units switch topics.
 */
function interleaveByTopic(entries: QueueEntry[], dayKey: string): QueueEntry[] {
  const byTopic = new Map<string, QueueUnit[]>();
  for (const u of toUnits(entries)) {
    const list = byTopic.get(u.topic) ?? [];
    list.push(u);
    byTopic.set(u.topic, list);
  }
  const topics = [...byTopic.keys()].sort(
    (a, b) => fnv1a(`${dayKey}:${a}`) - fnv1a(`${dayKey}:${b}`),
  );
  for (const topic of topics) {
    byTopic.get(topic)!.sort((a, b) => fnv1a(`${dayKey}:${a.key}`) - fnv1a(`${dayKey}:${b.key}`));
  }
  const out: QueueEntry[] = [];
  let round = 0;
  let added = true;
  while (added) {
    added = false;
    for (const topic of topics) {
      const list = byTopic.get(topic)!;
      if (round < list.length) {
        out.push(...list[round].entries);
        added = true;
      }
    }
    round += 1;
  }
  return out;
}

/**
 * Build today's review queue: cards due today first (interleaved across
 * topics/vignettes), then new cards (same interleaving).
 *
 * FAIL CLOSED: a card that isn't self-contained never enters the queue, even
 * if it is due and marked "auto". The extraction prompt and the write-time
 * check should both have caught it already — this is the last line, and it has
 * to hold for rows that predate either of them.
 */
export function buildReviewQueue(entries: QueueEntry[], now: Date = new Date()): QueueEntry[] {
  const dayKey = localDayKey(now);
  const cutoff = endOfLocalDay(now).getTime();
  const studiable = entries.filter((e) => isSelfContained({ context: e.context, question: e.question }));
  const due = studiable.filter((e) => e.dueAt !== null && new Date(e.dueAt).getTime() <= cutoff);
  const fresh = studiable.filter((e) => e.dueAt === null);
  return [...interleaveByTopic(due, dayKey), ...interleaveByTopic(fresh, `${dayKey}:new`)];
}

/** The entries buildReviewQueue would refuse to serve — the "needs a look" set. */
export function danglingEntries(entries: QueueEntry[]): QueueEntry[] {
  return entries.filter((e) => !isSelfContained({ context: e.context, question: e.question }));
}
