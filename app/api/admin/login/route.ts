// POST /api/admin/login — exchanges APP_ACCESS_PASSWORD for the httpOnly admin
// cookie, then bounces back to the page that sent the form (`next`, same-site
// paths only; defaults to /admin/review). Accepts a plain HTML form post
// (the no-JS login forms on the review and session pages) or JSON { password }.
import { cookies } from "next/headers";
import { ADMIN_COOKIE, adminToken, passwordMatches } from "@/lib/admin-auth";

export const runtime = "nodejs";

interface LoginBody {
  password: string;
  next: string | null;
}

async function readBody(request: Request): Promise<LoginBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as { password?: unknown; next?: unknown } | null;
    return {
      password: typeof body?.password === "string" ? body.password : "",
      next: typeof body?.next === "string" ? body.next : null,
    };
  }
  const form = await request.formData().catch(() => null);
  const password = form?.get("password");
  const next = form?.get("next");
  return {
    password: typeof password === "string" ? password : "",
    next: typeof next === "string" ? next : null,
  };
}

/** Same-site relative paths only — never an open redirect. */
function safeNext(next: string | null): string {
  if (next && /^\/[a-zA-Z0-9\-_/]*$/.test(next)) return next;
  return "/admin/review";
}

export async function POST(request: Request) {
  const { password, next } = await readBody(request);
  const back = new URL(safeNext(next), request.url);

  if (!process.env.APP_ACCESS_PASSWORD) {
    return new Response("APP_ACCESS_PASSWORD is not configured on the server.", { status: 500 });
  }

  if (!passwordMatches(password)) {
    back.searchParams.set("error", "1");
    return Response.redirect(back, 303);
  }

  const store = await cookies();
  store.set(ADMIN_COOKIE, adminToken()!, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // a week — plenty for a review session, re-login is one field
  });
  return Response.redirect(back, 303);
}
