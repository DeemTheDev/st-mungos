// Server-only auth for the /admin/review gate (CLAUDE.md §5 Stage C).
// The cookie stores a SHA-256 token derived from APP_ACCESS_PASSWORD — the
// password itself never leaves the login POST, and there is no session store
// to maintain. Rotating the password invalidates every issued cookie.
import { createHash, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "stmungos_admin";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** The cookie value a correctly logged-in browser must hold. */
export function adminToken(): string | null {
  const password = process.env.APP_ACCESS_PASSWORD;
  if (!password) return null;
  return createHash("sha256").update(`st-mungos-admin:${password}`).digest("hex");
}

export function isAdminToken(value: string | undefined): boolean {
  const expected = adminToken();
  return Boolean(expected && value && safeEqual(value, expected));
}

export function passwordMatches(candidate: string): boolean {
  const password = process.env.APP_ACCESS_PASSWORD;
  return Boolean(password && candidate && safeEqual(candidate, password));
}
