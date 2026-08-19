// PATCH /api/flashcards/cards/[id] { question?, answer?, context?, options?, status? }
// Manual correction of one card — the human end of the extraction quality loop
// (lib/flashcards/edit.ts). Identity and FSRS history survive; qhash is
// recomputed when the front of the card changes.
import { applyCardEdit, CardEditError, type CardEdit } from "@/lib/flashcards/edit";
import { requireFcAdmin } from "@/lib/flashcards/route-auth";
import { getFcStore } from "@/lib/flashcards/store";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorised = await requireFcAdmin();
  if (unauthorised) return unauthorised;

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as CardEdit | null;
  if (!body || typeof body !== "object") {
    return new Response("Expected a JSON body with the fields to change.", { status: 400 });
  }

  try {
    const result = await applyCardEdit(getFcStore(), id, body);
    return Response.json({
      card: {
        id: result.card.id,
        documentId: result.card.documentId,
        topic: result.card.topic,
        context: result.card.context,
        question: result.card.question,
        options: result.card.options,
        answer: result.card.answer,
        qnum: result.card.qnum,
        sourcePages: result.card.sourcePages,
        status: result.card.status,
      },
      warning: result.selfContainmentWarning,
    });
  } catch (err) {
    if (err instanceof CardEditError) return new Response(err.message, { status: err.status });
    console.error("[flashcards] card edit failed:", err);
    return new Response("Couldn't save the change — try again in a moment.", { status: 500 });
  }
}
