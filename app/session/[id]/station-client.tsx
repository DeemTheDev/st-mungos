"use client";

// The station client (CLAUDE.md §8): dark, minimal, purposeful.
// Text mode is the permanent default: timer + phase chip HUD, transcript pane
// (student right, patient left, examiner amber caption-style), Enter-to-send
// input, quit menu, and the full MarkingReport with a print stylesheet.
// Phase 3 layers voice ON TOP, strictly opt-in ("🎙 Enable voice"): push-to-talk
// (hold SPACE or the on-screen button) streams Azure STT with live captions and
// submits the final transcript through the SAME turn flow; replies are spoken
// sequentially in per-speaker voices. Every voice failure degrades to a notice
// chip — the text station is never blocked by voice.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MarkingReport } from "@/lib/marking-schema";
import type { SessionView, Speaker, TranscriptEntry, VoiceRole } from "@/lib/ports";
import type { VoiceSession } from "@/lib/speech";

interface TurnResponse {
  replies: Array<{ speaker: Speaker; text: string }>;
  phase: string;
  status: SessionView["status"];
  elapsedSec: number;
  timeLimitSec: number;
  timeUp: boolean;
}

function formatClock(totalSec: number): string {
  const clamped = Math.max(0, Math.round(totalSec));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Human message for a failed "Enable voice" — always ends in text mode working. */
function voiceEnableError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Mic permission denied — staying in text mode. Allow the microphone and try again.";
  }
  if (name === "NotFoundError") return "No microphone found — staying in text mode.";
  const message = err instanceof Error ? err.message.trim() : "";
  return message ? `Voice unavailable — ${message} (text mode still works).` : "Voice unavailable — text mode still works.";
}

/** True when the key event landed in a typing control (spacebar must type there, not talk). */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable));
}

const PRINT_CSS = `
@media print {
  body { background: #fff !important; }
  .no-print { display: none !important; }
  .print-report { color: #111 !important; background: #fff !important; border: none !important; }
  .print-report * { color: #111 !important; background: transparent !important; border-color: #ccc !important; }
}
`;

// ---------------------------------------------------------------------------
// transcript bubbles

function Bubble({ entry }: { entry: TranscriptEntry }) {
  if (entry.speaker === "student") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-br-none bg-sky-900/60 px-3 py-2 text-sm text-sky-50">
          {entry.text}
        </div>
      </div>
    );
  }
  if (entry.speaker === "patient") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-lg rounded-bl-none bg-neutral-800 px-3 py-2 text-sm text-neutral-100">
          {entry.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] border-l-2 border-amber-500 py-1 pl-3 text-sm italic text-amber-300 whitespace-pre-line">
        <span className="mr-2 text-[10px] font-semibold uppercase tracking-widest text-amber-500 not-italic">
          Examiner
        </span>
        {entry.text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// marking report

function statusColor(status: string): string {
  if (status === "done") return "bg-emerald-950 text-emerald-300";
  if (status === "partial") return "bg-amber-950 text-amber-300";
  return "bg-red-950 text-red-300";
}

function DomainBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-neutral-400">
        <span>{label}</span>
        <span>{Math.round(value)}</span>
      </div>
      <div className="mt-1 h-2 rounded bg-neutral-800">
        <div className="h-2 rounded bg-sky-600" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function ReportView({ report }: { report: MarkingReport }) {
  return (
    <div className="print-report rounded-lg border border-neutral-800 bg-neutral-900 p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-neutral-100">Marking report</h2>
        <p className="text-2xl font-semibold text-neutral-100">
          {Math.round(report.globalScore)}/100{" "}
          <span
            className={`ml-1 rounded px-2 py-0.5 align-middle text-sm ${
              report.band === "distinction" || report.band === "pass"
                ? "bg-emerald-950 text-emerald-300"
                : report.band === "borderline"
                  ? "bg-amber-950 text-amber-300"
                  : "bg-red-950 text-red-300"
            }`}
          >
            {report.band}
          </span>
        </p>
      </header>

      {report.criticalFlags.length > 0 && (
        <section className="mt-4 rounded border border-red-900 bg-red-950/40 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-red-300">Critical flags</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-200">
            {report.criticalFlags.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-5">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Checklist coverage</h3>
        <table className="mt-2 w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-neutral-800 text-xs uppercase tracking-wider text-neutral-500">
              <th className="py-1.5 pr-3">Item</th>
              <th className="py-1.5 pr-3">Status</th>
              <th className="py-1.5">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {report.checklist.map((c) => (
              <tr key={c.id} className="border-b border-neutral-900 align-top">
                <td className="py-2 pr-3 text-neutral-200">
                  {c.item}
                  {c.critical && (
                    <span className="ml-2 rounded bg-red-950 px-1.5 py-0.5 text-xs font-semibold text-red-300">
                      critical
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${statusColor(c.status)}`}>{c.status}</span>
                </td>
                <td className="py-2 text-neutral-400">{c.evidence ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {report.findings && report.findings.length > 0 && (
        <section className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Findings key</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {report.findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs ${f.identified ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"}`}>
                  {f.identified ? "identified" : "missed"}
                </span>
                <span className="text-neutral-300">
                  {f.finding}
                  {f.critical && <span className="ml-1 text-red-400">(critical)</span>}
                </span>
              </li>
            ))}
          </ul>
          {report.diagnosisCorrect != null && (
            <p className="mt-2 text-sm text-neutral-300">
              Final diagnosis: {report.diagnosisCorrect ? "reached" : "not reached"}.
            </p>
          )}
        </section>
      )}

      {report.viva.length > 0 && (
        <section className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Viva questions</h3>
          <div className="mt-2 space-y-2">
            {report.viva.map((v) => (
              <div key={v.questionId} className="rounded border border-neutral-800 p-3 text-sm">
                <p className="text-neutral-200">“{v.question}”</p>
                <p className="mt-1 text-neutral-400">
                  <span className="mr-2 rounded bg-neutral-800 px-1.5 py-0.5 text-xs">{v.grade}/2</span>
                  {v.comment}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {report.domainScores && (
        <section className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Domain scores</h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <DomainBar label="Communication" value={report.domainScores.communication} />
            <DomainBar label="History taking" value={report.domainScores.historyTaking} />
            <DomainBar label="Examination" value={report.domainScores.examination} />
            <DomainBar label="Clinical reasoning" value={report.domainScores.clinicalReasoning} />
            <DomainBar label="Investigations" value={report.domainScores.investigations} />
            <DomainBar label="Management" value={report.domainScores.management} />
          </div>
        </section>
      )}

      <section className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-emerald-500">Strengths</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-300">
            {report.narrative.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-amber-500">Priority improvements</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-300">
            {report.narrative.improvements.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mt-5">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
          What the complete station looked like
        </h3>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 p-3 text-xs leading-relaxed text-neutral-300">
          {report.narrative.modelStation}
        </pre>
      </section>

      <div className="no-print mt-5 flex gap-2">
        <button
          onClick={() => window.print()}
          className="rounded bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
        >
          Print / save as PDF
        </button>
        <Link
          href="/session"
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm font-medium text-neutral-200 hover:bg-neutral-700"
        >
          New station
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the station

export function StationClient({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [quitOpen, setQuitOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Voice layer (Phase 3) — all client-side, starts OFF, text mode untouched.
  const [voiceState, setVoiceState] = useState<"off" | "enabling" | "on">("off");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [holding, setHolding] = useState(false);
  const [partial, setPartial] = useState("");
  const [speaking, setSpeaking] = useState<{ role: VoiceRole; text: string } | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  const holdingRef = useRef(false);
  const busyRef = useRef(false);
  const ttsFailuresRef = useRef(0);

  function setBusyBoth(value: boolean): void {
    busyRef.current = value;
    setBusy(value);
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/session/${sessionId}`, { cache: "no-store" }).then(async (res) => {
      if (cancelled) return;
      if (!res.ok) {
        setError(await res.text());
        return;
      }
      const data = (await res.json()) as SessionView;
      if (cancelled) return;
      setView(data);
      setElapsed(data.elapsedSec);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const active = view?.status === "active";

  // 1s local countdown while active — re-synced to the server clock on every
  // turn/end response, so drift never accumulates.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [view?.transcript.length]);

  const remaining = view ? view.timeLimitSec - elapsed : 0;

  /** Speak replies in the correct voice, strictly in order (voice mode only). */
  function speakReplies(replies: Array<{ speaker: Speaker; text: string }>): void {
    const voice = voiceRef.current;
    if (!voice) return;
    for (const reply of replies) {
      if (reply.speaker === "student") continue;
      voice.tts.speak(reply.text, reply.speaker).then(
        () => {
          ttsFailuresRef.current = 0;
        },
        (err) => {
          console.warn("[voice] TTS failed", err);
          ttsFailuresRef.current += 1;
          if (ttsFailuresRef.current >= 2) {
            disableVoice("Voice playback keeps failing — switched back to text (replies are still shown).");
          } else {
            setVoiceNotice("Playback failed — the reply is shown as text.");
          }
        },
      );
    }
  }

  // One submission path for BOTH typed and spoken utterances — voice rides the
  // existing turn flow (same POST, same rendering).
  async function submitUtterance(utterance: string) {
    if (!view || !utterance.trim() || busyRef.current) return;
    setBusyBoth(true);
    try {
      const res = await fetch(`/api/session/${sessionId}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ utterance }),
      });
      if (!res.ok) {
        setError(await res.text());
        return;
      }
      const data = (await res.json()) as TurnResponse;
      const now = new Date().toISOString();
      setView((prev) =>
        prev
          ? {
              ...prev,
              phase: data.phase as SessionView["phase"],
              status: data.status,
              transcript: [
                ...prev.transcript,
                { speaker: "student" as const, text: utterance, ts: now, phase: data.phase as SessionView["phase"] },
                ...data.replies.map((r) => ({ ...r, ts: now, phase: data.phase as SessionView["phase"] })),
              ],
            }
          : prev,
      );
      setElapsed(data.elapsedSec);
      setError(null);
      speakReplies(data.replies);
    } finally {
      setBusyBoth(false);
    }
  }

  function sendTyped(): void {
    const utterance = input.trim();
    if (!utterance || busy) return;
    setInput("");
    void submitUtterance(utterance);
  }

  async function endSession(mode: "mark" | "abandon") {
    setBusyBoth(true);
    try {
      const res = await fetch(`/api/session/${sessionId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        setError(await res.text());
        return;
      }
      const data = (await res.json()) as SessionView;
      setView(data);
      setElapsed(data.elapsedSec);
      setQuitOpen(false);
      setError(null);
    } finally {
      setBusyBoth(false);
    }
  }

  // -------------------------------------------------------------------------
  // voice plumbing

  async function enableVoice() {
    if (voiceState !== "off" || !view) return;
    setVoiceState("enabling");
    setVoiceNotice(null);
    try {
      // Dynamic import: the Azure SDK + voice code never load in text mode.
      const { createVoiceSession } = await import("@/lib/speech");
      const session = await createVoiceSession({
        patientSex: view.patient?.sex ?? null,
        onSpeaking: (ev) => setSpeaking(ev.state === "started" ? { role: ev.role, text: ev.text } : null),
        onError: (message) => {
          console.warn("[voice]", message);
          setVoiceNotice(message);
        },
      });
      voiceRef.current = session;
      setVoiceState("on");
      // Free the spacebar for push-to-talk (the input grabs focus on mount).
      (document.activeElement as HTMLElement | null)?.blur?.();
    } catch (err) {
      console.warn("[voice] enable failed", err);
      setVoiceState("off");
      setVoiceNotice(voiceEnableError(err));
    }
  }

  function disableVoice(notice?: string): void {
    voiceRef.current?.dispose();
    voiceRef.current = null;
    holdingRef.current = false;
    ttsFailuresRef.current = 0;
    setHolding(false);
    setPartial("");
    setSpeaking(null);
    setMuted(false);
    setVoiceState("off");
    if (notice) setVoiceNotice(notice);
  }

  function toggleMute(): void {
    const next = !muted;
    voiceRef.current?.tts.setMuted(next);
    setMuted(next);
  }

  function repeatLast(): void {
    voiceRef.current?.tts.repeatLast().catch((err) => console.warn("[voice] repeat failed", err));
  }

  function startHold(): void {
    const voice = voiceRef.current;
    if (!voice || holdingRef.current || busyRef.current || view?.status !== "active") return;
    holdingRef.current = true;
    setHolding(true);
    setPartial("");
    voice.tts.stop(); // holding to talk barges in — never speak over her
    voice.stt
      .start(
        (text) => setPartial(text),
        (finalText) => {
          setPartial("");
          if (finalText) void submitUtterance(finalText);
        },
      )
      .catch((err) => {
        console.warn("[voice] STT start failed", err);
        holdingRef.current = false;
        setHolding(false);
        setVoiceNotice("Couldn't open the mic — try again, or type instead.");
      });
  }

  function endHold(): void {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    voiceRef.current?.stt.stop().catch((err) => console.warn("[voice] STT stop failed", err));
  }

  // Latest-ref pattern so the window listeners below never see stale closures.
  const startHoldRef = useRef(startHold);
  const endHoldRef = useRef(endHold);
  useEffect(() => {
    startHoldRef.current = startHold;
    endHoldRef.current = endHold;
  });

  // Push-to-talk on SPACE (hold = talk, release = send) — ignored while typing.
  useEffect(() => {
    if (voiceState !== "on") return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      startHoldRef.current();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTypingTarget(e.target)) return;
      e.preventDefault();
      endHoldRef.current();
    };
    const cancel = () => endHoldRef.current();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", cancel);
    };
  }, [voiceState]);

  // Tear the voice session down with the component.
  useEffect(
    () => () => {
      voiceRef.current?.dispose();
      voiceRef.current = null;
    },
    [],
  );

  if (error && !view) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-neutral-200">
        <div className="max-w-md rounded-lg border border-red-950 bg-neutral-900 p-6 text-sm">
          <p className="text-red-300">{error}</p>
          <Link href="/session" className="mt-4 inline-block rounded bg-neutral-800 px-3 py-1.5 text-neutral-200">
            Back to stations
          </Link>
        </div>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-sm text-neutral-500">
        Preparing the station…
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-neutral-950 text-neutral-200">
      <style>{PRINT_CSS}</style>

      {/* HUD */}
      <header className="no-print sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950/95 px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm">
            <span
              className={`font-mono text-lg ${remaining <= 60 && active ? "text-red-400" : "text-neutral-100"}`}
            >
              {formatClock(remaining)}
            </span>
            <span className="rounded bg-sky-950 px-2 py-0.5 text-xs text-sky-300">{view.phase}</span>
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">{view.stationType}</span>
            {view.patient && (
              <span className="hidden text-xs text-neutral-500 sm:inline">
                {view.patient.name}, {view.patient.age}
                {view.patient.sex}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {active && voiceState === "off" && (
              <button
                onClick={() => void enableVoice()}
                className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
              >
                🎙 Enable voice
              </button>
            )}
            {voiceState === "enabling" && <span className="text-xs text-neutral-500">Enabling voice…</span>}
            {voiceState === "on" && (
              <>
                <button
                  onClick={toggleMute}
                  title={muted ? "Unmute replies" : "Mute replies"}
                  className="rounded bg-neutral-800 px-2.5 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
                >
                  {muted ? "🔇" : "🔊"}
                </button>
                <button
                  onClick={repeatLast}
                  title="Repeat last line"
                  className="rounded bg-neutral-800 px-2.5 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
                >
                  ↻
                </button>
                <button
                  onClick={() => disableVoice()}
                  title="Switch back to text only"
                  className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
                >
                  Voice off
                </button>
              </>
            )}
            <div className="relative">
            {active ? (
              <>
                <button
                  onClick={() => setQuitOpen((o) => !o)}
                  className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
                >
                  Quit
                </button>
                {quitOpen && (
                  <div className="absolute right-0 mt-2 w-56 rounded border border-neutral-700 bg-neutral-900 p-2 text-sm shadow-lg">
                    <Link
                      href="/session"
                      className="block rounded px-2 py-1.5 text-neutral-200 hover:bg-neutral-800"
                    >
                      Save &amp; resume later
                    </Link>
                    <button
                      onClick={() => void endSession("mark")}
                      disabled={busy}
                      className="block w-full rounded px-2 py-1.5 text-left text-neutral-200 hover:bg-neutral-800"
                    >
                      End &amp; mark now
                    </button>
                  </div>
                )}
              </>
            ) : (
              <span className="text-xs uppercase tracking-widest text-neutral-500">{view.status}</span>
            )}
            </div>
          </div>
        </div>
        {voiceNotice && (
          <div className="mx-auto mt-2 flex max-w-3xl items-center justify-between gap-2 rounded border border-amber-900 bg-amber-950/50 px-3 py-1.5 text-xs text-amber-300">
            <span>{voiceNotice}</span>
            <button onClick={() => setVoiceNotice(null)} className="text-amber-500 hover:text-amber-300" aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
      </header>

      {/* transcript */}
      <div ref={scrollRef} className="mx-auto w-full max-w-3xl flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {view.transcript.map((entry, i) => (
          <Bubble key={i} entry={entry} />
        ))}
        {error && <p className="rounded bg-red-950 p-2 text-sm text-red-300">{error}</p>}
        {view.report && <ReportView report={view.report} />}
        {!view.report && !active && (
          <div className="no-print rounded border border-neutral-800 p-4 text-sm text-neutral-400">
            Station over.{" "}
            <button onClick={() => void endSession("mark")} className="underline" disabled={busy}>
              Run marking
            </button>
          </div>
        )}
      </div>

      {/* who's speaking (pulsing chip: patient neutral / examiner amber) — kept
          outside the footer so a final line keeps its caption after time-up */}
      {speaking && (
        <div className="no-print flex items-center justify-center gap-2 border-t border-neutral-800 bg-neutral-950 px-4 py-2">
          <span
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
              speaking.role === "examiner" ? "bg-amber-950 text-amber-300" : "bg-neutral-800 text-neutral-200"
            }`}
          >
            <span
              className={`h-2 w-2 animate-pulse rounded-full ${
                speaking.role === "examiner" ? "bg-amber-400" : "bg-neutral-400"
              }`}
            />
            {speaking.role === "examiner" ? "Examiner" : (view.patient?.name ?? "Patient")}
          </span>
          <span className="truncate text-xs text-neutral-400">{speaking.text}</span>
        </div>
      )}

      {/* input — text mode always works; voice adds push-to-talk above it */}
      {active && (
        <footer className="no-print border-t border-neutral-800 px-4 py-3">
          <div className="mx-auto max-w-3xl space-y-2">
            {voiceState === "on" && (
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    startHold();
                  }}
                  onPointerUp={endHold}
                  onPointerCancel={endHold}
                  onContextMenu={(e) => e.preventDefault()}
                  style={{ touchAction: "none" }}
                  className={`w-full max-w-md select-none rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                    holding
                      ? "border-sky-500 bg-sky-950 text-sky-200"
                      : "border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-500"
                  } disabled:opacity-40`}
                >
                  {holding ? "● Listening — release to send" : "🎙 Hold to talk (or hold SPACE)"}
                </button>
                {(holding || partial) && (
                  <p className="min-h-5 text-center text-xs italic text-neutral-400">{partial || "Listening…"}</p>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendTyped();
                }}
                disabled={busy}
                autoFocus={voiceState === "off"}
                placeholder={busy ? "…" : "Speak to the patient or examiner, then press Enter"}
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
              />
              <button
                onClick={sendTyped}
                disabled={busy || !input.trim()}
                className="rounded bg-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </footer>
      )}
    </main>
  );
}
