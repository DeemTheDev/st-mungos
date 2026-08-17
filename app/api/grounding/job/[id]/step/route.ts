// POST /api/grounding/job/[id]/step — ONE unit of work per call: split the
// uploaded guide, or distil exactly one chapter into one KB topic
// (CLAUDE.md §5d). The client polls this and renders the returned progress.
//
// A 500 leaves the checkpoint untouched, so polling again retries the same
// chunk; a 402 means a budget cap stopped the run before spending more.
import { getLibrary } from "@/lib/library";
import { runDistillStep } from "@/lib/library/distill-job";
import { errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";

export const runtime = "nodejs";
// One distil call (≤6k output tokens) fits comfortably; the extraction step is
// pure CPU and much faster.
export const maxDuration = 120;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  const { id } = await context.params;
  try {
    return Response.json(await runDistillStep(getLibrary(), id));
  } catch (err) {
    return errorResponse(err, `grounding job step ${id}`);
  }
}
