// POST /api/cases/generate — start a generation run (CLAUDE.md §5 Stage C).
// This route spends nothing: it validates the request, reserves the block of
// case ids the run will own, and hands back a job id. Every model call happens
// in POST /api/cases/job/[id]/step, one case at a time.
import { z } from "zod";

import { DisciplineSchema } from "@/lib/case-schema";
import { getLibrary } from "@/lib/library";
import { createGenJob } from "@/lib/library/generate-job";
import { errorResponse, requireLibraryAdmin } from "@/lib/library/route-auth";
import type { GenJob } from "@/lib/library/types";

export const runtime = "nodejs";

const RequestSchema = z.object({
  system: DisciplineSchema,
  // 25 is the CLI's cap too — one poll per case, so a bigger run is just more polls.
  count: z.number().int().min(1).max(25).default(3),
  commonness: z.enum(["common", "uncommon"]).default("common"),
});

export async function POST(request: Request) {
  const unauthorised = await requireLibraryAdmin();
  if (unauthorised) return unauthorised;

  const body = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      `Expected { system: ${DisciplineSchema.options.join(" | ")}, count: 1-25, commonness: "common" | "uncommon" }.`,
      { status: 400 },
    );
  }

  try {
    const spec = await createGenJob(getLibrary(), parsed.data);
    const job: GenJob = {
      id: spec.id,
      system: spec.system,
      count: spec.count,
      commonness: spec.commonness,
      status: "queued",
      progress: { done: 0, total: spec.count },
      producedIds: [],
      error: null,
      createdAt: spec.createdAt,
    };
    return Response.json({ jobId: spec.id, job }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "case generate");
  }
}
