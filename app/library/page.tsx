// /library — self-serve grounding (CLAUDE.md §5d): upload a study guide, watch
// it become knowledge-base topics, then turn those topics into draft stations.
// Everything that used to be a CLI script on Nadeem's laptop, in one page she
// can run herself. Same admin-cookie gate as /session, /notes and /flashcards;
// the interactive part lives in components/library/library-client.
import { cookies } from "next/headers";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";
import { LibraryLoginGate } from "@/components/library/login-gate";
import { LibraryClient } from "@/components/library/library-client";

export const metadata = { title: "St Mungo's — Library" };

export default async function LibraryPage() {
  const store = await cookies();
  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return (
      <LibraryLoginGate
        next="/library"
        heading="St Mungo&#39;s — library"
        blurb="Enter the access password to add study guides."
        passwordConfigured={Boolean(process.env.APP_ACCESS_PASSWORD)}
      />
    );
  }

  return (
    <div className="min-h-dvh bg-neutral-950 text-neutral-200">
      <SiteNav active="library" />
      <main className="px-4 py-8">
        <div className="mx-auto max-w-4xl">
          <header className="mb-6">
            <h1 className="text-xl font-semibold text-neutral-100">Library</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Everything the stations know comes from here. Add a study guide, let it distil into topics, then turn
              those topics into cases — which land in{" "}
              <Link href="/review" className="underline underline-offset-4 hover:text-neutral-200">
                your review queue
              </Link>{" "}
              before they are ever playable.
            </p>
          </header>
          <LibraryClient />
        </div>
      </main>
      <footer className="border-t border-neutral-900 px-4 py-4 text-center text-xs text-neutral-600">
        A study tool, not medical advice. Practice here — verify with your guidelines.
      </footer>
    </div>
  );
}
