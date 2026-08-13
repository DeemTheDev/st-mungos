// POST /api/session/[id]/end { mode: "mark" | "abandon" } — ends the station.
// "mark" runs the single marking pass (§7), persists the validated
// MarkingReport under the session, and returns it; "abandon" just closes.
import { toSessionView } from "@/lib/session-engine";
import { buildEngine, requireAdmin } from "@/lib/session-api";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorised = await requireAdmin();
  if (unauthorised) return unauthorised;

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { mode?: unknown } | null;
  const mode = body?.mode === "abandon" ? "abandon" : body?.mode === "mark" ? "mark" : null;
  if (!mode) return new Response('Expected { mode: "mark" | "abandon" }.', { status: 400 });

  const engine = buildEngine();
  try {
    const state = await engine.endSession(id, mode);
    const osceCase = await engine.getCase(state);
    return Response.json(toSessionView(state, osceCase));
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "Could not end the session.", { status: 404 });
  }
}
