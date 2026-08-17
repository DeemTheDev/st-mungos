// /flashcards/browse — full-text search + filters over every extracted card,
// with expandable answers. Printing this page yields a clean Q&A study sheet.
import { cookies } from "next/headers";
import { SiteNav } from "@/components/site-nav";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";
import { BrowseClient } from "@/components/flashcards/browse-client";
import { FlashcardsLoginGate } from "@/components/flashcards/login-gate";

export const metadata = { title: "St Mungo's — Browse cards" };

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ query?: string | string[]; topic?: string | string[] }>;
}) {
  const store = await cookies();
  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return (
      <FlashcardsLoginGate
        next="/flashcards/browse"
        blurb="Enter the access password to browse your cards."
        passwordConfigured={Boolean(process.env.APP_ACCESS_PASSWORD)}
      />
    );
  }

  const sp = await searchParams;

  return (
    <div className="min-h-dvh bg-neutral-950 text-neutral-200">
      <SiteNav active="flashcards" />
      <main className="px-4 py-8">
        <div className="mx-auto max-w-4xl">
          <header className="no-print mb-6">
            <h1 className="text-xl font-semibold text-neutral-100">Browse cards</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Search everything the extractor produced — printing this page makes a study sheet.
            </p>
          </header>
          <BrowseClient initialQuery={first(sp.query)} initialTopic={first(sp.topic)} />
        </div>
      </main>
    </div>
  );
}
