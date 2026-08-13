// Azure Speech SDK adapters behind the SpeechToText / TextToSpeech ports
// (lib/ports.ts, CLAUDE.md §3). Browser-only — constructed via
// createVoiceSession() in ./index.ts, which dynamic-imports the SDK so it
// never rides in the station's initial chunk. Auth is always the short-lived
// token from /api/speech/token (TokenProvider); the key never appears here.
import type { SpeakingEvent, SpeechToText, TextToSpeech, VoiceRole } from "../ports";
import { SerialQueue } from "./serial-queue";
import type { TokenProvider } from "./token-client";
import { buildSsml, voicesForPatientSex } from "./voices";

type Sdk = typeof import("microsoft-cognitiveservices-speech-sdk");

/** Grace period after stop for the service to flush the trailing `recognized`. */
const STT_FLUSH_MS = 350;

// ---------------------------------------------------------------------------
// STT — push-to-talk: a fresh recognizer per hold (each hold re-checks the
// token provider, so refresh is automatic and there is no stale-auth state).

export class AzureSpeechToText implements SpeechToText {
  private recognizer: import("microsoft-cognitiveservices-speech-sdk").SpeechRecognizer | null = null;
  private finals: string[] = [];
  private lastPartial = "";
  private onFinal: ((text: string) => void) | null = null;

  constructor(
    private readonly sdk: Sdk,
    private readonly tokens: TokenProvider,
    private readonly onError: (message: string) => void,
  ) {}

  async start(onPartial: (text: string) => void, onFinal: (text: string) => void): Promise<void> {
    if (this.recognizer) await this.abort();
    const { token, region } = await this.tokens.get();
    const sdk = this.sdk;

    const config = sdk.SpeechConfig.fromAuthorizationToken(token, region);
    config.speechRecognitionLanguage = "en-ZA";
    const recognizer = new sdk.SpeechRecognizer(config, sdk.AudioConfig.fromDefaultMicrophoneInput());

    this.finals = [];
    this.lastPartial = "";
    this.onFinal = onFinal;

    recognizer.recognizing = (_s, e) => {
      this.lastPartial = e.result.text ?? "";
      onPartial([...this.finals, this.lastPartial].join(" ").trim());
    };
    recognizer.recognized = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
        this.finals.push(e.result.text);
        this.lastPartial = "";
        onPartial(this.finals.join(" "));
      }
    };
    recognizer.canceled = (_s, e) => {
      if (e.reason !== sdk.CancellationReason.Error) return;
      if (e.errorCode === sdk.CancellationErrorCode.AuthenticationFailure) {
        // 401-type failure: drop the cached token so the next hold re-fetches.
        this.tokens.invalidate();
        this.onError("Speech authorisation expired — hold to talk again.");
      } else {
        this.onError("Speech recognition dropped — check your connection and try again.");
      }
    };

    await new Promise<void>((resolve, reject) =>
      recognizer.startContinuousRecognitionAsync(resolve, (err) => reject(new Error(String(err)))),
    );
    this.recognizer = recognizer;
  }

  /** Stop the mic; delivers the accumulated transcript to start()'s onFinal. */
  async stop(): Promise<void> {
    const recognizer = this.recognizer;
    if (!recognizer) return;
    this.recognizer = null;

    await new Promise<void>((resolve) => recognizer.stopContinuousRecognitionAsync(resolve, () => resolve()));
    // The tail phrase's `recognized` can land just after stop — give it a beat.
    await new Promise((r) => setTimeout(r, STT_FLUSH_MS));
    try {
      recognizer.close();
    } catch {
      /* already closed */
    }

    // If the service never finalised the tail, fall back to the last partial.
    const text = (this.finals.join(" ").trim() || this.lastPartial.trim()).trim();
    const deliver = this.onFinal;
    this.onFinal = null;
    deliver?.(text);
  }

  /** Tear down without delivering a final (dispose / re-entrant start). */
  async abort(): Promise<void> {
    const recognizer = this.recognizer;
    this.recognizer = null;
    this.onFinal = null;
    if (!recognizer) return;
    await new Promise<void>((resolve) => recognizer.stopContinuousRecognitionAsync(resolve, () => resolve()));
    try {
      recognizer.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// TTS — a SerialQueue of utterances; each one synthesises to a
// SpeakerAudioDestination so "done" means PLAYBACK finished (the SDK's own
// completion fires when audio is delivered, long before the speaker goes
// quiet — sequencing on that would let the examiner talk over the patient).

export class AzureTextToSpeech implements TextToSpeech {
  private readonly queue = new SerialQueue();
  private readonly listeners: Array<(ev: SpeakingEvent) => void> = [];
  private muted = false;
  private last: { text: string; role: VoiceRole } | null = null;
  private currentDest: import("microsoft-cognitiveservices-speech-sdk").SpeakerAudioDestination | null = null;
  private cancelCurrent: (() => void) | null = null;

  constructor(
    private readonly sdk: Sdk,
    private readonly tokens: TokenProvider,
    /** Case patient's sex — the voice PAIR is derived per utterance from the
     *  server-supplied names on the token, so an env-driven voice change lands
     *  on the next token refresh without reloading the station. */
    private readonly patientSex: "M" | "F" | null,
  ) {}

  speak(text: string, role: VoiceRole): Promise<void> {
    const line = text.trim();
    if (!line) return Promise.resolve();
    this.last = { text: line, role };
    return this.queue.enqueue(() => this.speakNow(line, role));
  }

  onSpeaking(cb: (ev: SpeakingEvent) => void): void {
    this.listeners.push(cb);
  }

  stop(): void {
    this.queue.clear();
    this.cancelCurrent?.();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    // Silence/restore the utterance already playing; queued ones check the flag.
    try {
      if (muted) this.currentDest?.mute();
      else this.currentDest?.unmute();
    } catch {
      /* destination already closed */
    }
  }

  async repeatLast(): Promise<void> {
    if (!this.last) return;
    await this.speak(this.last.text, this.last.role);
  }

  private emit(ev: SpeakingEvent): void {
    for (const cb of this.listeners) cb(ev);
  }

  private async speakNow(text: string, role: VoiceRole): Promise<void> {
    if (this.muted) return; // muted lines are skipped, not stockpiled
    const { token, region, voices } = await this.tokens.get();
    const voiceName = voicesForPatientSex(this.patientSex, voices)[role];
    const sdk = this.sdk;

    const config = sdk.SpeechConfig.fromAuthorizationToken(token, region);
    // Mp3 has the widest Media Source Extensions support for browser playback.
    config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
    const dest = new sdk.SpeakerAudioDestination();
    const synthesizer = new sdk.SpeechSynthesizer(config, sdk.AudioConfig.fromSpeakerOutput(dest));

    this.currentDest = dest;
    this.emit({ role, text, state: "started" });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let synthesisOk = false;
        let audioEnded = false;
        // If onAudioEnd never fires (autoplay quirks, muted tab) the queue must
        // not wedge — cap the wait generously relative to the line's length.
        const watchdog = setTimeout(() => settle(), Math.max(15_000, text.length * 150));
        const settle = (err?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          if (err) reject(err);
          else resolve();
        };

        this.cancelCurrent = () => {
          try {
            dest.pause();
          } catch {
            /* already closed */
          }
          settle();
        };
        dest.onAudioEnd = () => {
          audioEnded = true;
          if (synthesisOk) settle();
        };
        synthesizer.speakSsmlAsync(
          buildSsml(text, voiceName, { role }),
          (result) => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
              synthesisOk = true;
              if (audioEnded) settle();
              // else: audio is still coming out of the speaker — wait for onAudioEnd.
            } else {
              const detail = result.errorDetails ?? "";
              if (/40[13]|auth/i.test(detail)) this.tokens.invalidate();
              settle(new Error(detail || "Speech synthesis was cancelled."));
            }
          },
          (err) => settle(new Error(String(err))),
        );
      });
    } finally {
      this.cancelCurrent = null;
      this.currentDest = null;
      this.emit({ role, text, state: "stopped" });
      try {
        synthesizer.close();
      } catch {
        /* already closed */
      }
      try {
        dest.close();
      } catch {
        /* already closed */
      }
    }
  }
}
