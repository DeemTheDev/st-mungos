// GET /api/cases/[id] — one case in full, including the case JSON, for the
// review screen. Admin-gated like everything else here; the student-facing
// session engine reads the bank through CaseStore (lib/ports.ts), never this.
import { getLibrary } from "@/lib/library";
import { errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  const { id } = await context.params;
  try {
    const record = await getLibrary().cases.get(id);
    if (!record) return new Response(`There is no case called ${id}.`, { status: 404 });
    return Response.json({ case: record });
  } catch (err) {
    return errorResponse(err, `case ${id}`);
  }
}
