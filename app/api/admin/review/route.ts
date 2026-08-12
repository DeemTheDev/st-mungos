// POST /api/admin/review — the review gate's only two verbs (CLAUDE.md §5):
//   { id, action: "approve" } → re-validate against OsceCaseSchema, then move
//                               cases/drafts/<id>.json → cases/bank/<id>.json
//   { id, action: "reject" }  → delete the draft
// Accepts the review page's plain form posts (redirects back) or JSON.
// Guarded by the same admin cookie as the page.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { OsceCaseSchema } from "@/lib/case-schema";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";

export const runtime = "nodejs";

const DRAFTS_DIR = join(process.cwd(), "cases", "drafts");
const BANK_DIR = join(process.cwd(), "cases", "bank");
// Draft ids are generator-assigned kebab-case; anything else (dots, slashes)
// is rejected so the filename can never traverse out of cases/drafts.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface ReviewAction {
  id: string;
  action: "approve" | "reject";
  isForm: boolean;
}

async function readAction(request: Request): Promise<ReviewAction | null> {
  const contentType = request.headers.get("content-type") ?? "";
  let id: unknown;
  let action: unknown;
  let isForm = false;
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    id = body?.id;
    action = body?.action;
  } else {
    const form = await request.formData().catch(() => null);
    id = form?.get("id");
    action = form?.get("action");
    isForm = true;
  }
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (action !== "approve" && action !== "reject") return null;
  return { id, action, isForm };
}

function respond(review: ReviewAction, request: Request, status: number, message: string): Response {
  revalidatePath("/admin/review");
  if (review.isForm) {
    const back = new URL("/admin/review", request.url);
    if (status >= 400) back.searchParams.set("actionError", message);
    return Response.redirect(back, 303);
  }
  return Response.json(
    { ok: status < 400, id: review.id, action: review.action, message },
    { status },
  );
}

export async function POST(request: Request) {
  const store = await cookies();
  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return new Response("Unauthorised — log in at /admin/review first.", { status: 401 });
  }

  const review = await readAction(request);
  if (!review) {
    return new Response('Expected { id: "<kebab-case>", action: "approve" | "reject" }.', { status: 400 });
  }

  const draftPath = join(DRAFTS_DIR, `${review.id}.json`);
  if (!existsSync(draftPath)) {
    return respond(review, request, 404, `No draft named ${review.id}.json`);
  }

  if (review.action === "reject") {
    unlinkSync(draftPath);
    return respond(review, request, 200, "Draft deleted");
  }

  // approve — nothing reaches the bank without passing the schema, even if the
  // file was hand-edited after generation.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(draftPath, "utf8"));
  } catch {
    return respond(review, request, 400, `${review.id}.json is not valid JSON — fix or reject it`);
  }
  const result = OsceCaseSchema.safeParse(parsedJson);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return respond(review, request, 422, `Schema validation failed — ${issues}`);
  }

  const bankPath = join(BANK_DIR, `${review.id}.json`);
  if (existsSync(bankPath)) {
    return respond(review, request, 409, `cases/bank/${review.id}.json already exists`);
  }
  mkdirSync(BANK_DIR, { recursive: true });
  renameSync(draftPath, bankPath);
  return respond(review, request, 200, "Approved into the bank");
}
