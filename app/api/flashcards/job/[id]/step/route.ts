// POST /api/flashcards/job/[id]/step — processes exactly ONE pipeline step per
// call (docs/FLASHCARDS.md §2 job orchestration): survey, one extraction
// window, or reconciliation, depending on fc_documents.status. The PWA polls
// this in a loop and renders the returned progress. A 500 leaves the
// checkpoint untouched — polling again retries the same step.
import { BudgetExceededError } from "@/lib/flashcards/anthropic";
import { runJobStep } from "@/lib/flashcards/job";
import { requireFcAdmin } from "@/lib/flashcards/route-auth";
import { getFcStore } from "@/lib/flashcards/store";

export const runtime = "nodejs";
// Survey + a single 3k-token window comfortably fit a Vercel invocation.
export const maxDuration = 120;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorised = await requireFcAdmin();
  if (unauthorised) return unauthorised;

  const { id } = await context.params;
  const store = getFcStore();
  const doc = await store.getDocument(id);
  if (!doc) return new Response("Unknown flashcard document.", { status: 404 });

  try {
    const result = await runJobStep(store, id);
    return Response.json(result);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return new Response(err.message, { status: 402 });
    }
    return new Response(err instanceof Error ? err.message : "Job step failed.", { status: 500 });
  }
}
