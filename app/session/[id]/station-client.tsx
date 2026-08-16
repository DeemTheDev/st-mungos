"use client";

// The station (CLAUDE.md §8) — a bento grid, not a room with a chat box on it.
//
// WHAT THIS LAYOUT IS. Two columns of tiles that between them own the whole
// viewport, no dead space anywhere:
//
//   ┌──────────── conversation (54%) ────────────┬──────── presence (46%) ─────┐
//   │ phase rail                                 │ exam clock + identity       │
//   │ transcript  (the only scroller)            │ patient portrait  (3D)      │
//   │ composer    (chips · hold-to-talk · type)  │ examiner + live caption     │
//   └────────────────────────────────────────────┴─────────────────────────────┘
//
// The transcript gets the wider column because that is where her eyes live for
// twenty minutes; the patient gets a real half instead of a full-bleed room
// behind everything. The previous version pinned the scene `fixed` behind the
// page, which is how the transcript ended up as a small box floating above
// ~600px of near-black nothing.
//
// Below `lg` the same tiles stack: presence first (clock, patient, examiner),
// then rail + transcript + composer, which take the remaining height. The
// patient tile hides itself on a phone unless she has explicitly turned 3D on —
// a phone's vertical space belongs to the conversation.
//
// WHAT IS LOAD-BEARING. Text mode is the floor: every control here works with
// voice off, 3D off and the model missing. Voice (Phase 3) layers on top,
// strictly opt-in, and every failure degrades to a notice chip. The 3D tile
// (Phase 4) is decoration with an intentional fallback — pull it and the station
// is unchanged. `--station-vh` follows the VISUAL viewport so the mobile
// keyboard can never push the composer off-screen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ExaminerBubble } from "@/components/ward/examiner-bubble";
import { PatientTile } from "@/components/ward/patient-tile";
import { useScenePreference } from "@/components/ward/scene-preference";
import { StimulusViewer } from "@/components/ward/stimulus-viewer";
import type { MarkingReport } from "@/lib/marking-schema";
import type { SessionView, Speaker, TranscriptEntry, VoiceRole } from "@/lib/ports";
import type { VoiceSession } from "@/lib/speech";
import {
  DEFAULT_VOICES,
  RANDOM_PATIENT_VOICE,
  describeVoice,
  patientVoicePool,
  pinnedPatientVoice,
  type VoiceConfig,
} from "@/lib/speech/voices";
import { usePatientVoicePreference } from "./patient-voice-preference";

/** Amber below this many seconds, red below CRITICAL_SEC. */
const WARN_SEC = 120;
const CRITICAL_SEC = 30;

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
  return Boolean(
    el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable),
  );
}

// ---------------------------------------------------------------------------
// design tokens — one radius scale, one border treatment, one surface

const TILE = "rounded-xl border border-neutral-800/60 bg-neutral-900/40";
const CONTROL =
  "rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100 disabled:opacity-40";

const PRINT_CSS = `
@media print {
  body { background: #fff !important; }
  .no-print { display: none !important; }
  /* The station is a fixed-height shell with an inner scroller on screen; for
     print that has to collapse back into normal flow or the report is clipped
     to whatever happened to be visible. */
  .station-shell { height: auto !important; min-height: 0 !important; overflow: visible !important; display: block !important; }
  .station-body { display: block !important; padding: 0 !important; gap: 0 !important; }
  .station-column { max-width: none !important; width: auto !important; margin: 0 !important; background: transparent !important; border: none !important; gap: 0 !important; }
  .station-scroll { overflow: visible !important; flex: none !important; height: auto !important; max-height: none !important; padding: 0 !important; }
  /* The report is the document. The live conversation is working state and
     prints as unreadable light-on-light, so it stays on screen only. */
  .transcript-log { display: none !important; }
  .print-report { color: #111 !important; background: #fff !important; border: none !important; }
  .print-report * { color: #111 !important; background: transparent !important; border-color: #ccc !important; }
}
`;

// ---------------------------------------------------------------------------
// phase rail — "where am I in this station?" without having to think

const CLINICAL_RAIL = [
  { phase: "intro", short: "Intro", full: "Intro" },
  { phase: "history", short: "Hx", full: "History" },
  { phase: "examination", short: "Exam", full: "Examination" },
  { phase: "differentials", short: "DDx", full: "Differentials" },
  { phase: "investigations", short: "Ix", full: "Investigations" },
  { phase: "management", short: "Mx", full: "Management" },
  { phase: "wrap", short: "Wrap", full: "Wrap" },
] as const;

const INTERPRETATION_RAIL = [
  { phase: "present", short: "Stem", full: "Presented" },
  { phase: "interpret", short: "Read", full: "Interpret" },
  { phase: "probe", short: "Viva", full: "Probe" },
  { phase: "wrap", short: "Wrap", full: "Wrap" },
] as const;

function PhaseRail({ phase, stationType }: { phase: string; stationType: SessionView["stationType"] }) {
  const steps = stationType === "interpretation" ? INTERPRETATION_RAIL : CLINICAL_RAIL;
  const current = steps.findIndex((s) => s.phase === phase);

  return (
    <nav aria-label="Station progress" className={`no-print shrink-0 px-3 py-2.5 ${TILE}`}>
      <ol className="flex items-end gap-1.5">
        {steps.map((step, i) => {
          const state = current < 0 ? "ahead" : i < current ? "done" : i === current ? "now" : "ahead";
          return (
            <li key={step.phase} className="min-w-0 flex-1" title={step.full}>
              <span
                aria-current={state === "now" ? "step" : undefined}
                className={`block truncate text-[10px] uppercase tracking-[0.12em] transition-colors ${
                  state === "now" ? "text-emerald-300" : state === "done" ? "text-neutral-500" : "text-neutral-700"
                }`}
              >
                <span className="lg:hidden">{step.short}</span>
                <span className="hidden lg:inline">{step.full}</span>
              </span>
              <span
                className={`mt-1.5 block h-1 rounded-full transition-colors ${
                  state === "now" ? "bg-emerald-400" : state === "done" ? "bg-emerald-900" : "bg-neutral-800"
                }`}
              />
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// exam clock — the tile she glances at without breaking her train of thought

function ClockTile({
  remaining,
  elapsed,
  timeLimitSec,
  active,
  phase,
  stationType,
  patient,
  discipline,
}: {
  remaining: number;
  elapsed: number;
  timeLimitSec: number;
  active: boolean;
  phase: string;
  stationType: SessionView["stationType"];
  patient: SessionView["patient"];
  discipline: string;
}) {
  const critical = active && remaining <= CRITICAL_SEC;
  const warn = active && !critical && remaining <= WARN_SEC;
  const progress = timeLimitSec > 0 ? Math.min(1, Math.max(0, elapsed / timeLimitSec)) : 0;

  return (
    <section aria-label="Exam clock" className={`no-print shrink-0 px-3.5 py-2.5 lg:py-3 ${TILE}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">
            {active ? "Time remaining" : "Station"}
          </p>
          <p
            // aria-live off by design: a countdown that announces every second is
            // unusable with a screen reader. The visual treatment carries it.
            aria-label={`${Math.max(0, Math.floor(remaining / 60))} minutes ${Math.max(0, Math.round(remaining % 60))} seconds remaining`}
            className={`mt-0.5 font-mono text-3xl leading-none tabular-nums tracking-tight transition-colors sm:text-4xl ${
              critical ? "text-red-400" : warn ? "text-amber-300" : "text-neutral-100"
            } ${critical ? "animate-pulse" : ""}`}
          >
            {formatClock(remaining)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="rounded-full border border-emerald-800/50 bg-emerald-950/50 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-emerald-300">
            {phase}
          </span>
          <span className="text-[10px] uppercase tracking-[0.12em] text-neutral-600">{stationType}</span>
        </div>
      </div>

      {/* elapsed rail — the non-alarming half of the time treatment */}
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full transition-all duration-1000 ease-linear ${
            critical ? "bg-red-500" : warn ? "bg-amber-400" : "bg-emerald-500/70"
          }`}
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <p className="mt-2.5 truncate text-[11px] text-neutral-500">
        {patient ? (
          <>
            <span className="text-neutral-300">{patient.name}</span>
            <span className="mx-1.5 text-neutral-700">·</span>
            <span className="tabular-nums">
              {patient.age}
              {patient.sex}
            </span>
          </>
        ) : (
          <span className="text-neutral-300">Interpretation station</span>
        )}
        <span className="mx-1.5 text-neutral-700">·</span>
        {discipline}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// quick actions — typed phrases she would otherwise spell out under the clock.
// They INSERT into the composer (never send), so nothing happens by accident,
// and the wording is chosen to match the engine's own intent detection.

const QUICK_ACTIONS: Record<string, string[]> = {
  intro: ["Can you tell me what brought you in today?", "I'd like to ask about your symptoms."],
  history: [
    "Have you had any weight loss, night sweats or fevers?",
    "I'd like to examine the patient now.",
  ],
  examination: [
    "I'd like to check the vital signs.",
    "I'd like to examine the chest.",
    "My differential is ",
  ],
  differentials: ["My differential is ", "I'd like to order some investigations."],
  investigations: ["I'd like to order some investigations.", "My management plan is "],
  management: ["My management plan is ", "For follow-up I would "],
  wrap: [],
  present: ["Starting with the clinical context, ", "Assessing oxygenation, "],
  interpret: ["In summary, this shows ", "My immediate management would be "],
  probe: ["My reasoning is ", "The mechanism is "],
};

function QuickActions({ phase, onPick }: { phase: string; onPick: (text: string) => void }) {
  const actions = QUICK_ACTIONS[phase] ?? [];
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {actions.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onPick(text)}
          title="Insert into the box — nothing is sent until you press Enter"
          className="max-w-full truncate rounded-full border border-neutral-800 bg-neutral-900/60 px-2.5 py-1 text-[11px] text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
        >
          {text.trim()}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// patient voice picker

function VoicePicker({
  sex,
  config,
  value,
  onChange,
}: {
  sex: "M" | "F" | null;
  config: VoiceConfig;
  value: string;
  onChange: (next: string) => void;
}) {
  const pinned = pinnedPatientVoice(sex, config);
  const pool = patientVoicePool(sex, config);

  if (pinned) {
    return (
      <span
        title={`The server pins the patient voice (VOICE_PATIENT_${sex === "M" ? "M" : "F"}=${pinned}).`}
        className="hidden rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-500 sm:inline"
      >
        Voice: {describeVoice(pinned).name} (pinned)
      </span>
    );
  }

  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">Patient voice</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="Which voice the patient speaks in. Random is stable for the whole station."
        // Narrow on a phone so the whole control row fits one line — every top
        // bar row is height the transcript wants back. The native dropdown
        // still shows the full labels.
        className={`${CONTROL} max-w-[7.5rem] cursor-pointer sm:max-w-[11rem]`}
      >
        <option value={RANDOM_PATIENT_VOICE}>🎲 Random each station</option>
        {pool.map((name) => {
          const v = describeVoice(name);
          return (
            <option key={name} value={name}>
              {v.label}
            </option>
          );
        })}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// transcript bubbles

function Bubble({ entry }: { entry: TranscriptEntry }) {
  if (entry.speaker === "student") {
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-sky-500/25 bg-sky-500/12 px-3.5 py-2.5 text-[13px] leading-relaxed text-sky-50">
          {entry.text}
        </div>
      </li>
    );
  }
  if (entry.speaker === "patient") {
    return (
      <li className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-neutral-700/50 bg-neutral-800/70 px-3.5 py-2.5 text-[13px] leading-relaxed text-neutral-100">
          {entry.text}
        </div>
      </li>
    );
  }
  return (
    <li>
      <div className="rounded-xl rounded-l-sm border border-l-2 border-amber-800/40 border-l-amber-500 bg-amber-950/20 px-3.5 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-500">Examiner</p>
        <p className="mt-1 text-[13px] italic leading-relaxed whitespace-pre-line text-amber-100/90">{entry.text}</p>
      </div>
    </li>
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
        <span className="tabular-nums">{Math.round(value)}</span>
      </div>
      <div className="mt-1 h-2 rounded bg-neutral-800">
        <div className="h-2 rounded bg-sky-600" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function ReportView({ report }: { report: MarkingReport }) {
  return (
    <div className="print-report rounded-xl border border-neutral-800 bg-neutral-900 p-5">
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
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${f.identified ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"}`}
                >
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
          className="rounded-lg bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
        >
          Print / save as PDF
        </button>
        <Link
          href="/session"
          className="rounded-lg bg-neutral-800 px-3 py-1.5 text-sm font-medium text-neutral-200 hover:bg-neutral-700"
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Transcript follow state: stick to the newest line unless she has
  // deliberately scrolled up to re-read something, in which case new replies
  // announce themselves instead of yanking the viewport.
  const [pinnedToLatest, setPinnedToLatest] = useState(true);
  const [unread, setUnread] = useState(0);
  const lastCountRef = useRef(0);
  const pinnedRef = useRef(true);

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
  const mutedRef = useRef(false);

  // Patient voice choice. Seeded from the SHIPPED pools so the picker works
  // before voice is ever enabled; replaced by the server's pools (which may be
  // env-configured) the moment a token is issued.
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>(DEFAULT_VOICES);
  const [patientVoice, setPatientVoice] = usePatientVoicePreference();

  // Patient tile / stimulus (Phase 4) — none of it gates the station.
  const scene = useScenePreference();
  const [stimulusOpen, setStimulusOpen] = useState(false);
  const stimulusAutoOpened = useRef(false);
  // Text-mode stand-in for a SpeakingEvent: a fresh reply "speaks" for a beat
  // so the examiner tile pulses and the patient bobs without any voice layer.
  const [textCue, setTextCue] = useState<{ role: VoiceRole; text: string } | null>(null);
  const cueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** One stream for the UI: real speaking events when voice is audible, cues otherwise. */
  const activeSpeaker = speaking ?? textCue;

  function setBusyBoth(value: boolean): void {
    busyRef.current = value;
    setBusy(value);
  }

  function clearCue(): void {
    if (cueTimerRef.current) clearTimeout(cueTimerRef.current);
    cueTimerRef.current = null;
    setTextCue(null);
  }

  /** Raise a short cue for the line she should be reading right now. */
  function cueReplies(replies: Array<{ speaker: Speaker; text: string }>): void {
    // Audible voice emits the real events — don't double up.
    if (voiceRef.current && !mutedRef.current) return;
    const examiner = replies.find((r) => r.speaker === "examiner");
    const target = examiner ?? [...replies].reverse().find((r) => r.speaker === "patient");
    if (!target) return;
    if (cueTimerRef.current) clearTimeout(cueTimerRef.current);
    setTextCue({ role: target.speaker as VoiceRole, text: target.text });
    cueTimerRef.current = setTimeout(
      () => setTextCue(null),
      Math.min(9000, Math.max(2500, target.text.length * 45)),
    );
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

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    pinnedRef.current = true;
    setPinnedToLatest(true);
    setUnread(0);
  }, []);

  const count = view?.transcript.length ?? 0;
  useEffect(() => {
    const added = count - lastCountRef.current;
    const firstPaint = lastCountRef.current === 0;
    lastCountRef.current = count;
    if (added <= 0) return;
    // Resuming a station must OPEN at the newest line, not animate down to it —
    // smooth scrolling is driven by rAF, so it also silently does nothing while
    // the tab is backgrounded. Only later arrivals get the animation.
    if (pinnedRef.current) scrollToLatest(firstPaint ? "auto" : "smooth");
    else setUnread((n) => n + added);
  }, [count, scrollToLatest]);

  function handleScroll(): void {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 56;
    pinnedRef.current = atBottom;
    setPinnedToLatest(atBottom);
    if (atBottom) setUnread(0);
  }

  // The mobile keyboard shrinks the VISUAL viewport, not the layout viewport, so
  // a 100dvh shell would push the composer under the keyboard. Track the real
  // height and let the shell follow it; desktop just gets the window height.
  useEffect(() => {
    const viewport = window.visualViewport;
    const apply = () => {
      // visualViewport is the one that shrinks under the keyboard, so it wins —
      // but NEVER write a zero. A transient 0-height reading (a backgrounded
      // tab, a pane not yet laid out) would collapse the whole station, and
      // because the variable beats the 100dvh fallback it would STAY collapsed.
      const height = Math.round(viewport?.height ?? 0) || window.innerHeight;
      if (height > 0) document.documentElement.style.setProperty("--station-vh", `${height}px`);
    };
    apply();
    // Two sources because neither is sufficient alone: the keyboard changes the
    // VISUAL viewport without changing the layout viewport (only this event
    // sees it), and a plain window resize does not reliably fire that event at
    // all (only the observer sees it). Together they miss nothing.
    viewport?.addEventListener("resize", apply);
    const observer = new ResizeObserver(apply);
    observer.observe(document.documentElement);
    return () => {
      viewport?.removeEventListener("resize", apply);
      observer.disconnect();
      document.documentElement.style.removeProperty("--station-vh");
    };
  }, []);

  // An interpretation station opens on its stimulus — the values/image ARE the
  // station (§4b). Only ever auto-opened once; after that it's her call.
  useEffect(() => {
    if (view?.stimulus && !stimulusAutoOpened.current) {
      stimulusAutoOpened.current = true;
      setStimulusOpen(true);
    }
  }, [view?.stimulus]);

  useEffect(
    () => () => {
      if (cueTimerRef.current) clearTimeout(cueTimerRef.current);
    },
    [],
  );

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
    // Speaking is an explicit "I'm following the live conversation again": snap
    // back so her own line and the reply are both on screen.
    pinnedRef.current = true;
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
      cueReplies(data.replies);
    } finally {
      setBusyBoth(false);
    }
  }

  function sendTyped(): void {
    const utterance = input.trim();
    if (!utterance || busy) return;
    setInput("");
    // Sending must never cost her the caret — she types the next question while
    // the reply lands.
    inputRef.current?.focus();
    void submitUtterance(utterance);
  }

  /** Quick action: insert (never send), then hand the caret back at the end. */
  function insertIntoComposer(text: string): void {
    setInput((current) => {
      const trimmed = current.trimEnd();
      return trimmed ? `${trimmed} ${text}` : text;
    });
    const node = inputRef.current;
    if (node) {
      node.focus();
      requestAnimationFrame(() => node.setSelectionRange(node.value.length, node.value.length));
    }
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

  /** Applies to the NEXT utterance — no reload, no session restart. */
  function changePatientVoice(next: string): void {
    setPatientVoice(next);
    voiceRef.current?.tts.setPatientVoice(next);
  }

  async function enableVoice() {
    if (voiceState !== "off" || !view) return;
    setVoiceState("enabling");
    setVoiceNotice(null);
    try {
      // Dynamic import: the Azure SDK + voice code never load in text mode.
      const { createVoiceSession } = await import("@/lib/speech");
      const session = await createVoiceSession({
        patientSex: view.patient?.sex ?? null,
        sessionId,
        patientVoice,
        onSpeaking: (ev) => setSpeaking(ev.state === "started" ? { role: ev.role, text: ev.text } : null),
        onError: (message) => {
          console.warn("[voice]", message);
          setVoiceNotice(message);
        },
      });
      voiceRef.current = session;
      setVoiceConfig(session.voices);
      mutedRef.current = false;
      clearCue(); // real speaking events take over from here
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
    mutedRef.current = false;
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
    mutedRef.current = next;
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

  // Escape closes whatever is open, "?" toggles the shortcut sheet. Deliberately
  // the only two global keys besides SPACE — more would be another thing to hold
  // in her head during a timed station.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setQuitOpen(false);
        setShortcutsOpen(false);
        setStimulusOpen(false);
        return;
      }
      if (e.key === "?" && !isTypingTarget(e.target)) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tear the voice session down with the component.
  useEffect(
    () => () => {
      voiceRef.current?.dispose();
      voiceRef.current = null;
    },
    [],
  );

  /** The newest thing said TO her — announced once, politely. */
  const latestReply = useMemo(() => {
    if (!view) return null;
    for (let i = view.transcript.length - 1; i >= 0; i--) {
      const entry = view.transcript[i];
      if (entry.speaker !== "student") return entry;
    }
    return null;
  }, [view]);

  if (error && !view) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-neutral-200">
        <div className="max-w-md rounded-xl border border-red-950 bg-neutral-900 p-6 text-sm">
          <p className="text-red-300">{error}</p>
          <Link href="/session" className="mt-4 inline-block rounded-lg bg-neutral-800 px-3 py-1.5 text-neutral-200">
            Back to stations
          </Link>
        </div>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-neutral-950 text-neutral-500">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-800 border-t-emerald-500" />
        <p className="text-sm">Preparing the station…</p>
      </main>
    );
  }

  // The portrait is for the LIVE station. Once the report is on screen the
  // document is the point, so the presence column folds away entirely.
  const presenceVisible = !view.report;
  const patientLine = activeSpeaker?.role === "patient" ? activeSpeaker.text : null;

  return (
    <main
      // Fixed-height shell: top bar, body, done. --station-vh follows the visual
      // viewport so the mobile keyboard can never push the composer off-screen.
      className="station-shell relative flex flex-col overflow-hidden bg-neutral-950 text-neutral-200"
      style={{ height: "var(--station-vh, 100dvh)" }}
    >
      <style>{PRINT_CSS}</style>

      {/* ---------------- top bar ---------------- */}
      <header className="no-print z-30 shrink-0 border-b border-neutral-800/60 bg-neutral-950/95 px-3 py-2 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <Link
              href="/session"
              title="Back to the station list — this session is saved"
              className="rounded-lg px-1.5 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-200"
            >
              ← Stations
            </Link>
            <span className="hidden truncate font-mono text-[11px] text-neutral-600 sm:inline">{view.caseId}</span>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {view.stimulus && (
              <button
                onClick={() => setStimulusOpen(true)}
                className="rounded-lg border border-sky-900/60 bg-sky-950/60 px-2.5 py-1.5 text-xs text-sky-300 transition-colors hover:border-sky-700 hover:text-sky-100"
              >
                Stimulus
              </button>
            )}

            {active && (
              <VoicePicker
                sex={view.patient?.sex ?? null}
                config={voiceConfig}
                value={patientVoice}
                onChange={changePatientVoice}
              />
            )}

            {active && voiceState === "off" && (
              <button onClick={() => void enableVoice()} className={CONTROL}>
                🎙 <span className="sm:hidden">Voice</span>
                <span className="hidden sm:inline">Enable voice</span>
              </button>
            )}
            {voiceState === "enabling" && <span className="text-xs text-neutral-500">Enabling voice…</span>}
            {voiceState === "on" && (
              <span className="flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-0.5">
                <button
                  onClick={toggleMute}
                  title={muted ? "Unmute replies" : "Mute replies"}
                  aria-pressed={muted}
                  className="rounded-md px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                >
                  {muted ? "🔇" : "🔊"}
                </button>
                <button
                  onClick={repeatLast}
                  title="Repeat the last line"
                  className="rounded-md px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                >
                  ↻
                </button>
                <button
                  onClick={() => disableVoice()}
                  title="Switch back to text only"
                  className="rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  Voice off
                </button>
              </span>
            )}

            {scene.ready && scene.supported && (
              <button
                onClick={() => scene.setEnabled(!scene.enabled)}
                aria-pressed={scene.enabled}
                title={scene.enabled ? "Hide the 3D patient" : "Show the 3D patient"}
                className={CONTROL}
              >
                {scene.enabled ? "3D on" : "3D off"}
              </button>
            )}

            {/* keyboard shortcuts are meaningless on a touch device — and the
                top bar's rows are height the transcript wants back */}
            <div className="relative hidden sm:block">
              <button
                onClick={() => setShortcutsOpen((o) => !o)}
                aria-expanded={shortcutsOpen}
                title="Keyboard shortcuts (?)"
                className={`${CONTROL} w-8 px-0 text-center`}
              >
                ?
              </button>
              {shortcutsOpen && (
                <div className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-neutral-800 bg-neutral-900 p-3 text-xs shadow-xl shadow-black/40">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Shortcuts</p>
                  <dl className="mt-2 space-y-1.5 text-neutral-400">
                    {[
                      ["Enter", "send what you typed"],
                      ["Hold SPACE", "talk (voice on)"],
                      ["Esc", "close menus and overlays"],
                      ["?", "this list"],
                    ].map(([key, what]) => (
                      <div key={key} className="flex items-baseline justify-between gap-3">
                        <dt>
                          <kbd className="rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
                            {key}
                          </kbd>
                        </dt>
                        <dd className="text-right text-neutral-500">{what}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>

            <div className="relative">
              {active ? (
                <>
                  <button onClick={() => setQuitOpen((o) => !o)} aria-expanded={quitOpen} className={CONTROL}>
                    Quit
                  </button>
                  {quitOpen && (
                    <div className="absolute right-0 z-40 mt-2 w-56 rounded-xl border border-neutral-800 bg-neutral-900 p-1.5 text-sm shadow-xl shadow-black/40">
                      <Link
                        href="/session"
                        className="block rounded-lg px-2.5 py-1.5 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                      >
                        Save &amp; resume later
                      </Link>
                      <button
                        onClick={() => void endSession("mark")}
                        disabled={busy}
                        className="block w-full rounded-lg px-2.5 py-1.5 text-left text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
                      >
                        End &amp; mark now
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <span className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">{view.status}</span>
              )}
            </div>
          </div>
        </div>

        {voiceNotice && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-300">
            <span>{voiceNotice}</span>
            <button
              onClick={() => setVoiceNotice(null)}
              className="text-amber-600 hover:text-amber-300"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
      </header>

      {/* ---------------- bento body ----------------
          DOM order is presence-then-conversation so a phone stacks the clock and
          patient above the transcript; `lg:order-*` flips them side by side. */}
      <div className="station-body relative flex min-h-0 flex-1 flex-col gap-2.5 p-2.5 lg:flex-row lg:gap-3 lg:p-3">
        {presenceVisible && (
          <div className="no-print flex shrink-0 flex-col gap-2.5 lg:order-2 lg:min-h-0 lg:shrink lg:basis-[46%] lg:gap-3">
            <ClockTile
              remaining={remaining}
              elapsed={elapsed}
              timeLimitSec={view.timeLimitSec}
              active={active}
              phase={view.phase}
              stationType={view.stationType}
              patient={view.patient}
              discipline={view.discipline}
            />

            {/* A phone's vertical space belongs to the transcript: the portrait
                appears there only if she has explicitly asked for 3D. */}
            <PatientTile
              name={view.patient?.name ?? "Patient"}
              detail={view.patient ? `${view.patient.age}${view.patient.sex}` : null}
              speaking={activeSpeaker?.role === "patient"}
              line={patientLine}
              enabled={scene.ready && scene.enabled}
              reducedMotion={scene.reducedMotion}
              // Opting into 3D on a phone costs the transcript some height, so
              // the tile stays a short band there and only becomes the big
              // portrait once there is a column to put it in.
              className={`h-28 shrink-0 sm:h-40 lg:h-auto lg:min-h-0 lg:flex-1 ${
                scene.ready && scene.enabled ? "" : "hidden lg:block"
              }`}
            />

            <ExaminerBubble speaking={activeSpeaker} className="shrink-0" />
          </div>
        )}

        {/* ---- conversation column ---- */}
        <section
          className={`station-column flex min-h-0 flex-1 flex-col gap-2.5 lg:order-1 lg:gap-3 ${
            presenceVisible ? "lg:basis-[54%]" : "mx-auto w-full max-w-3xl"
          }`}
        >
          {presenceVisible && <PhaseRail phase={view.phase} stationType={view.stationType} />}

          {/* transcript — the only scroller on the page */}
          <div className={`relative flex min-h-0 flex-1 flex-col overflow-hidden ${TILE}`}>
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="station-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3.5 sm:px-4"
            >
              <div className="mx-auto w-full max-w-3xl">
                {view.transcript.length === 0 && !view.report && (
                  <p className="py-8 text-center text-sm text-neutral-600">
                    The clock is running. Introduce yourself to the patient to begin.
                  </p>
                )}
                <ul className="transcript-log space-y-2.5">
                  {view.transcript.map((entry, i) => (
                    <Bubble key={i} entry={entry} />
                  ))}
                </ul>
                {error && <p className="mt-3 rounded-lg bg-red-950 p-2 text-sm text-red-300">{error}</p>}
                {view.report && (
                  <div className="mt-3">
                    <ReportView report={view.report} />
                  </div>
                )}
                {!view.report && !active && (
                  <div className="no-print mt-3 rounded-lg border border-neutral-800 p-4 text-sm text-neutral-400">
                    Station over.{" "}
                    <button onClick={() => void endSession("mark")} className="underline" disabled={busy}>
                      Run marking
                    </button>
                  </div>
                )}
                {busy && (
                  <p className="mt-2.5 flex items-center gap-2 text-xs text-neutral-600">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-500" />
                    thinking…
                  </p>
                )}
              </div>
            </div>

            {/* she scrolled up to re-read something — don't yank her back, tell her */}
            {!pinnedToLatest && unread > 0 && (
              <button
                onClick={() => scrollToLatest()}
                className="no-print absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-[11px] text-neutral-200 shadow-lg shadow-black/40 backdrop-blur-sm hover:border-neutral-600"
              >
                {unread} new ↓
              </button>
            )}
          </div>

          {/* aria-live lives OUTSIDE the scroller so a screen reader gets the new
              line once, as prose, without the whole log being re-read. */}
          <p className="sr-only" aria-live="polite">
            {latestReply ? `${latestReply.speaker}: ${latestReply.text}` : ""}
          </p>

          {/* composer */}
          {active && (
            <footer className={`no-print shrink-0 px-3 py-2.5 ${TILE}`}>
              <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
                <QuickActions phase={view.phase} onPick={insertIntoComposer} />

                <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                  {voiceState === "on" && (
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
                      className={`flex select-none items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-40 sm:w-52 sm:shrink-0 ${
                        holding
                          ? "border-sky-500 bg-sky-950 text-sky-200"
                          : "border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-500"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${holding ? "animate-pulse bg-sky-400" : "bg-neutral-600"}`}
                      />
                      {holding ? "Listening — release" : "Hold to talk · SPACE"}
                    </button>
                  )}

                  <div className="flex flex-1 gap-2">
                    <input
                      ref={inputRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") sendTyped();
                      }}
                      disabled={busy}
                      autoFocus={voiceState === "off"}
                      aria-label="Say something to the patient or examiner"
                      placeholder={busy ? "…" : "Speak to the patient or examiner, then press Enter"}
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none disabled:opacity-50"
                    />
                    <button
                      onClick={sendTyped}
                      disabled={busy || !input.trim()}
                      className="shrink-0 rounded-lg bg-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:opacity-40"
                    >
                      Send
                    </button>
                  </div>
                </div>

                {voiceState === "on" && (holding || partial) && (
                  <p className="min-h-4 text-center text-xs italic text-neutral-500">{partial || "Listening…"}</p>
                )}
              </div>
            </footer>
          )}
        </section>
      </div>

      {/* stimulus overlay (interpretation stations) — over everything */}
      {stimulusOpen && view.stimulus && (
        <StimulusViewer stimulus={view.stimulus} onClose={() => setStimulusOpen(false)} />
      )}
    </main>
  );
}
