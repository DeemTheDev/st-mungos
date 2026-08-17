// POST /api/admin/review — the review gate's two verbs (CLAUDE.md §5):
//   { id, action: "approve" } → re-validate against OsceCaseSchema, then flip
//                               the case's status to "bank"
//   { id, action: "reject" }  → status "rejected" (kept for the audit trail)
// Accepts the review page's plain form posts (redirects back) or JSON.
//
// This used to renameSync(cases/drafts/x.json → cases/bank/x.json), which
// CANNOT work on Vercel: the deployed filesystem is read-only, so review was a
// local-only operation and production could only replay whatever had been
// committed to git. It now goes through CaseLibrary.setStatus, which is an
// UPDATE against whichever store STORE selects — the specific change that makes
// reviewing possible in production (supabase/schema-library.sql §3).
import { revalidatePath } from "next/cache";

import { getLibrary } from "@/lib/library";
import { applyReview, errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";

export const runtime = "nodejs";

// Case ids are generator-assigned kebab-case; anything else is rejected before
// it reaches a store.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface ReviewAction {
  id: string;
  action: "approve" | "reject";
  note: string | null;
  isForm: boolean;
}

async function readAction(request: Request): Promise<ReviewAction | null> {
  const contentType = request.headers.get("content-type") ?? "";
  let id: unknown;
  let action: unknown;
  let note: unknown;
  let isForm = false;
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    id = body?.id;
    action = body?.action;
    note = body?.note;
  } else {
    const form = await request.formData().catch(() => null);
    id = form?.get("id");
    action = form?.get("action");
    note = form?.get("note");
    isForm = true;
  }
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (action !== "approve" && action !== "reject") return null;
  return { id, action, note: typeof note === "string" && note.trim() ? note.trim() : null, isForm };
}

function respond(review: ReviewAction, request: Request, status: number, message: string): Response {
  revalidatePath("/admin/review");
  if (review.isForm) {
    const back = new URL("/admin/review", request.url);
    if (status >= 400) back.searchParams.set("actionError", message);
    return Response.redirect(back, 303);
  }
  return Response.json({ ok: status < 400, id: review.id, action: review.action, message }, { status });
}

export async function POST(request: Request) {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  const review = await readAction(request);
  if (!review) {
    return new Response('Expected { id: "<kebab-case>", action: "approve" | "reject" }.', { status: 400 });
  }

  try {
    const outcome = await applyReview(getLibrary(), review.id, review.action, review.note);
    return respond(review, request, outcome.status, outcome.message);
  } catch (err) {
    return errorResponse(err, `admin review ${review.id}`);
  }
}
