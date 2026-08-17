// Live-brain end-to-end proof (CLAUDE.md §6/§7). Everything else in this repo
// is verified against MockBrain at $0; this is the one script that actually
// spends money, so it is deliberately small, opt-in, and asserts the two
// properties that cannot be checked any other way:
//
//   1. ENGINE-GATED DISCLOSURE HOLDS AGAINST A REAL MODEL. Run A never asks
//      about HIV, so hx-hiv never matches a trigger, so the patient model is
//      never sent that fact. We assert no reply mentions it. The mock can't
//      prove this — only a model that *would* happily improvise can.
//   2. PROMPT CACHING IS REALLY ENGAGING on the padded patient rules block
//      (DECISIONS.md: Haiku needs a >=4096-token prefix before cache_control
//      does anything). We read the per-turn usage the brain already logs.
//
// Run A is a clinical station (patient = Haiku + marking = Sonnet), run B an
// interpretation station (examiner = Sonnet, no patient turns) so both brain
// paths are exercised. ~12 model calls total, well under a dollar.
//
// Usage: pnpm e2e:live          (requires ANTHROPIC_API_KEY in .env.local)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicBrain } from "../lib/brains/anthropic";
import { MarkingReportSchema, type MarkingReport } from "../lib/marking-schema";
import { SessionEngine, type TurnResult } from "../lib/session-engine";
import { FileSessionStore, FsCaseStore } from "../lib/stores/file-store";

const CLINICAL_CASE = "resp-001-ptb-hiv";
const INTERP_CASE = "interp-abg-001-diabetic-ketoacidosis-high-anion";
const T0 = Date.parse("2026-08-17T08:00:00.000Z");
const at = (sec: number): number => T0 + sec * 1000;

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --------------------------------------------------------------------------
// usage capture — AnthropicBrain already logs "[patient turn] cache_read=…",
// so we tee console.log rather than instrumenting the brain for a test.

interface TurnUsage {
  cacheRead: number;
  cacheWrite: number;
  input: number;
}
const usage: TurnUsage[] = [];
const realLog = console.log.bind(console);

function installUsageTap(): void {
  console.log = (...args: unknown[]): void => {
    const line = args.map(String).join(" ");
    const m = /\[patient turn\] cache_read=(\d+|undefined) cache_write=(\d+|undefined) in=(\d+)/.exec(line);
    if (m) {
      usage.push({
        cacheRead: Number(m[1]) || 0,
        cacheWrite: Number(m[2]) || 0,
        input: Number(m[3]),
      });
      return; // swallow — we print a tidy table at the end
    }
    realLog(...args);
  };
}

function patientText(result: TurnResult): string {
  return result.replies.filter((r) => r.speaker === "patient").map((r) => r.text).join(" ");
}

function transcriptTail(result: TurnResult, utterance: string): void {
  realLog(`\n  student  › ${utterance}`);
  for (const reply of result.replies) realLog(`  ${reply.speaker.padEnd(8)} › ${reply.text}`);
}

// --------------------------------------------------------------------------

async function runClinical(engine: SessionEngine): Promise<MarkingReport | null> {
  realLog("\n=== RUN A: clinical station (live patient + live marking) ===");
  realLog(`case: ${CLINICAL_CASE}`);

  const session = await engine.createSession(CLINICAL_CASE, at(0));
  realLog(`\n  patient  › ${session.transcript[0]?.text ?? "(no opening line)"}`);

  // NOTE: none of these utterances may contain an hx-hiv trigger word
  // (hiv/test/tested/status/partner/boyfriend/sexual/relationship/std/sti) —
  // that is the whole point of the leak assertion below.
  const script: Array<[string, number]> = [
    ["Good morning, I'm Dr Azra. May I ask you a few questions about what brought you in?", 10],
    ["Tell me more about the cough — are you bringing up any phlegm, and has there been any blood in it?", 60],
    ["Have you been waking up drenched at night, and have your clothes felt looser lately?", 120],
    ["Are you short of breath walking up a hill, and do you have any fevers or chills?", 180],
    ["Have you had any illnesses or hospital admissions before, and are you taking any medication?", 240],
    ["My leading differential is pulmonary tuberculosis, then community-acquired pneumonia, then bronchiectasis, then lung malignancy.", 400],
    ["I would like to send a sputum GeneXpert, a chest x-ray, and bloods including a full blood count.", 620],
    ["My plan is to start 2HRZE/4HR fixed-dose combination therapy, notify the TB programme, arrange household screening, and add pyridoxine.", 1030],
  ];

  // The first five utterances are history-phase questions the patient answers;
  // from the differential onwards the examiner holds the floor, so those turns
  // legitimately carry no patient reply.
  const HISTORY_TURNS = 5;
  const patientReplies: string[] = [];
  for (const [utterance, sec] of script) {
    const result = await engine.takeTurn(session.id, utterance, at(sec));
    transcriptTail(result, utterance);
    patientReplies.push(patientText(result));
  }

  const allPatientText = patientReplies.join(" ").toLowerCase();

  realLog("");
  // (1) the property that matters most in the whole product.
  const leaked = ["hiv", "antiretroviral", " arv", "positive"].filter((w) => allPatientText.includes(w));
  check(
    "engine-gated disclosure holds: the live patient never leaked hx-hiv (never asked)",
    leaked.length === 0,
    leaked.length ? `leaked term(s): ${leaked.join(", ")}` : undefined,
  );
  check("live patient answered every history-phase question",
    patientReplies.slice(0, HISTORY_TURNS).every((r) => r.trim().length > 0) && allPatientText.length > 120,
    patientReplies.slice(0, HISTORY_TURNS).map((r, i) => `${i}:${r.length}`).join(" "));
  check("patient answered the revealed sputum fact in character",
    /sputum|phlegm|cough/.test(allPatientText));

  const ended = await engine.endSession(session.id, "mark", at(1215));
  const report = ended.report ?? null;
  check("live marking returned a report", report != null);
  if (!report) return null;

  const parsed = MarkingReportSchema.safeParse(report);
  check("live marking report satisfies MarkingReportSchema", parsed.success,
    parsed.success ? undefined : parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; "));

  const hiv = report.checklist.find((c) => c.id === "cl-hiv");
  check("marking flags the un-asked HIV item as missed (not hallucinated as done)",
    hiv != null && hiv.status === "missed",
    hiv ? `status=${hiv.status}` : "cl-hiv absent from the checklist");

  realLog(`\n  band: ${report.band} · global ${report.globalScore}`);
  realLog(`  checklist: ${report.checklist.filter((c) => c.status === "done").length}/${report.checklist.length} done`);
  if (report.criticalFlags.length > 0) {
    realLog(`  critical flags: ${report.criticalFlags.map((f) => f.message).join(" | ").slice(0, 220)}`);
  }
  realLog(`  strength: ${report.narrative.strengths[0]}`);
  realLog(`  improvement: ${report.narrative.improvements[0]}`);
  return report;
}

async function runInterpretation(store: FileSessionStore): Promise<void> {
  realLog("\n\n=== RUN B: interpretation station (live examiner + live marking) ===");
  realLog(`case: ${INTERP_CASE}`);
  // The reviewed bank holds no interpretation station yet (every ABG is still a
  // draft awaiting Azra's review), and FsCaseStore deliberately serves the bank
  // only — so this run points a second engine at cases/drafts on purpose. Once
  // an ABG is approved, drop the argument and this reads the bank like run A.
  const engine = new SessionEngine({
    caseStore: new FsCaseStore(join(process.cwd(), "cases", "drafts")),
    sessionStore: store,
    brain: new AnthropicBrain(),
  });

  const session = await engine.createSession(INTERP_CASE, at(0));
  for (const entry of session.transcript) realLog(`  ${entry.speaker.padEnd(8)} › ${entry.text}`);

  const script: Array<[string, number]> = [
    ["This is a high anion gap metabolic acidosis with appropriate respiratory compensation.", 30],
    ["The anion gap is raised and the picture fits diabetic ketoacidosis given the glucose and ketones.", 150],
    ["I would start fluid resuscitation, a fixed-rate insulin infusion, and replace potassium before the insulin if it is low.", 300],
  ];

  let last: TurnResult | null = null;
  for (const [utterance, sec] of script) {
    last = await engine.takeTurn(session.id, utterance, at(sec));
    transcriptTail(last, utterance);
  }

  realLog("");
  check("live examiner replied on the interpretation station",
    last != null && last.replies.some((r) => r.speaker === "examiner" && r.text.trim().length > 0));

  const ended = await engine.endSession(session.id, "mark", at(560));
  const report = ended.report ?? null;
  check("interpretation station produced a marking report", report != null);
  if (report) {
    const parsed = MarkingReportSchema.safeParse(report);
    check("interpretation marking report satisfies MarkingReportSchema", parsed.success,
      parsed.success ? undefined : parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; "));
    realLog(`\n  band: ${report.band}`);
  }
}

// --------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    console.warn("(!) .env.local not found — relying on ambient environment variables");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set (expected in .env.local). Aborting — this script spends money by design.");
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "st-mungos-live-"));
  const sessionStore = new FileSessionStore(dir);
  const engine = new SessionEngine({
    caseStore: new FsCaseStore(),
    sessionStore,
    brain: new AnthropicBrain(),
  });

  installUsageTap();
  try {
    // A failure in one run must not swallow the other run's output or the cache
    // table below — this script costs money, so every call must yield evidence.
    for (const [label, run] of [
      ["A (clinical)", () => runClinical(engine)],
      ["B (interpretation)", () => runInterpretation(sessionStore)],
    ] as const) {
      try {
        await run();
      } catch (err) {
        check(`run ${label} completed without throwing`, false, err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------
  // caching evidence
  if (usage.length > 0) {
    realLog("\n\n=== patient-turn cache behaviour ===");
    realLog("  turn | input | cache write | cache read");
    usage.forEach((u, i) => {
      realLog(`  ${String(i + 1).padStart(4)} | ${String(u.input).padStart(5)} | ${String(u.cacheWrite).padStart(11)} | ${String(u.cacheRead).padStart(10)}`);
    });
    const wroteCache = usage.some((u) => u.cacheWrite > 0);
    const readCache = usage.slice(1).some((u) => u.cacheRead > 0);
    check("the padded patient rules block is written to the prompt cache", wroteCache);
    check("later patient turns READ the cache (the padding past Haiku's 4096-token floor works)", readCache,
      readCache ? undefined : "every turn re-paid full input price — the cached prefix is not stable");
  } else {
    check("captured per-turn patient usage", false, "no [patient turn] usage lines were logged");
  }

  realLog(`\n${passed} check(s) passed, ${failures.length} failure(s).`);
  if (failures.length > 0) {
    for (const f of failures) realLog(`  - ${f}`);
    process.exit(1);
  }
}

void main();
