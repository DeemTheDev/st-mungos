// POST /api/session/[id]/turn { utterance } — one engine turn (CLAUDE.md §3
// runtime flow): the engine arbitrates the speaker, gates disclosure, narrates
// findings/results, fires examiner triggers and timer events, persists, and
// returns the replies + state deltas.
import { buildEngine, requireAdmin } from "@/lib/session-api";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorised = await requireAdmin();
  if (unauthorised) return unauthorised;

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { utterance?: unknown } | null;
  const utterance = typeof body?.utterance === "string" ? body.utterance.trim() : "";
  if (!utterance) return new Response('Expected { utterance: "..." }.', { status: 400 });

  const engine = buildEngine();
  try {
    const result = await engine.takeTurn(id, utterance);
    return Response.json({
      replies: result.replies,
      phase: result.state.phase,
      status: result.state.status,
      elapsedSec: Math.round(result.state.elapsedActiveSec),
      timeLimitSec: result.state.timeLimitSec,
      timeUp: result.timeUp,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Turn failed.";
    const status = /unknown session/i.test(message) ? 404 : 409;
    return new Response(message, { status });
  }
}
