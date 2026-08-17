// GET /api/cases?status=draft — the review queue (and, with other statuses,
// the bank and the rejected audit trail). Summaries only; the full case JSON
// comes from GET /api/cases/[id] when a reviewer opens one.
import { getLibrary } from "@/lib/library";
import { errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";
import type { CaseStatus } from "@/lib/library/types";

export const runtime = "nodejs";

const STATUSES: readonly CaseStatus[] = ["draft", "bank", "rejected"];

export async function GET(request: Request) {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  const raw = new URL(request.url).searchParams.get("status");
  if (raw !== null && !STATUSES.includes(raw as CaseStatus)) {
    return new Response('status must be one of "draft", "bank" or "rejected".', { status: 400 });
  }

  try {
    const cases = await getLibrary().cases.list((raw as CaseStatus | null) ?? undefined);
    return Response.json({
      cases: cases
        .map((c) => ({
          id: c.id,
          status: c.status,
          stationType: c.stationType,
          discipline: c.discipline,
          diagnosis: c.diagnosis,
          commonness: c.commonness,
          difficulty: c.difficulty,
          kbSource: c.kbSource,
          reviewNote: c.reviewNote,
          reviewedAt: c.reviewedAt,
          createdAt: c.createdAt,
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
    });
  } catch (err) {
    return errorResponse(err, "cases list");
  }
}
