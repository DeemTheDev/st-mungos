// POST /api/grounding/upload — multipart upload of a study guide (CLAUDE.md
// §5d). Stores the raw bytes (private Supabase Storage bucket when
// STORE=supabase, disk otherwise), creates the source-doc row in status
// "uploaded", and returns { docId }. The client then polls
// POST /api/grounding/job/[id]/step to drive extraction + distillation.
//
// Her uploads are private course material: they go to private storage and are
// never written anywhere the repo can pick them up (/grounding is gitignored).
import { randomUUID } from "node:crypto";

import { getLibrary } from "@/lib/library";
import { MAX_UPLOAD_BYTES, uploadKind } from "@/lib/library/distill-job";
import { errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";

export const runtime = "nodejs";

const MIME_BY_KIND = {
  pdf: "application/pdf",
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export async function POST(request: Request) {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return new Response('Expected multipart form data with a "file" field.', { status: 400 });
  }

  const filename = (file.name || "upload").split(/[\\/]/).pop() ?? "upload";
  const kind = uploadKind(filename);
  if (!kind) {
    return new Response("I can only read .pdf, .md and .docx files.", { status: 400 });
  }
  if (file.size === 0) {
    return new Response("That file is empty.", { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return new Response("That file is too big — the limit is 25MB.", { status: 413 });
  }

  try {
    const library = getLibrary();
    const id = `doc_${randomUUID().replace(/-/g, "")}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Blob first: a stored blob with no row is inert, a row with no blob is a
    // job that can only fail.
    const storagePath = await library.docs.putBlob(id, filename, bytes);
    const now = new Date().toISOString();
    await library.docs.put({
      id,
      filename,
      mime: file.type || MIME_BY_KIND[kind],
      sizeBytes: file.size,
      storagePath,
      status: "uploaded",
      progress: { done: 0, total: 0 },
      checkpoint: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    return Response.json({ docId: id }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "grounding upload");
  }
}
