// /review — the human review gate (CLAUDE.md §5 Stage C, §2.3: unreviewed cases
// never reach the student). This replaces /admin/review, which read draft JSON
// off the developer's disk; the queue now lives in the case library, so she can
// clear it from her phone.
//
// Server component + cookie gate, exactly like the other pages; the queue and
// the approve/reject flow are in components/library/review-client.
import { cookies } from "next/headers";
import { SiteNav } from "@/components/site-nav";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";
import { LibraryLoginGate } from "@/components/library/login-gate";
import { ReviewClient } from "@/components/library/review-client";

export const metadata = { title: "St Mungo's — Case review" };

export default async function ReviewPage() {
  const store = await cookies();
  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return (
      <LibraryLoginGate
        next="/review"
        heading="St Mungo&#39;s — case review"
        blurb="Enter the access password to read the cases waiting on you."
        passwordConfigured={Boolean(process.env.APP_ACCESS_PASSWORD)}
      />
    );
  }

  return (
    <div className="min-h-dvh bg-neutral-950 text-neutral-200">
      <SiteNav active="review" />
      <main className="px-4 py-8">
        <div className="mx-auto max-w-5xl">
          <header className="mb-6">
            <h1 className="text-xl font-semibold text-neutral-100">Case review</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Nothing here has been played by anyone. Read each one and ask the only question that matters — does it
              hold up clinically? Approve it and it joins the bank you get examined on; reject it and it quietly
              doesn&apos;t.
            </p>
          </header>
          <ReviewClient />
        </div>
      </main>
      <footer className="border-t border-neutral-900 px-4 py-4 text-center text-xs text-neutral-600">
        A study tool, not medical advice. Practice here — verify with your guidelines.
      </footer>
    </div>
  );
}
