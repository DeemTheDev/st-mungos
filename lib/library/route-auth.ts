// Shared plumbing for the /api/grounding, /api/kb and /api/cases routes: the
// admin gate (the same httpOnly cookie as /admin/review and /api/session —
// lib/admin-auth), the error → status mapping, and the review gate itself, so
// the HTML-form endpoint and the JSON endpoint can never disagree about what
// approving a case means.
//
// Kept separate from the job modules so the CLIs never import next/headers.
import { cookies } from "next/headers";

import { ADMIN_COOKIE, isAdminToken } from "../admin-auth";
import { OsceCaseSchema } from "../case-schema";
import { LibraryUserError } from "./budget";
import { BudgetExceededError, type CaseStatus, type Library } from "./types";

/** Null when authorised; a 401 Response otherwise. */
export async function requireLibraryAdmin(): Promise<Response | null> {
  const store = await cookies();
  if (isAdminToken(store.get(ADMIN_COOKIE)?.value)) return null;
  return new Response("Unauthorised — log in first.", { status: 401 });
}

/**
 * The only error path these routes have. Anything we wrote ourselves is safe to
 * show; anything from Anthropic or Supabase is logged server-side and reported
 * as a bare status code, so no vendor payload (and nothing derived from a key)
 * can reach the browser (CLAUDE.md §2.4).
 */
export function errorResponse(err: unknown, context: string): Response {
  if (err instanceof BudgetExceededError) {
    return new Response(err.message, { status: 402 });
  }
  if (err instanceof LibraryUserError) {
    return new Response(err.message, { status: err.status });
  }
  console.error(`[library] ${context}:`, err);
  return new Response("Something went wrong on the server (500). It is safe to try again.", { status: 500 });
}

// ---------------------------------------------------------------------------
// the review gate

export interface ReviewOutcome {
  status: number;
  message: string;
  caseStatus: CaseStatus | null;
}

/**
 * Approve or reject one draft. Approval RE-VALIDATES against OsceCaseSchema:
 * a case can be hand-edited between generation and approval, and nothing
 * unvalidated may ever become playable (CLAUDE.md §2.3).
 */
export async function applyReview(
  library: Library,
  id: string,
  action: "approve" | "reject",
  note: string | null,
): Promise<ReviewOutcome> {
  const record = await library.cases.get(id);
  if (!record) return { status: 404, message: `There is no case called ${id}.`, caseStatus: null };

  if (action === "reject") {
    if (record.status === "rejected") {
      return { status: 200, message: "Already rejected.", caseStatus: "rejected" };
    }
    await library.cases.setStatus(id, "rejected", note);
    return { status: 200, message: "Rejected — kept out of the bank.", caseStatus: "rejected" };
  }

  if (record.status === "bank") {
    return { status: 200, message: "Already approved and in the bank.", caseStatus: "bank" };
  }
  const parsed = OsceCaseSchema.safeParse(record.data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return {
      status: 422,
      message: `This case no longer matches the schema, so it cannot go to the bank — ${issues}`,
      caseStatus: record.status,
    };
  }
  await library.cases.setStatus(id, "bank", note);
  return { status: 200, message: "Approved into the bank.", caseStatus: "bank" };
}
