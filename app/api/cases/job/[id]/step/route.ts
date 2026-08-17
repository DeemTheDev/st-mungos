// POST /api/cases/job/[id]/step — generates exactly ONE case per invocation.
// That is the whole reason a 20-case run fits on Vercel: the client polls, and
// each poll is one model call (two if the first attempt fails validation).
//
// Drafts land with status "draft" — nothing reaches the student unreviewed
// (CLAUDE.md §2.3).
import { getLibrary } from "@/lib/library";
import { runGenerateStep } from "@/lib/library/generate-job";
import { errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";

export const runtime = "nodejs";
// One case is ~5k output tokens of Sonnet, plus at most one feedback retry.
export const maxDuration = 120;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  const { id } = await context.params;
  try {
    return Response.json(await runGenerateStep(getLibrary(), id));
  } catch (err) {
    return errorResponse(err, `case job step ${id}`);
  }
}
