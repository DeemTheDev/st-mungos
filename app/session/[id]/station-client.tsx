"use client";

// The text-mode station client (CLAUDE.md §8): dark, minimal, purposeful.
// Timer countdown + phase chip, transcript pane (student right, patient left,
// examiner amber caption-style), Enter-to-send input, quit menu (save & resume
// later / end & mark now), and the full MarkingReport on completion with a
// print stylesheet so browser print = the PDF export for now.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MarkingReport } from "@/lib/marking-schema";
import type { SessionView, Speaker, TranscriptEntry } from "@/lib/ports";

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

  async function sendTurn() {
    if (!view || !input.trim() || busy) return;
    const utterance = input.trim();
    setInput("");
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  }

  async function endSession(mode: "mark" | "abandon") {
    setBusy(true);
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
      setBusy(false);
    }
  }

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

      {/* input */}
      {active && (
        <footer className="no-print border-t border-neutral-800 px-4 py-3">
          <div className="mx-auto flex max-w-3xl gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void sendTurn();
              }}
              disabled={busy}
              autoFocus
              placeholder={busy ? "…" : "Speak to the patient or examiner, then press Enter"}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
            <button
              onClick={() => void sendTurn()}
              disabled={busy || !input.trim()}
              className="rounded bg-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </footer>
      )}
    </main>
  );
}
