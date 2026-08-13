// GET /api/session/[id] — the state a client needs to render/resume a station
// (redacted view: the hidden case JSON never ships to the browser). Resuming
// an active session re-anchors the activity clock so away-time never counts.
import { toSessionView } from "@/lib/session-engine";
import { buildEngine, requireAdmin } from "@/lib/session-api";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorised = await requireAdmin();
  if (unauthorised) return unauthorised;

  const { id } = await context.params;
  const engine = buildEngine();
  try {
    const state = await engine.resume(id);
    const osceCase = await engine.getCase(state);
    return Response.json(toSessionView(state, osceCase));
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "Unknown session.", { status: 404 });
  }
}
