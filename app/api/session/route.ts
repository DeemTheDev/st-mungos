// POST /api/session — create a station session (CLAUDE.md §3 runtime flow).
// Accepts JSON { caseId } or { random: true, stationType?, discipline? } — or
// the /session picker's plain form posts (same fields), which redirect into
// the station page. Random picks respect the ~80/20 common/uncommon weighting.
import { pickRandomCase, toSessionView } from "@/lib/session-engine";
import { getCaseStore } from "@/lib/stores";
import { buildEngine, requireAdmin } from "@/lib/session-api";

export const runtime = "nodejs";

interface CreateRequest {
  caseId: string | null;
  random: boolean;
  stationType: "clinical" | "interpretation" | undefined;
  discipline: string | undefined;
  isForm: boolean;
}

async function readCreateRequest(request: Request): Promise<CreateRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  let caseId: unknown;
  let random: unknown;
  let stationType: unknown;
  let discipline: unknown;
  let isForm = false;
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    caseId = body?.caseId;
    random = body?.random;
    stationType = body?.stationType;
    discipline = body?.discipline;
  } else {
    const form = await request.formData().catch(() => null);
    caseId = form?.get("caseId");
    random = form?.get("random");
    stationType = form?.get("stationType");
    discipline = form?.get("discipline");
    isForm = true;
  }
  return {
    caseId: typeof caseId === "string" && caseId.length > 0 ? caseId : null,
    random: random === true || random === "1" || random === "true",
    stationType:
      stationType === "clinical" || stationType === "interpretation" ? stationType : undefined,
    discipline: typeof discipline === "string" && discipline.length > 0 ? discipline : undefined,
    isForm: isForm,
  };
}

export async function POST(request: Request) {
  const unauthorised = await requireAdmin();
  if (unauthorised) return unauthorised;

  const req = await readCreateRequest(request);
  let caseId = req.caseId;
  if (!caseId) {
    if (!req.random) {
      return new Response('Expected { caseId } or { random: true, stationType?, discipline? }.', { status: 400 });
    }
    const summaries = await getCaseStore().list();
    const picked = pickRandomCase(summaries, { stationType: req.stationType, discipline: req.discipline });
    if (!picked) {
      return new Response("No bank case matches that filter.", { status: 404 });
    }
    caseId = picked.id;
  }

  const engine = buildEngine();
  let state;
  try {
    state = await engine.createSession(caseId);
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "Could not create the session.", { status: 404 });
  }

  if (req.isForm) {
    return Response.redirect(new URL(`/session/${state.id}`, request.url), 303);
  }
  const osceCase = await engine.getCase(state);
  return Response.json(toSessionView(state, osceCase), { status: 201 });
}
