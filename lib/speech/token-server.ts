// SERVER-ONLY: exchanges AZURE_SPEECH_KEY for a short-lived authorization
// token (CLAUDE.md §2.4 — the key never reaches the browser; the client only
// ever sees this token). Shared by the /api/speech/token route and
// scripts/verify-speech-token.ts so the verified code path IS the route's.
// Never import this from client code.

import { voiceConfigFromEnv, type VoiceConfig } from "./voices";

/**
 * Azure STS tokens are valid for 10 minutes; we advertise 540s (9 min) and the
 * client refreshes at ~8 min, so a token is never used near its cliff.
 */
export const SPEECH_TOKEN_TTL_SEC = 540;

export type SpeechTokenResult =
  | { ok: true; token: string; region: string; expiresInSec: number; voices: VoiceConfig }
  | { ok: false; status: 502 | 503; message: string };

/**
 * Voice names ride with the token because they are the one piece of speech
 * config the browser needs and the server owns: changing VOICE_PATIENT_F /
 * VOICE_PATIENT_M / VOICE_EXAMINER in Vercel swaps the voices on the next
 * token fetch (≤8 min), with no code deploy.
 */
export function speechVoices(): VoiceConfig {
  return voiceConfigFromEnv(process.env);
}

export async function issueSpeechToken(): Promise<SpeechTokenResult> {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    return {
      ok: false,
      status: 503,
      message: "Azure Speech is not configured — set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.",
    };
  }

  try {
    const res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Deliberately status-only: Azure error bodies are never forwarded, so no
      // header/key material can leak through this message.
      return { ok: false, status: 502, message: `Azure token service refused the request (HTTP ${res.status}).` };
    }
    const token = (await res.text()).trim();
    if (!token) {
      return { ok: false, status: 502, message: "Azure token service returned an empty token." };
    }
    return { ok: true, token, region, expiresInSec: SPEECH_TOKEN_TTL_SEC, voices: speechVoices() };
  } catch {
    return { ok: false, status: 502, message: "Could not reach the Azure token service." };
  }
}
