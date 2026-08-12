// POST /api/admin/login — exchanges APP_ACCESS_PASSWORD for the httpOnly admin
// cookie, then bounces back to /admin/review. Accepts a plain HTML form post
// (the no-JS login form on the review page) or JSON { password }.
import { cookies } from "next/headers";
import { ADMIN_COOKIE, adminToken, passwordMatches } from "@/lib/admin-auth";

export const runtime = "nodejs";

async function readPassword(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
    return typeof body?.password === "string" ? body.password : "";
  }
  const form = await request.formData().catch(() => null);
  const value = form?.get("password");
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const back = new URL("/admin/review", request.url);

  if (!process.env.APP_ACCESS_PASSWORD) {
    return new Response("APP_ACCESS_PASSWORD is not configured on the server.", { status: 500 });
  }

  const password = await readPassword(request);
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
