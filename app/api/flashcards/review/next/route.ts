// POST /api/flashcards/review/next { topic? } — the next card to study:
// due cards first, interleaved across topics (seeded shuffle, stable within a
// day), then new cards (docs/FLASHCARDS.md §5). The answer is withheld —
// retrieval practice means she commits before /review/reveal shows it.
// Returns { card: null } when there's nothing due and nothing new.
import { buildReviewQueue } from "@/lib/flashcards/fsrs";
import { requireFcAdmin } from "@/lib/flashcards/route-auth";
import { getFcStore } from "@/lib/flashcards/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const unauthorised = await requireFcAdmin();
  if (unauthorised) return unauthorised;

  const body = (await request.json().catch(() => null)) as { topic?: unknown } | null;
  const topic = typeof body?.topic === "string" && body.topic.trim().length > 0 ? body.topic.trim() : undefined;

  const store = getFcStore();
  const meta = await store.listCardMeta({ topic });
  // needs_review cards aren't studiable (no trusted answer yet) — skip them.
  // buildReviewQueue then drops anything that isn't self-contained, so a card
  // whose vignette went missing can never be asked as if it were answerable.
  const queue = buildReviewQueue(
    meta
      .filter((m) => m.status === "auto")
      .map((m) => ({
        id: m.id,
        topic: m.topic,
        dueAt: m.dueAt,
        question: m.question,
        context: m.context,
        groupId: m.groupId,
        qnum: m.qnum,
      })),
  );

  if (queue.length === 0) {
    return Response.json({ card: null, remaining: 0 });
  }

  const card = await store.getCard(queue[0].id);
  if (!card) {
    return new Response("The queued card disappeared — try again.", { status: 500 });
  }

  return Response.json({
    card: {
      id: card.id,
      documentId: card.documentId,
      topic: card.topic,
      // The vignette ships WITH the question, never behind the reveal — it is
      // the question's other half, not part of the answer.
      context: card.context,
      groupId: card.groupId,
      question: card.question,
      options: card.options,
      qnum: card.qnum,
      sourcePages: card.sourcePages,
    },
    // Cards left in today's queue after this one.
    remaining: queue.length - 1,
  });
}
