// /admin/review — kept as a permanent redirect to /review, not deleted.
//
// The review gate moved (and got rebuilt for her rather than for an admin): it
// used to read draft JSON off the developer's disk and post to
// /api/admin/review, which only ever worked on Nadeem's laptop. Drafts now live
// in the case library, so the queue works in production from her phone.
//
// The redirect stays because this path is linked from DECISIONS.md, docs/,
// README and — more to the point — from whatever she has bookmarked. A 404 on a
// bookmark is a worse outcome than one extra hop.
import { redirect } from "next/navigation";

export default function LegacyAdminReviewPage() {
  redirect("/review");
}
