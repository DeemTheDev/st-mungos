// GET /api/flashcards/documents — every upload with its job status/progress
// and card count, newest first. Drives the upload/progress tab.
import { requireFcAdmin } from "@/lib/flashcards/route-auth";
import { getFcStore } from "@/lib/flashcards/store";

export const runtime = "nodejs";

export async function GET() {
  const unauthorised = await requireFcAdmin();
  if (unauthorised) return unauthorised;

  const docs = await getFcStore().listDocuments();
  return Response.json({
    documents: docs.map((d) => ({
      id: d.id,
      filename: d.filename,
      status: d.status,
      progress: d.progress,
      cardCount: d.cardCount,
      layout: d.layout,
      pageCount: d.pageCount,
      error: d.error,
      createdAt: d.createdAt,
    })),
  });
}
