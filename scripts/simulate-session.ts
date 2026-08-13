// $0 end-to-end test of the Phase 2 session engine: drives full 20-minute
// stations headlessly against MockBrain + a temp FileSessionStore using the
// hand-checked seed case (resp-001-ptb-hiv). Two scripted runs:
//   1. a good student — covers intro → history (HIV / TB-contact triggers) →
//      examination → differentials → investigations → management → end & mark;
//   2. a "bad student" — never asks about HIV, asserting cl-hiv is missed AND
//      critically flagged;
//   3. quit/resume timer semantics;
//   4. the MockBrain's conversational floor — openers, repeat requests,
//      acknowledgements and the rotated soft fallbacks, with a hard assertion
//      that the opener path leaks NO onAsk fact.
// Time is injected per turn, so timer warnings, the history nudge and the
// 20:00 cut-off are all exercised deterministically. NO Anthropic calls.
//
// Usage: pnpm simulate

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBrain, PATIENT_FALLBACKS } from "../lib/brains/mock";
import { MarkingReportSchema, type MarkingReport } from "../lib/marking-schema";
import { SessionEngine, type TurnResult } from "../lib/session-engine";
import { FileSessionStore, FsCaseStore } from "../lib/stores/file-store";

const CASE_ID = "resp-001-ptb-hiv";
const T0 = Date.parse("2026-08-13T08:00:00.000Z");
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

function replyText(result: TurnResult): string {
  return result.replies.map((r) => `${r.speaker}: ${r.text}`).join("\n");
}

function coverage(report: MarkingReport, id: string): string | null {
  return report.checklist.find((c) => c.id === id)?.status ?? null;
}

// ---------------------------------------------------------------------------

async function goodStudentRun(engine: SessionEngine): Promise<MarkingReport> {
  console.log("\n=== RUN 1: good student ===");
  const s = await engine.createSession(CASE_ID, at(0));
  check("session starts in intro with the patient's opening line",
    s.phase === "intro" && s.transcript[0]?.speaker === "patient");
  check("volunteered facts are pre-revealed", s.revealedFactIds.includes("hx-onset"));
  check("onAsk facts NOT revealed before their trigger (hx-sputum, hx-hiv, hx-tb-contact)",
    !s.revealedFactIds.includes("hx-sputum") && !s.revealedFactIds.includes("hx-hiv") && !s.revealedFactIds.includes("hx-tb-contact"));

  let r = await engine.takeTurn(s.id, "Good morning Mrs Dlamini, my name is Azra, I'm the doctor seeing you today. Is it okay if I ask you some questions?", at(10));
  check("intro → history on the first student utterance", r.state.phase === "history");
  check("greeting reveals nothing", !r.state.revealedFactIds.includes("hx-sputum"));

  r = await engine.takeTurn(s.id, "Tell me about the cough — are you coughing up any sputum or blood?", at(60));
  check("hx-sputum revealed AFTER its trigger", r.state.revealedFactIds.includes("hx-sputum"));
  check("the patient answers from the revealed fact", replyText(r).toLowerCase().includes("sputum"));
  check("unrelated onAsk facts stay hidden (hx-tb-contact)", !r.state.revealedFactIds.includes("hx-tb-contact"));

  r = await engine.takeTurn(s.id, "Any night sweats? Have you lost weight? Any fevers or chills?", at(120));
  check("constitutional-symptom triggers reveal their facts",
    ["hx-nightsweats", "hx-weightloss", "hx-fever"].every((id) => r.state.revealedFactIds.includes(id)));

  r = await engine.takeTurn(s.id, "Do you have any chest pain?", at(180));
  check("asking about 'chest pain' reveals the history fact", r.state.revealedFactIds.includes("hx-chestpain"));
  check("exam findings are GATED — a history question about the chest reveals no examination",
    r.state.revealedExamSections.length === 0 && !replyText(r).includes("bronchial breathing"));

  r = await engine.takeTurn(s.id, "Any previous illnesses or hospital admissions? Are you taking any medication? Any allergies?", at(210));
  check("PMH / meds / allergies triggers fire",
    ["hx-pmh", "hx-meds", "hx-allergies"].every((id) => r.state.revealedFactIds.includes(id)));

  r = await engine.takeTurn(s.id, "Have you ever been tested for HIV? What is your partner's status?", at(250));
  check("hx-hiv revealed after the HIV question", r.state.revealedFactIds.includes("hx-hiv"));

  r = await engine.takeTurn(s.id, "Has anyone at home been sick with TB?", at(310));
  check("hx-tb-contact revealed after the TB-contact question", r.state.revealedFactIds.includes("hx-tb-contact"));
  check("ex-1 fires at its 300s history trigger", r.state.askedExaminerQIds.includes("ex-1")
    && replyText(r).includes("what is your differential diagnosis at this point"));
  check("ex-1 is pending the student's answer", r.state.pendingExaminerQId === "ex-1");

  r = await engine.takeTurn(s.id, "My differential is pulmonary tuberculosis first given the household contact, chronic cough, night sweats and weight loss; then community-acquired pneumonia, then bronchiectasis, then lung malignancy.", at(360));
  check("answering the examiner clears the pending question", r.state.pendingExaminerQId === null
    && r.state.answeredExaminerQIds.includes("ex-1"));
  check("answering a viva question does not change phase", r.state.phase === "history");

  r = await engine.takeTurn(s.id, "I would like to examine the patient now.", at(400));
  check("student-driven transition: history → examination", r.state.phase === "examination");
  check("no findings before a specific step is performed", r.state.revealedExamSections.length === 0);
  check("ex-2 fires on examination phase entry", r.state.askedExaminerQIds.includes("ex-2"));

  r = await engine.takeTurn(s.id, "Chronic granulomatous infection releases cytokines like TNF alpha and IL-1 which reset the hypothalamic temperature set point; the fever breaks at night with sweating.", at(430));
  check("ex-2 answered", r.state.answeredExaminerQIds.includes("ex-2"));

  r = await engine.takeTurn(s.id, "I will check her vitals and do a general inspection.", at(460));
  check("vitals + general narrated when performed",
    (r.state.revealedExamSections as string[]).includes("vitals")
      && (r.state.revealedExamSections as string[]).includes("general")
      && replyText(r).includes("104")
      && replyText(r).toLowerCase().includes("lymphadenopathy"));
  check("respiratory findings still gated", !(r.state.revealedExamSections as string[]).includes("respiratory"));

  r = await engine.takeTurn(s.id, "I will auscultate and percuss the chest.", at(490));
  check("respiratory findings narrated after the step", replyText(r).includes("bronchial breathing"));

  r = await engine.takeTurn(s.id, "My differential diagnosis: pulmonary tuberculosis first, then community-acquired pneumonia, bronchiectasis, and lung malignancy.", at(520));
  check("student-driven transition: → differentials", r.state.phase === "differentials");

  r = await engine.takeTurn(s.id, "I'd like to order some investigations: sputum GeneXpert, an HIV test, a chest x-ray, and a CD4 count.", at(601));
  check("→ investigations, exactly the 4 requested tests ordered",
    r.state.phase === "investigations" && r.state.orderedInvestigations.length === 4,
    `ordered: ${r.state.orderedInvestigations.join(" | ")}`);
  check("results returned verbatim", replyText(r).includes("MTB detected")
    && replyText(r).includes("Positive") && replyText(r).includes("187") && replyText(r).includes("cavitation"));
  check("unrequested tests are not free", !r.state.orderedInvestigations.includes("Full blood count"));
  check("ex-3 fires on investigations phase entry", r.state.askedExaminerQIds.includes("ex-3"));
  check("10:00 timer warning fires when elapsed is forced past 600s",
    replyText(r).includes("10 minutes remaining") && r.state.issuedWarningsSec.includes(600));

  r = await engine.takeTurn(s.id, "Her CD4 is below 200 so I would start co-trimoxazole preventive therapy, begin ART within 8 weeks of TB treatment, watch for other opportunistic infections and counsel about IRIS.", at(660));
  check("ex-3 answered", r.state.answeredExaminerQIds.includes("ex-3"));

  r = await engine.takeTurn(s.id, "My management plan: I would start 2HRZE/4HR fixed-dose combination therapy, notify the TB programme, arrange contact tracing, add co-trimoxazole prophylaxis and pyridoxine, and start ART after two weeks.", at(1021));
  check("student-driven transition: → management", r.state.phase === "management");
  check("ex-4 fires on management phase entry", r.state.askedExaminerQIds.includes("ex-4"));
  check("17:00 timer warning fires when elapsed is forced past 1020s",
    replyText(r).includes("3 minutes remaining") && r.state.issuedWarningsSec.includes(1020));

  r = await engine.takeTurn(s.id, "The household must be screened under the TB programme, the two children need evaluation and TB preventive therapy if eligible, the partner should be linked to HIV care, and the case must be notified.", at(1080));
  check("ex-4 answered", r.state.answeredExaminerQIds.includes("ex-4"));

  r = await engine.takeTurn(s.id, "Is there anything else I should cover?", at(1205));
  check("20:00 hard stop: examiner ends the station", r.timeUp && r.state.phase === "wrap"
    && replyText(r).includes("time's up"));

  let rejected = false;
  try {
    await engine.takeTurn(s.id, "One more thing...", at(1210));
  } catch {
    rejected = true;
  }
  check("turns after time-up are rejected", rejected);

  const ended = await engine.endSession(s.id, "mark", at(1215));
  const report = ended.report!;
  check("marking report validates against MarkingReportSchema",
    MarkingReportSchema.safeParse(report).success);
  check("session persisted as completed with the report", ended.status === "completed" && ended.report !== null);
  check("cl-hiv marked done for the good student", coverage(report, "cl-hiv") === "done",
    `got ${coverage(report, "cl-hiv")}`);
  check("no critical flags for the good student", report.criticalFlags.length === 0,
    report.criticalFlags.map((f) => f.checklistId).join(", "));
  check("good student scores at least a pass", report.globalScore >= 60 && (report.band === "pass" || report.band === "distinction"),
    `score ${report.globalScore}, band ${report.band}`);
  check("every asked viva question is graded", report.viva.length === 4);
  check("narrative has exactly 3 strengths + 3 improvements and a model station incl. pathophysiology",
    report.narrative.strengths.length === 3 && report.narrative.improvements.length === 3
      && report.narrative.modelStation.includes("PATHOPHYSIOLOGY MAP"));

  // resumed sessions restore state exactly
  const resumed = await engine.resume(s.id, at(2000));
  check("resume restores the completed session", resumed.status === "completed"
    && resumed.transcript.length === ended.transcript.length);

  return report;
}

// ---------------------------------------------------------------------------

async function badStudentRun(engine: SessionEngine): Promise<MarkingReport> {
  console.log("\n=== RUN 2: bad student (never asks about HIV) ===");
  const s = await engine.createSession(CASE_ID, at(0));

  await engine.takeTurn(s.id, "Hello, I'm the student doctor. May I ask you some questions?", at(10));
  let r = await engine.takeTurn(s.id, "Tell me about your cough — is there any phlegm?", at(100));
  check("cough fact revealed", r.state.revealedFactIds.includes("hx-sputum"));

  r = await engine.takeTurn(s.id, "How long has this been going on?", at(320));
  check("ex-1 fires for the bad student too", r.state.pendingExaminerQId === "ex-1");

  r = await engine.takeTurn(s.id, "It could be pneumonia or maybe bronchitis.", at(360));

  r = await engine.takeTurn(s.id, "Do you smoke?", at(510));
  check("examiner nudges after >8 min stuck in history",
    replyText(r).includes("In the interest of time") && r.state.nudgedPhases.includes("history"));

  r = await engine.takeTurn(s.id, "I will auscultate the chest.", at(540));
  check("performing an exam step transitions to examination", r.state.phase === "examination"
    && (r.state.revealedExamSections as string[]).includes("respiratory"));

  r = await engine.takeTurn(s.id, "I'm not sure about the mechanism.", at(570));

  r = await engine.takeTurn(s.id, "I'd like to order a sputum GeneXpert and a chest x-ray.", at(610));
  check("only the requested tests are ordered", r.state.orderedInvestigations.length === 2,
    r.state.orderedInvestigations.join(" | "));

  r = await engine.takeTurn(s.id, "It shows TB so I would just start treatment.", at(640));
  r = await engine.takeTurn(s.id, "I think this is pneumonia.", at(700));
  check("'I think this is…' counts as presenting a differential", r.state.phase === "differentials");

  r = await engine.takeTurn(s.id, "I would give antibiotics and fluids.", at(800));
  check("management intent detected", r.state.phase === "management");
  await engine.takeTurn(s.id, "I'm not sure.", at(850));

  const ended = await engine.endSession(s.id, "mark", at(900));
  const report = ended.report!;
  check("bad-student report validates against MarkingReportSchema",
    MarkingReportSchema.safeParse(report).success);
  check("HIV was never revealed", !ended.revealedFactIds.includes("hx-hiv"));
  check("cl-hiv marked missed", coverage(report, "cl-hiv") === "missed", `got ${coverage(report, "cl-hiv")}`);
  check("cl-hiv raises a critical flag", report.criticalFlags.some((f) => f.checklistId === "cl-hiv"),
    report.criticalFlags.map((f) => f.checklistId).join(", ") || "(none)");
  check("cl-tb-contact also critically flagged", report.criticalFlags.some((f) => f.checklistId === "cl-tb-contact"));
  // regression: "HIV test with consent" in the item text must NOT route this
  // item through the greeting heuristic — it is graded from what was ordered.
  check("cl-ix graded from ordered tests (partial: 2 of 4 key tests)", coverage(report, "cl-ix") === "partial",
    `got ${coverage(report, "cl-ix")}`);
  return report;
}

// ---------------------------------------------------------------------------

async function timerResumeCheck(engine: SessionEngine): Promise<void> {
  console.log("\n=== RUN 3: quit/resume timer semantics ===");
  const s = await engine.createSession(CASE_ID, at(0));
  await engine.takeTurn(s.id, "Good morning, I'm the doctor on duty today.", at(10));
  // ... the student quits; a long real-world gap follows ...
  await engine.resume(s.id, at(100_000));
  const r = await engine.takeTurn(s.id, "Sorry — tell me about the cough again?", at(100_010));
  check("away-time never counts toward the 20 minutes (10s + 10s active ≈ 20s)",
    r.state.elapsedActiveSec >= 19 && r.state.elapsedActiveSec <= 25,
    `elapsedActiveSec = ${r.state.elapsedActiveSec}`);
  check("session is still comfortably inside the station timer", !r.timeUp);
}

/**
 * The conversational floor: the turns that hit NO fact trigger. Before this
 * existed every one of them returned "I'm not sure, doctor.", which reads as a
 * broken patient. The information model is unchanged — the opener path must
 * still leak nothing that the student has not earned by asking.
 */
async function conversationalFloorRun(engine: SessionEngine): Promise<void> {
  console.log("\n=== RUN 4: conversational floor (opener / repeat / ack / fallback) ===");
  const s = await engine.createSession(CASE_ID, at(0));

  // -- opener: restate the presenting story, not the not-sure fallback.
  let r = await engine.takeTurn(s.id, "What brings you in today?", at(10));
  const opener = replyText(r);
  check("opener 'what brings you in' restates the presenting complaint (the cough) instead of the fallback",
    /cough/i.test(opener) && !/not sure/i.test(opener), opener);
  check("opener narrates the volunteered onset fact", /6 weeks/i.test(opener), opener);
  // Every onAsk fact in this case, by its most distinctive words.
  check("opener leaks NO onAsk-only fact text",
    !/sputum|phlegm|blood|night sweat|weight|hiv|partner|uncle|smoke|allerg|paracetamol|umlazi|breath/i.test(opener),
    opener);
  check("opener reveals no new facts — only the volunteered one stays revealed",
    r.state.revealedFactIds.length === 1 && r.state.revealedFactIds[0] === "hx-onset",
    r.state.revealedFactIds.join(", "));

  // -- repeat request: echo the previous patient line.
  const previousLine = r.replies.find((x) => x.speaker === "patient")!.text;
  r = await engine.takeTurn(s.id, "Sorry, could you repeat that?", at(20));
  const echo = replyText(r);
  check("repeat request echoes the patient's previous line",
    echo.includes("I said,") && echo.includes(previousLine.split("—").pop()!.trim().slice(0, 40)),
    echo);

  // -- acknowledgement: a beat, not a fallback.
  r = await engine.takeTurn(s.id, "Okay, thank you.", at(30));
  const ack = replyText(r);
  check("acknowledgement gets a brief natural beat, not the not-sure fallback",
    /doctor/i.test(ack) && !/not sure|don t understand|couldn t say/i.test(ack), ack);

  // -- unmatched questions: softened AND rotated, deterministically.
  const f1 = replyText(await engine.takeTurn(s.id, "Quorble frazzle wibbet?", at(40)));
  const f2 = replyText(await engine.takeTurn(s.id, "Snarfle bimbly zonk?", at(50)));
  check("consecutive unmatched questions rotate to DIFFERENT fallbacks", f1 !== f2, `${f1} / ${f2}`);
  check("both fallbacks come from the fixed rotation (deterministic, no RNG)",
    PATIENT_FALLBACKS.some((p) => f1.endsWith(p)) && PATIENT_FALLBACKS.some((p) => f2.endsWith(p)),
    `${f1} / ${f2}`);

  await engine.endSession(s.id, "abandon", at(60));
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "st-mungos-sim-"));
  const engine = new SessionEngine({
    caseStore: new FsCaseStore(),
    sessionStore: new FileSessionStore(dir),
    brain: new MockBrain(),
  });

  let good: MarkingReport | null = null;
  let bad: MarkingReport | null = null;
  try {
    good = await goodStudentRun(engine);
    bad = await badStudentRun(engine);
    await timerResumeCheck(engine);
    await conversationalFloorRun(engine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (good && bad) {
    check("\nthe bad student scores strictly lower than the good student", bad.globalScore < good.globalScore,
      `bad ${bad.globalScore} vs good ${good.globalScore}`);
    console.log(`\n  good student: ${good.globalScore}/100 (${good.band})`);
    console.log(`  bad student:  ${bad.globalScore}/100 (${bad.band})`);
  }

  console.log(`\n${"=".repeat(60)}`);
  if (failures.length === 0) {
    console.log(`SIMULATION PASSED — ${passed} checks, 0 failures, 0 Anthropic calls.`);
  } else {
    console.error(`SIMULATION FAILED — ${passed} passed, ${failures.length} failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
