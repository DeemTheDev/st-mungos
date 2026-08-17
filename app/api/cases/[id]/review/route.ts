// POST /api/cases/[id]/review — the JSON review gate: { action: "approve" |
// "reject", note?: string }. Approval re-validates the case against
// OsceCaseSchema and flips its status to "bank"; rejection keeps the row as
// "rejected" for the audit trail rather than deleting it (schema-library.sql).
//
// The equivalent HTML-form endpoint is POST /api/admin/review; both call
// applyReview(), so they can never disagree.
import { z } from "zod";

import { getLibrary } from "@/lib/library";
import { applyReview, errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";

export const runtime = "nodejs";

const RequestSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(2000).nullish(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  const { id } = await context.params;
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response('Expected { action: "approve" | "reject", note?: string }.', { status: 400 });
  }

  try {
    const outcome = await applyReview(getLibrary(), id, parsed.data.action, parsed.data.note ?? null);
    return Response.json(
      { ok: outcome.status < 400, id, status: outcome.caseStatus, message: outcome.message },
      { status: outcome.status },
    );
  } catch (err) {
    return errorResponse(err, `case review ${id}`);
  }
}
