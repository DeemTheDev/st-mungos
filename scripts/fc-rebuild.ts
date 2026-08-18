// pnpm fc:rebuild --doc <id> | --all   [--dry-run | --apply] [--store file|supabase] [--force]
//
// Re-extract a document WITHOUT re-uploading it. The raw file is already in
// storage (the private "flashcards" bucket, or .flashcards/raw/), so a rebuild
// only has to clear what the old pipeline produced and rewind the job:
//
//   delete cards (reviews cascade) → delete sections → clear checkpoint →
//   status back to "uploaded", document row and blob KEPT
//
// The normal poll loop then re-runs survey → extraction → reconciliation with
// the current prompt. This script does NOT call the model itself and costs
// nothing; it just puts the document back on the runway.
//
// --dry-run is the DEFAULT. Rebuilding is destructive: any FSRS scheduling on
// this document's cards is gone, so with studied cards present the script
// refuses without --force.

import { FileFcStore, getFcStore, type FcStore } from "../lib/flashcards/store";
import type { FcDocument } from "../lib/flashcards/types";

/** Same --dir escape hatch as fc:repair, for the fc:test store directory. */
function resolveStore(argv: string[]): FcStore {
  const dirArg = argv.indexOf("--dir");
  const dir = dirArg >= 0 ? argv[dirArg + 1] : undefined;
  if (!dir) return getFcStore();
  if ((process.env.STORE ?? "file").toLowerCase() === "supabase") {
    throw new Error("--dir only applies to the file store; drop --store supabase or drop --dir");
  }
  return new FileFcStore(dir);
}

interface Target {
  doc: FcDocument;
  cardCount: number;
  reviewCount: number;
  hasRawFile: boolean;
}

async function inspect(store: FcStore, doc: FcDocument): Promise<Target> {
  return {
    doc,
    cardCount: await store.countCards(doc.id),
    reviewCount: await store.countReviewsForDocument(doc.id),
    hasRawFile: (await store.loadRawFile(doc.id)) !== null,
  };
}

function usage(): never {
  console.error(
    "usage: pnpm fc:rebuild (--doc <id> | --all) [--apply] [--force] [--store file|supabase]\n" +
      "       --dry-run is the default; --apply commits; --force is required when studied cards would lose scheduling.",
  );
  process.exit(1);
}

/** Scripts run outside Next, so .env.local is not loaded for us. */
function loadLocalEnv(): void {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Absent is fine for STORE=file; the store constructor reports what it needs.
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const force = argv.includes("--force");
  const all = argv.includes("--all");
  const docArg = argv.indexOf("--doc");
  const documentId = docArg >= 0 ? argv[docArg + 1] : undefined;
  const storeArg = argv.indexOf("--store");
  if (storeArg >= 0 && argv[storeArg + 1]) process.env.STORE = argv[storeArg + 1];
  if (!all && !documentId) usage();

  const store = resolveStore(argv);
  const docs = all
    ? await store.listDocuments()
    : [(await store.getDocument(documentId!)) ?? null].filter((d): d is FcDocument => d !== null);
  if (docs.length === 0) {
    console.error(documentId ? `No document ${documentId}.` : "No documents in this store.");
    process.exit(1);
  }

  const targets: Target[] = [];
  for (const doc of docs) targets.push(await inspect(store, doc));

  console.log("=".repeat(74));
  console.log(`fc:rebuild — ${apply ? "APPLY" : "DRY RUN (default; pass --apply to commit)"}`);
  console.log(`store: ${(process.env.STORE ?? "file").toLowerCase()}`);
  console.log("=".repeat(74));

  for (const t of targets) {
    console.log(`\n  ${t.doc.filename}`);
    console.log(`    id:            ${t.doc.id}`);
    console.log(`    status:        ${t.doc.status}`);
    console.log(`    cards:         ${t.cardCount}  (all deleted and re-extracted)`);
    console.log(
      `    studied cards: ${t.reviewCount}` +
        (t.reviewCount > 0 ? "  ← their review scheduling is DESTROYED (needs --force)" : "  (nothing to lose)"),
    );
    console.log(`    stored file:   ${t.hasRawFile ? "present — no re-upload needed" : "MISSING — cannot rebuild"}`);
  }

  const unrunnable = targets.filter((t) => !t.hasRawFile);
  const risky = targets.filter((t) => t.reviewCount > 0);

  if (!apply) {
    console.log(`\nNothing was written. Re-run with --apply to commit.`);
    if (risky.length > 0) console.log(`(and --force: ${risky.length} document(s) have studied cards)`);
    return;
  }

  if (unrunnable.length > 0) {
    console.error(
      `\nRefusing: the raw file is missing for ${unrunnable.map((t) => t.doc.filename).join(", ")}. ` +
        `Rebuilding would delete the cards and leave a document that can never finish. Re-upload instead.`,
    );
    process.exit(1);
  }
  if (risky.length > 0 && !force) {
    const total = risky.reduce((n, t) => n + t.reviewCount, 0);
    console.error(
      `\nRefusing: ${total} studied card(s) would lose their FSRS scheduling and start again as new. ` +
        `Re-run with --force if that is genuinely what you want.`,
    );
    process.exit(1);
  }

  for (const t of targets) {
    const { cardsDeleted, reviewsDeleted } = await store.resetDocumentForRebuild(t.doc.id);
    console.log(
      `\n  ${t.doc.filename}: ${cardsDeleted} cards and ${reviewsDeleted} review rows deleted; ` +
        `status reset to "uploaded" (file kept).`,
    );
  }
  console.log(
    `\nDone. Open /flashcards and the document will process itself, or drive it headlessly with ` +
      `POST /api/flashcards/job/<id>/step until status is "ready".`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
