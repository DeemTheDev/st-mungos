// POST /api/flashcards/upload — multipart upload of a .pdf/.docx Q&A document
// (docs/FLASHCARDS.md §6). Stores the raw file (Supabase Storage bucket
// "flashcards" when STORE=supabase, .flashcards/raw/ otherwise), creates the
// fc_documents row in status "uploaded", and returns { documentId }. The
// client then polls POST /api/flashcards/job/[id]/step to drive the pipeline.
import { fileKind } from "@/lib/flashcards/extract";
import { requireFcAdmin } from "@/lib/flashcards/route-auth";
import { getFcStore } from "@/lib/flashcards/store";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // 25MB

export async function POST(request: Request) {
  const unauthorised = await requireFcAdmin();
  if (unauthorised) return unauthorised;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return new Response('Expected multipart form data with a "file" field.', { status: 400 });
  }

  const filename = (file.name || "upload").split(/[\\/]/).pop() ?? "upload";
  if (!fileKind(filename)) {
    return new Response("Only .pdf and .docx files are accepted.", { status: 400 });
  }
  if (file.size === 0) {
    return new Response("The file is empty.", { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return new Response("File too large — the limit is 25MB.", { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || (fileKind(filename) === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  const store = getFcStore();
  const doc = await store.createDocument({ filename, mime, sizeBytes: file.size });
  try {
    await store.saveRawFile(doc.id, filename, bytes, mime);
  } catch (err) {
    await store.updateDocument(doc.id, {
      status: "failed",
      error: err instanceof Error ? err.message : "storing the upload failed",
    });
    return new Response(err instanceof Error ? err.message : "Storing the upload failed.", { status: 500 });
  }

  return Response.json({ documentId: doc.id }, { status: 201 });
}
