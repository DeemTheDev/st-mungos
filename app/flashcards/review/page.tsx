// /flashcards/review — the session player. ?topic= filters the queue (deck
// tiles link here with it); no topic = interleaved across all topics, which is
// the learning-science default (docs/FLASHCARDS.md §5.3).
import { cookies } from "next/headers";
import { SiteNav } from "@/components/site-nav";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";
import { FlashcardsLoginGate } from "@/components/flashcards/login-gate";
import { ReviewClient } from "@/components/flashcards/review-client";

export const metadata = { title: "St Mungo's — Review" };

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string | string[] }>;
}) {
  const store = await cookies();
  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return (
      <FlashcardsLoginGate
        next="/flashcards/review"
        blurb="Enter the access password to start reviewing."
        passwordConfigured={Boolean(process.env.APP_ACCESS_PASSWORD)}
      />
    );
  }

  const sp = await searchParams;
  const topic = typeof sp.topic === "string" && sp.topic.trim() ? sp.topic.trim() : null;

  return (
    <div className="flex min-h-dvh flex-col bg-neutral-950 text-neutral-200">
      <SiteNav active="flashcards" />
      <ReviewClient topic={topic} />
    </div>
  );
}
