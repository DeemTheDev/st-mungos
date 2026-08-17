// POST /api/flashcards/review/reveal { cardId } — the answer side of a card,
// only ever requested after she has committed to a recall attempt
// (docs/FLASHCARDS.md §5: the answer is never visible until she commits).
// `source_pages` gives provenance back to the original document; for MCQs the
// answer already embeds the document's explanation, so `explanation` is null
// (a future AI "explain why" button fills it — deferred booster).
import { requireFcAdmin } from "@/lib/flashcards/route-auth";
import { getFcStore } from "@/lib/flashcards/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const unauthorised = await requireFcAdmin();
  if (unauthorised) return unauthorised;

  const body = (await request.json().catch(() => null)) as { cardId?: unknown } | null;
  const cardId = typeof body?.cardId === "string" ? body.cardId : null;
  if (!cardId) return new Response("Expected { cardId }.", { status: 400 });

  const card = await getFcStore().getCard(cardId);
  if (!card) return new Response("Unknown card.", { status: 404 });

  return Response.json({
    answer: card.answer,
    // camelCase to match the typed client (components/flashcards/api.ts); the
    // old snake_case key meant the provenance badge never rendered.
    sourcePages: card.sourcePages,
    explanation: null,
  });
}
