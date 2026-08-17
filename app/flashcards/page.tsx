// /flashcards — deck home (docs/FLASHCARDS.md §6): due-today hero, topic decks,
// document pipeline status, upload, search. Same admin-cookie gate as /session
// and /notes; the interactive bento lives in components/flashcards/home-client.
import { cookies } from "next/headers";
import { SiteNav } from "@/components/site-nav";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";
import { FlashcardsLoginGate } from "@/components/flashcards/login-gate";
import { HomeClient } from "@/components/flashcards/home-client";

export const metadata = { title: "St Mungo's — Flashcards" };

export default async function FlashcardsPage() {
  const store = await cookies();
  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return (
      <FlashcardsLoginGate
        next="/flashcards"
        blurb="Enter the access password to open your decks."
        passwordConfigured={Boolean(process.env.APP_ACCESS_PASSWORD)}
      />
    );
  }

  return (
    <div className="min-h-dvh bg-neutral-950 text-neutral-200">
      <SiteNav active="flashcards" />
      <main className="px-4 py-8">
        <div className="mx-auto max-w-4xl">
          <header className="mb-6">
            <h1 className="text-xl font-semibold text-neutral-100">Flashcards</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Upload a Q&amp;A document, get cards with page provenance, and drill them on a spaced-repetition
              schedule aimed at the exam.
            </p>
          </header>
          <HomeClient />
        </div>
      </main>
    </div>
  );
}
