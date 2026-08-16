// POST /api/speech/token — exchanges the server-side Azure Speech key for a
// short-lived authorization token (CLAUDE.md §2.4). Gated by the same admin
// cookie as every other route; the browser never sees AZURE_SPEECH_KEY.
import { cookies } from "next/headers";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";
import { issueSpeechToken } from "@/lib/speech/token-server";

export const runtime = "nodejs";

export async function POST() {
  const store = await cookies();
  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return new Response("Unauthorised — log in first.", { status: 401 });
  }

  const result = await issueSpeechToken();
  if (!result.ok) return new Response(result.message, { status: result.status });
  // `voices` is server-owned config — the pins (VOICE_PATIENT_F /
  // VOICE_PATIENT_M / VOICE_EXAMINER) plus the selectable pools
  // (VOICE_PATIENT_POOL_F / VOICE_PATIENT_POOL_M) that fill the station's
  // patient-voice dropdown. The client never hardcodes voice names; it ships
  // the same defaults only so the picker works before a token exists.
  return Response.json({
    token: result.token,
    region: result.region,
    expiresInSec: result.expiresInSec,
    voices: result.voices,
  });
}
