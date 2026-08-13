// Shared plumbing for the /api/session/* routes: the admin-cookie gate (same
// httpOnly cookie as /admin/review — single user, single password) and the
// engine wired to the configured Brain + stores.
import { cookies } from "next/headers";
import { ADMIN_COOKIE, isAdminToken } from "./admin-auth";
import { getBrain } from "./brains";
import { SessionEngine } from "./session-engine";
import { getCaseStore, getSessionStore } from "./stores";

/** Null when authorised; a 401 Response otherwise. */
export async function requireAdmin(): Promise<Response | null> {
  const store = await cookies();
  if (isAdminToken(store.get(ADMIN_COOKIE)?.value)) return null;
  return new Response("Unauthorised — log in first.", { status: 401 });
}

export function buildEngine(): SessionEngine {
  return new SessionEngine({
    caseStore: getCaseStore(),
    sessionStore: getSessionStore(),
    brain: getBrain(),
  });
}
