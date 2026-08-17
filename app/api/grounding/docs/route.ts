// GET /api/grounding/docs — every uploaded guide with its job status and
// progress, newest first. Drives the upload/progress list (CLAUDE.md §5d).
// The checkpoint (which holds the extracted text) is deliberately NOT returned.
import { getLibrary } from "@/lib/library";
import { errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";

export const runtime = "nodejs";

export async function GET() {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  try {
    const docs = await getLibrary().docs.list();
    const sorted = [...docs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Response.json({
      docs: sorted.map((d) => ({
        id: d.id,
        filename: d.filename,
        mime: d.mime,
        sizeBytes: d.sizeBytes,
        status: d.status,
        progress: d.progress,
        error: d.error,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
    });
  } catch (err) {
    return errorResponse(err, "grounding docs");
  }
}
