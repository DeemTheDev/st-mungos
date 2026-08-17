// POST /api/flashcards/documents/[id]/rebuild { apply?: boolean }
//
// Re-extract one document from the file ALREADY in storage — no re-upload. The
// raw blob and the document row survive; the cards, sections, reviews and job
// checkpoint are cleared and status rewinds to "uploaded", so the normal
// one-step-per-poll job runner re-runs survey → extraction → reconciliation
// with the current prompt.
//
// Destructive, so it is two-phase by default: `apply: false` (the default)
// answers "what would this cost me?" — card count and, critically, how many
// cards carry FSRS scheduling that would be thrown away. The UI shows that
// before it will send `apply: true`.
import { requireFcAdmin } from "@/lib/flashcards/route-auth";
import { getFcStore } from "@/lib/flashcards/store";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const unauthorised = await requireFcAdmin();
  if (unauthorised) return unauthorised;

  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { apply?: unknown } | null;
  const apply = body?.apply === true;

  const store = getFcStore();
  const doc = await store.getDocument(id);
  if (!doc) return new Response("Unknown document.", { status: 404 });

  const reviewCount = await store.countReviewsForDocument(id);
  const cardCount = await store.countCards(id);

  if (!apply) {
    return Response.json({ applied: false, filename: doc.filename, cardCount, reviewCount });
  }

  // The blob has to still be there, or the rebuild would wipe her cards and
  // leave a document that can never finish. Check BEFORE deleting anything.
  const raw = await store.loadRawFile(id);
  if (!raw) {
    return new Response(
      "The original file is no longer in storage, so this document can't be rebuilt — re-upload it instead. Nothing was deleted.",
      { status: 409 },
    );
  }

  await store.resetDocumentForRebuild(id);
  return Response.json({ applied: true, filename: doc.filename, cardCount, reviewCount });
}
