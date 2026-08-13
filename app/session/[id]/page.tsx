// /session/[id] — the text-mode station (Phase 2 deliverable, CLAUDE.md §8).
// Server shell handles the cookie gate; the station itself is a client
// component (timer, transcript, input, report).
import { cookies } from "next/headers";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";
import { StationClient } from "./station-client";

export const metadata = { title: "St Mungo's — Station" };

export default async function StationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await cookies();

  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-neutral-200">
        <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <h1 className="text-lg font-semibold text-neutral-100">St Mungo&apos;s</h1>
          <p className="mt-1 text-sm text-neutral-400">Enter the access password to open this station.</p>
          <form action="/api/admin/login" method="post" className="mt-4 flex gap-2">
            <input type="hidden" name="next" value={`/session/${id}`} />
            <input
              type="password"
              name="password"
              required
              autoFocus
              placeholder="Password"
              className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
            >
              Enter
            </button>
          </form>
        </div>
      </main>
    );
  }

  return <StationClient sessionId={id} />;
}
