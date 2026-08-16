// Public entry to the voice layer (Phase 3). The station UI dynamic-imports
// this module when "Enable voice" is pressed — so the Azure SDK (~1 MB) and
// every voice failure mode stay entirely out of the text-mode path.
//
// createVoiceSession fails fast, in order of most-actionable error first:
//   1. mic permission (NotAllowedError → "stay in text mode" notice),
//   2. token route reachable + Azure configured,
//   3. SDK load.
// Any throw leaves the station untouched in text mode.
import type { SpeakingEvent, SpeechToText, TextToSpeech } from "../ports";
import { AzureSpeechToText, AzureTextToSpeech } from "./azure-speech";
import { TokenProvider } from "./token-client";
import type { VoiceConfig } from "./voices";

export interface VoiceSessionOptions {
  /** Case patient sex — picks which patient-voice pool to draw from
   *  (null = interpretation station, no patient → the female pool). */
  patientSex: "M" | "F" | null;
  /** Seed for "random each station" — stable within a session, different across. */
  sessionId: string;
  /** "random" (default) or a concrete voice name from the pool. */
  patientVoice?: string;
  onSpeaking: (ev: SpeakingEvent) => void;
  /** Async voice failures (auth drop, network) — surface a notice, fall back to text. */
  onError: (message: string) => void;
}

export interface VoiceSession {
  stt: SpeechToText;
  tts: TextToSpeech;
  /** The SERVER's voice config (pins + selectable pools). The station seeds its
   *  picker from the shipped defaults so it works before voice is ever enabled,
   *  then replaces them with these once a token has actually been issued. */
  voices: VoiceConfig;
  dispose(): void;
}

export async function createVoiceSession(opts: VoiceSessionOptions): Promise<VoiceSession> {
  // 1. Mic permission up front (the tracks are released immediately — the SDK
  //    opens its own stream per hold).
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();

  // 2. Prove the token route works before claiming voice is on. The same fetch
  //    warms the cache with the server's voice names and pools.
  const tokens = new TokenProvider();
  const { voices } = await tokens.get();

  // 3. Load the SDK.
  const sdk = await import("microsoft-cognitiveservices-speech-sdk");

  const stt = new AzureSpeechToText(sdk, tokens, opts.onError);
  const tts = new AzureTextToSpeech(sdk, tokens, opts.patientSex, opts.sessionId, opts.patientVoice);
  tts.onSpeaking(opts.onSpeaking);

  return {
    stt,
    tts,
    voices,
    dispose: () => {
      void stt.abort();
      tts.stop();
    },
  };
}
