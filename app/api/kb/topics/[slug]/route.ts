// GET /api/kb/topics/[slug] — one distilled topic, markdown and all, so the
// library UI can show what a station will actually be built from.
import { getLibrary } from "@/lib/library";
import { errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  const { slug } = await context.params;
  try {
    const topic = await getLibrary().kb.get(slug);
    if (!topic) return new Response("There is no knowledge-base topic with that name.", { status: 404 });
    return Response.json({ topic });
  } catch (err) {
    return errorResponse(err, `kb topic ${slug}`);
  }
}
