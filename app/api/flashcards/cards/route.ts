// GET /api/flashcards/cards?query=&topic=&documentId=&status=&page=&pageSize=
// Search + filters, paginated (docs/FLASHCARDS.md §4: Postgres full-text
// search via .textSearch when STORE=supabase, substring match on the file
// store). This is the browse/search surface, so cards include their answers —
// the review player uses /review/next + /review/reveal instead.
import { requireFcAdmin } from "@/lib/flashcards/route-auth";
import { getFcStore } from "@/lib/flashcards/store";

export const runtime = "nodejs";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export async function GET(request: Request) {
  const unauthorised = await requireFcAdmin();
  if (unauthorised) return unauthorised;

  const url = new URL(request.url);
  const query = url.searchParams.get("query")?.trim() || undefined;
  const topic = url.searchParams.get("topic")?.trim() || undefined;
  const documentId = url.searchParams.get("documentId")?.trim() || undefined;
  const statusRaw = url.searchParams.get("status")?.trim() || undefined;
  if (statusRaw && statusRaw !== "auto" && statusRaw !== "needs_review") {
    return new Response('status must be "auto" or "needs_review".', { status: 400 });
  }
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(url.searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
  );

  const { cards, total } = await getFcStore().searchCards({
    query,
    topic,
    documentId,
    status: statusRaw as "auto" | "needs_review" | undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return Response.json({
    cards: cards.map((c) => ({
      id: c.id,
      documentId: c.documentId,
      sectionId: c.sectionId,
      topic: c.topic,
      context: c.context,
      groupId: c.groupId,
      question: c.question,
      options: c.options,
      answer: c.answer,
      qnum: c.qnum,
      sourcePages: c.sourcePages,
      confidence: c.confidence,
      status: c.status,
      createdAt: c.createdAt,
    })),
    total,
    page,
    pageSize,
  });
}
