// GET /api/flashcards/decks — topics + sections with card counts and
// due-today counts (docs/FLASHCARDS.md §6). "Due" = has a review row with
// due_at inside today (local); "new" = never studied. needs_review cards are
// excluded from due/new (they're not studiable yet) but reported separately —
// and so is anything the review queue would refuse as not self-contained,
// otherwise a deck would advertise cards the player will never serve.
import { endOfLocalDay } from "@/lib/flashcards/fsrs";
import { requireFcAdmin } from "@/lib/flashcards/route-auth";
import { isSelfContained } from "@/lib/flashcards/self-contained";
import { getFcStore } from "@/lib/flashcards/store";

export const runtime = "nodejs";

interface Bucket {
  cardCount: number;
  dueCount: number;
  newCount: number;
  needsReviewCount: number;
}

function emptyBucket(): Bucket {
  return { cardCount: 0, dueCount: 0, newCount: 0, needsReviewCount: 0 };
}

export async function GET() {
  const unauthorised = await requireFcAdmin();
  if (unauthorised) return unauthorised;

  const store = getFcStore();
  const [documents, sections, meta] = await Promise.all([
    store.listDocuments(),
    store.listSections(),
    store.listCardMeta(),
  ]);

  const cutoff = endOfLocalDay().getTime();
  const topicBuckets = new Map<string, Bucket>();
  const sectionBuckets = new Map<string, Bucket>();
  const totals = emptyBucket();

  for (const card of meta) {
    const topicBucket = topicBuckets.get(card.topic) ?? emptyBucket();
    topicBuckets.set(card.topic, topicBucket);
    const sectionBucket = card.sectionId
      ? (sectionBuckets.get(card.sectionId) ?? emptyBucket())
      : null;
    if (card.sectionId && sectionBucket) sectionBuckets.set(card.sectionId, sectionBucket);

    const buckets = sectionBucket ? [topicBucket, sectionBucket, totals] : [topicBucket, totals];
    for (const b of buckets) {
      b.cardCount += 1;
      if (card.status === "needs_review" || !isSelfContained({ context: card.context, question: card.question })) {
        b.needsReviewCount += 1;
      } else if (card.dueAt === null) {
        b.newCount += 1;
      } else if (new Date(card.dueAt).getTime() <= cutoff) {
        b.dueCount += 1;
      }
    }
  }

  const docById = new Map(documents.map((d) => [d.id, d]));
  return Response.json({
    topics: [...topicBuckets.entries()]
      .map(([topic, b]) => ({ topic, ...b }))
      .sort((a, b) => a.topic.localeCompare(b.topic)),
    sections: sections.map((s) => {
      const b = sectionBuckets.get(s.id) ?? emptyBucket();
      return {
        id: s.id,
        documentId: s.documentId,
        filename: docById.get(s.documentId)?.filename ?? "",
        title: s.title,
        pageStart: s.pageStart,
        pageEnd: s.pageEnd,
        ...b,
      };
    }),
    totals,
  });
}
