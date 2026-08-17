// Admin-cookie gate for the /api/flashcards/* routes — the same httpOnly
// cookie as /admin/review and /api/session (single user, single password;
// lib/admin-auth). Kept separate from lib/session-api so flashcard routes
// don't drag in the session engine + Brain modules, and separate from the
// rest of lib/flashcards so the CLI test script never imports next/headers.
import { cookies } from "next/headers";

import { ADMIN_COOKIE, isAdminToken } from "../admin-auth";

/** Null when authorised; a 401 Response otherwise. */
export async function requireFcAdmin(): Promise<Response | null> {
  const store = await cookies();
  if (isAdminToken(store.get(ADMIN_COOKIE)?.value)) return null;
  return new Response("Unauthorised — log in first.", { status: 401 });
}
