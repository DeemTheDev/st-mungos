// GET /api/kb/topics — the distilled knowledge base, which is what case
// generation is grounded in (CLAUDE.md §5). Metadata only: the full markdown
// is a separate fetch, so the list stays small on a phone.
import { getLibrary } from "@/lib/library";
import { errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";

export const runtime = "nodejs";

export async function GET() {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  try {
    const topics = await getLibrary().kb.list();
    return Response.json({
      topics: topics
        .map((t) => ({
          slug: t.slug,
          title: t.title,
          system: t.system,
          tokenCount: t.tokenCount,
          sourceRef: t.sourceRef,
          updatedAt: t.updatedAt,
        }))
        .sort((a, b) => a.system.localeCompare(b.system) || a.title.localeCompare(b.title)),
    });
  } catch (err) {
    return errorResponse(err, "kb topics");
  }
}
