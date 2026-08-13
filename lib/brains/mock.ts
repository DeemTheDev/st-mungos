// MockBrain — a fully deterministic Brain implementation. No LLM anywhere:
// patient turns are template-phrased from the engine-injected facts, examiner
// turns are canned/verbatim, and mark() computes a REAL report from the
// engine's tracked logs (revealedFactIds, revealedExamSections,
// orderedInvestigations, askedExaminerQIds, transcript). This is what makes
// the whole session flow playable and testable at $0 (BRAIN=mock, the default).

import type { ClinicalCase, InterpretationCase, OsceCase } from "../case-schema";
import {
  bandFor,
  type ChecklistCoverage,
  type CoverageStatus,
  type CriticalFlag,
  type DomainScores,
  type MarkingReport,
  type VivaGrade,
} from "../marking-schema";
import { matchesAnyTrigger, normalizeText, tokenOverlap } from "../text-match";
import type {
  Brain,
  ExaminerTurnCtx,
  MarkingCtx,
  PatientTurnCtx,
  SessionState,
  TranscriptEntry,
} from "../ports";
import { examinerCannedLine } from "./shared";

const GREETING = /\b(hello|hi|good (morning|day|afternoon|evening)|my name)\b/;

type ChecklistItem = ClinicalCase["stationChecklist"][number];

/** Third-person case facts → first-person lay speech, template-only. */
function factToSpeech(fact: string): string {
  const firstPerson = fact
    .replace(/\bher\b/gi, "my")
    .replace(/\bhers\b/gi, "mine")
    .replace(/\bshe has\b/gi, "I have")
    .replace(/\bshe is\b/gi, "I am")
    .replace(/\bshe\b/gi, "I")
    .replace(/\bhis\b/gi, "my")
    .replace(/\bhe has\b/gi, "I have")
    .replace(/\bhe is\b/gi, "I am")
    .replace(/\bhe\b/gi, "I");
  return firstPerson.charAt(0).toLowerCase() + firstPerson.slice(1);
}

// ---------------------------------------------------------------------------
// deterministic marking helpers

const COMMUNICATION_ITEM = /introduc|consent|identity|communicat|rapport|professional/i;

/**
 * Only history-phase items can be communication items — "consent" also shows
 * up inside investigation items ("HIV test with consent"), which must be
 * marked by what was ordered, not by the greeting.
 */
function isCommunicationItem(item: ChecklistItem): boolean {
  return item.phase === "history" && (COMMUNICATION_ITEM.test(item.item) || COMMUNICATION_ITEM.test(item.why));
}

type Domain = keyof DomainScores;

function domainFor(item: ChecklistItem): Domain {
  if (isCommunicationItem(item)) return "communication";
  switch (item.phase) {
    case "history":
      return "historyTaking";
    case "examination":
      return "examination";
    case "differentials":
      return "clinicalReasoning";
    case "investigations":
      return "investigations";
    case "management":
      return "management";
    default:
      return "clinicalReasoning";
  }
}

function studentEntries(state: SessionState): TranscriptEntry[] {
  return state.transcript.filter((t) => t.speaker === "student");
}

function truncate(s: string, max = 140): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** The student utterance that hit one of this fact's triggers, as evidence. */
function evidenceForFact(state: SessionState, triggers: readonly string[]): string | null {
  for (const entry of studentEntries(state)) {
    if (matchesAnyTrigger(normalizeText(entry.text), triggers)) return truncate(`"${entry.text}"`);
  }
  return null;
}

const EXAM_SECTION_HINTS: Array<{ section: string; hints: RegExp }> = [
  { section: "vitals", hints: /vital|blood pressure|pulse|saturation|observation/i },
  { section: "respiratory", hints: /respiratory|chest|lung|auscultat|percuss|breath/i },
  { section: "cardio", hints: /cardio|heart|murmur|jvp|praecordium|precordium/i },
  { section: "abdo", hints: /abdo|liver|spleen|hepato|spleno|ascites/i },
  { section: "neuro", hints: /neuro|reflex|cranial|meningism|gcs/i },
  { section: "general", hints: /general|wasting|pallor|lymph|clubbing|thrush|jaundice|cyanosis|oedema/i },
];

function markClinicalItem(
  item: ChecklistItem,
  osceCase: ClinicalCase,
  state: SessionState,
): { status: CoverageStatus; evidence: string | null } {
  const itemText = `${item.item} ${item.answer ?? ""}`;
  const students = studentEntries(state);

  if (isCommunicationItem(item)) {
    const hit = students.find((e) => GREETING.test(normalizeText(e.text)));
    return hit ? { status: "done", evidence: truncate(`"${hit.text}"`) } : { status: "missed", evidence: null };
  }

  switch (item.phase) {
    case "history": {
      // done when the facts this item is about were actually surfaced.
      const candidates = osceCase.history.filter(
        (f) => tokenOverlap(`${f.fact} ${f.triggers.join(" ")}`, itemText) >= 3,
      );
      if (candidates.length === 0) {
        const hit = students.find((e) => tokenOverlap(e.text, itemText) >= 2);
        return hit
          ? { status: "done", evidence: truncate(`"${hit.text}"`) }
          : { status: "missed", evidence: null };
      }
      const revealed = candidates.filter((f) => state.revealedFactIds.includes(f.id));
      if (revealed.length === candidates.length) {
        const onAsk = revealed.find((f) => f.triggers.length > 0);
        return { status: "done", evidence: onAsk ? evidenceForFact(state, onAsk.triggers) : null };
      }
      if (revealed.length > 0) {
        const onAsk = revealed.find((f) => f.triggers.length > 0);
        return { status: "partial", evidence: onAsk ? evidenceForFact(state, onAsk.triggers) : null };
      }
      return { status: "missed", evidence: null };
    }
    case "examination": {
      const wanted = EXAM_SECTION_HINTS.filter((h) => h.hints.test(itemText)).map((h) => h.section);
      const sections = wanted.length > 0 ? wanted : ["general"];
      const performed = sections.filter((s) => (state.revealedExamSections as string[]).includes(s));
      if (performed.length === sections.length) return { status: "done", evidence: `Performed: ${performed.join(", ")}` };
      if (performed.length > 0) return { status: "partial", evidence: `Performed: ${performed.join(", ")}` };
      return { status: "missed", evidence: null };
    }
    case "investigations": {
      const key = osceCase.investigations.filter((i) => i.key).map((i) => i.name);
      const orderedKey = key.filter((name) => state.orderedInvestigations.includes(name));
      if (key.length > 0 && orderedKey.length === key.length)
        return { status: "done", evidence: `Ordered: ${orderedKey.join("; ")}` };
      if (orderedKey.length > 0) return { status: "partial", evidence: `Ordered: ${orderedKey.join("; ")}` };
      return { status: "missed", evidence: null };
    }
    case "differentials": {
      const reasoning = students.filter((e) => e.phase === "differentials");
      const top = osceCase.differentials.find((d) => d.rank === 1);
      const topHit = top
        ? students.find((e) => tokenOverlap(e.text, top.dx) >= 1 && /differential|think|likely|first|top/.test(normalizeText(e.text)))
        : undefined;
      if (topHit) return { status: "done", evidence: truncate(`"${topHit.text}"`) };
      if (reasoning.length > 0) return { status: "partial", evidence: truncate(`"${reasoning[0].text}"`) };
      return { status: "missed", evidence: null };
    }
    case "management": {
      const mgmtUtterances = students.filter((e) => e.phase === "management");
      if (mgmtUtterances.length === 0) return { status: "missed", evidence: null };
      const planText = mgmtUtterances.map((e) => e.text).join(" ");
      const target = `${itemText} ${Object.values(osceCase.management).flat().join(" ")}`;
      const overlap = tokenOverlap(planText, target);
      if (overlap >= 3) return { status: "done", evidence: truncate(`"${mgmtUtterances[0].text}"`) };
      if (overlap >= 1) return { status: "partial", evidence: truncate(`"${mgmtUtterances[0].text}"`) };
      return { status: "missed", evidence: null };
    }
    default:
      return { status: "missed", evidence: null };
  }
}

/** Her answer = the first student entry after the examiner asked the question. */
function answerToQuestion(state: SessionState, question: string): string | null {
  const idx = state.transcript.findIndex(
    (e) => e.speaker === "examiner" && e.text.includes(question),
  );
  if (idx === -1) return null;
  const answer = state.transcript.slice(idx + 1).find((e) => e.speaker === "student");
  return answer ? answer.text : null;
}

function gradeViva(osceCase: OsceCase, state: SessionState): VivaGrade[] {
  const grades: VivaGrade[] = [];
  for (const qid of state.askedExaminerQIds) {
    const q = osceCase.examinerBank.find((x) => x.id === qid);
    if (!q) continue;
    const answer = answerToQuestion(state, q.question);
    if (answer == null) {
      grades.push({ questionId: q.id, question: q.question, grade: 0, comment: "No answer was given before the station moved on." });
      continue;
    }
    const overlap = tokenOverlap(answer, q.modelAnswer);
    const grade = overlap >= 4 ? 2 : overlap >= 2 ? 1 : 0;
    grades.push({
      questionId: q.id,
      question: q.question,
      grade,
      comment: `Matched ${overlap} key point(s) from the model answer. ${q.gradingNotes}`,
    });
  }
  return grades;
}

const STATUS_POINTS: Record<CoverageStatus, number> = { done: 1, partial: 0.5, missed: 0 };

function buildModelStation(osceCase: OsceCase, checklist: ChecklistCoverage[]): string {
  const lines: string[] = ["WHAT THE COMPLETE STATION LOOKED LIKE", ""];
  for (const c of checklist) {
    const original =
      osceCase.stationType === "clinical"
        ? osceCase.stationChecklist.find((i) => i.id === c.id)
        : null;
    const answer = original?.answer ? ` → ${original.answer}` : "";
    const why = original ? ` (${original.why})` : "";
    lines.push(`[${c.phase}] ${c.item}${answer}${why}`);
  }
  if (osceCase.stationType === "clinical") {
    lines.push("", "PATHOPHYSIOLOGY MAP");
    for (const [symptom, mechanism] of Object.entries(osceCase.pathophys)) {
      lines.push(`- ${symptom}: ${mechanism}`);
    }
    lines.push("", "MANAGEMENT");
    for (const [group, items] of Object.entries(osceCase.management)) {
      if (Array.isArray(items) && items.length > 0) lines.push(`- ${group}: ${items.join("; ")}`);
    }
  } else {
    lines.push("", "MODEL INTERPRETATION");
    for (const f of osceCase.findingsKey) lines.push(`- ${f.critical ? "[critical] " : ""}${f.finding}`);
    lines.push(`- Diagnosis: ${osceCase.diagnosis}`);
  }
  return lines.join("\n");
}

function padThree(items: string[], fillers: string[]): [string, string, string] {
  const out = items.slice(0, 3);
  let i = 0;
  while (out.length < 3) out.push(fillers[i++ % fillers.length]);
  return out as [string, string, string];
}

// ---------------------------------------------------------------------------

export class MockBrain implements Brain {
  async patientTurn(ctx: PatientTurnCtx): Promise<string> {
    if (ctx.matchedFacts.length > 0) {
      return ctx.matchedFacts.map((f) => `Well, doctor — ${factToSpeech(f.fact)}`).join(" ");
    }
    if (GREETING.test(normalizeText(ctx.utterance))) return "Good morning, doctor.";
    return "I'm not sure, doctor.";
  }

  async examinerTurn(ctx: ExaminerTurnCtx): Promise<string> {
    // Verbatim bank questions + fixed in-character lines — shared with the
    // AnthropicBrain, which only spends tokens on the follow-up judgment call.
    return examinerCannedLine(ctx.directive);
  }

  async mark(ctx: MarkingCtx): Promise<MarkingReport> {
    return ctx.osceCase.stationType === "clinical"
      ? this.markClinical(ctx.osceCase, ctx.state)
      : this.markInterpretation(ctx.osceCase, ctx.state);
  }

  private markClinical(osceCase: ClinicalCase, state: SessionState): MarkingReport {
    const checklist: ChecklistCoverage[] = osceCase.stationChecklist.map((item) => {
      const { status, evidence } = markClinicalItem(item, osceCase, state);
      return { id: item.id, item: item.item, phase: item.phase, status, evidence, weight: item.weight, critical: item.critical };
    });

    const criticalFlags: CriticalFlag[] = checklist
      .filter((c) => c.critical && c.status === "missed")
      .map((c) => {
        const item = osceCase.stationChecklist.find((i) => i.id === c.id)!;
        return {
          checklistId: c.id,
          message: `Missed critical item: "${item.item}" — ${item.why}. In this presentation that is an automatic examiner concern.`,
        };
      });

    const viva = gradeViva(osceCase, state);

    // Domain scores from checklist weights; viva folds into clinical reasoning.
    const earned: Record<Domain, number> = { communication: 0, historyTaking: 0, examination: 0, clinicalReasoning: 0, investigations: 0, management: 0 };
    const possible: Record<Domain, number> = { ...earned };
    for (const c of checklist) {
      const item = osceCase.stationChecklist.find((i) => i.id === c.id)!;
      const domain = domainFor(item);
      possible[domain] += item.weight;
      earned[domain] += item.weight * STATUS_POINTS[c.status];
    }
    const overallCoverage =
      checklist.reduce((a, c) => a + STATUS_POINTS[c.status], 0) / Math.max(1, checklist.length);
    const domainScores = {} as DomainScores;
    for (const domain of Object.keys(earned) as Domain[]) {
      domainScores[domain] =
        possible[domain] > 0
          ? Math.round((earned[domain] / possible[domain]) * 100)
          : Math.round(overallCoverage * 100);
    }
    if (viva.length > 0) {
      const vivaPct = (viva.reduce((a, v) => a + v.grade, 0) / (viva.length * 2)) * 100;
      domainScores.clinicalReasoning = Math.round((domainScores.clinicalReasoning + vivaPct) / 2);
    }

    const globalScore = Math.round(
      (Object.entries(osceCase.rubric) as Array<[Domain, number]>).reduce(
        (acc, [domain, weight]) => acc + (weight / 100) * domainScores[domain],
        0,
      ),
    );

    const strengths = checklist
      .filter((c) => c.status === "done")
      .sort((a, b) => b.weight - a.weight)
      .map((c) => `${c.item} — covered well${c.evidence ? ` (${c.evidence})` : ""}.`);
    const improvements = [
      ...criticalFlags.map((f) => f.message),
      ...checklist
        .filter((c) => c.status !== "done" && !criticalFlags.some((f) => f.checklistId === c.id))
        .map((c) => `${c.status === "partial" ? "Only partially covered" : "Missed"}: ${c.item}.`),
    ];

    return {
      stationType: "clinical",
      checklist,
      criticalFlags,
      viva,
      domainScores,
      globalScore,
      band: bandFor(globalScore),
      narrative: {
        strengths: padThree(strengths, [
          "Kept the consultation moving and stayed within the station time.",
          "Maintained a professional, structured approach throughout.",
          "Responded to examiner questions without losing the thread of the consultation.",
        ]),
        improvements: padThree(improvements, [
          "Tighten the link between each differential and the specific findings that support it.",
          "Verbalise your reasoning as you go — examiners can only mark what they hear.",
          "Summarise your findings before presenting the plan.",
        ]),
        modelStation: buildModelStation(osceCase, checklist),
      },
    };
  }

  private markInterpretation(osceCase: InterpretationCase, state: SessionState): MarkingReport {
    const allStudentText = studentEntries(state)
      .map((e) => e.text)
      .join(" ");

    const checklist: ChecklistCoverage[] = osceCase.interpretationChecklist.map((step) => {
      const overlap = tokenOverlap(allStudentText, step.item);
      const status: CoverageStatus = overlap >= 2 ? "done" : overlap >= 1 ? "partial" : "missed";
      return {
        id: step.id,
        item: step.item,
        phase: "interpret",
        status,
        evidence: status === "missed" ? null : `Mentioned ${overlap} element(s) of this step.`,
        weight: step.weight,
        critical: false,
      };
    });

    const findings = osceCase.findingsKey.map((f) => ({
      finding: f.finding,
      critical: f.critical,
      identified: tokenOverlap(allStudentText, f.finding) >= 2,
    }));
    const criticalFlags: CriticalFlag[] = findings
      .filter((f) => f.critical && !f.identified)
      .map((f) => ({ checklistId: "finding", message: `Missed critical finding: ${f.finding}.` }));

    const viva = gradeViva(osceCase, state);
    const diagnosisCorrect = tokenOverlap(allStudentText, osceCase.diagnosis) >= 2;

    const stepPossible = checklist.reduce((a, c) => a + c.weight, 0);
    const stepEarned = checklist.reduce((a, c) => a + c.weight * STATUS_POINTS[c.status], 0);
    const stepPct = stepPossible > 0 ? stepEarned / stepPossible : 0;
    const findingPct = findings.length > 0 ? findings.filter((f) => f.identified).length / findings.length : 0;
    // §7.7: systematic method + findings hit rate + final diagnosis.
    const globalScore = Math.round(100 * (0.6 * stepPct + 0.25 * findingPct + 0.15 * (diagnosisCorrect ? 1 : 0)));

    const strengths = checklist.filter((c) => c.status === "done").map((c) => `${c.item} — verbalised clearly.`);
    const improvements = [
      ...criticalFlags.map((f) => f.message),
      ...checklist.filter((c) => c.status !== "done").map((c) => `Work the step "${c.item}" into your routine — say it aloud every time.`),
    ];

    return {
      stationType: "interpretation",
      checklist,
      criticalFlags,
      viva,
      globalScore,
      band: bandFor(globalScore),
      narrative: {
        strengths: padThree(strengths, [
          "Committed to an interpretation rather than hedging.",
          "Kept to a systematic order.",
          "Linked the numbers back to the clinical context.",
        ]),
        improvements: padThree(improvements, [
          "State the oxygenation assessment before the acid-base sequence every time.",
          "Quote the actual values as you interpret them.",
          "Finish with one synthesised sentence: disorder, compensation, cause.",
        ]),
        modelStation: buildModelStation(osceCase, checklist),
      },
      findings,
      diagnosisCorrect,
    };
  }
}
