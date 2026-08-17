// POST /api/flashcards/review/grade { cardId, grade } — she grades her own
// recall (again | hard | good | easy); FSRS schedules the next review, with
// cram mode capping due_at at EXAM_DATE when set (docs/FLASHCARDS.md §5).
// Returns { nextDueAt }.
import { gradeReview, isFcGrade } from "@/lib/flashcards/fsrs";
import { requireFcAdmin } from "@/lib/flashcards/route-auth";
import { getFcStore } from "@/lib/flashcards/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const unauthorised = await requireFcAdmin();
  if (unauthorised) return unauthorised;

  const body = (await request.json().catch(() => null)) as { cardId?: unknown; grade?: unknown } | null;
  const cardId = typeof body?.cardId === "string" ? body.cardId : null;
  const grade = body?.grade;
  if (!cardId || !isFcGrade(grade)) {
    return new Response('Expected { cardId, grade: "again" | "hard" | "good" | "easy" }.', { status: 400 });
  }

  const store = getFcStore();
  const card = await store.getCard(cardId);
  if (!card) return new Response("Unknown card.", { status: 404 });

  const prev = await store.getReview(cardId);
  const review = gradeReview(cardId, prev, grade);
  await store.upsertReview(review);

  return Response.json({ nextDueAt: review.dueAt });
}
