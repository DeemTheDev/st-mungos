// The whole case, laid out to be READ rather than audited — same completeness as
// the old /admin/review JSON dump (history + triggers, examination,
// investigations, differentials, pathophys, management, mark sheet, examiner
// bank, rubric), but framed as the question she is actually answering: does this
// hold up clinically?
//
// Each section carries one plain-language "check this" line, because the
// failure modes here are specific and known — a too-narrow trigger list marks a
// student wrong for asking a good question in ordinary words (DECISIONS.md
// 2026-08-17), an investigation with no result stalls a station, a mark sheet
// that doesn't match the framework teaches the wrong approach.
//
// No tables: at 375px a 6-column mark sheet is unreadable, so every row is a
// block that reflows.
import type { ReactNode } from "react";
import type { ClinicalCase, InterpretationCase, OsceCase } from "@/lib/case-schema";
import { systemLabel } from "./api";
import { Chip, TILE, type Tone } from "./ui";

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <h3 className="text-sm font-semibold text-neutral-200">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
      <div className="mt-2 text-sm text-neutral-300">{children}</div>
    </section>
  );
}

function CriticalBadge() {
  return <span className="rounded bg-red-950 px-1.5 py-0.5 text-xs font-semibold text-red-300">must not miss</span>;
}

function List({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="text-neutral-600">—</p>;
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-neutral-500 sm:w-36">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function ManagementBlock({
  management,
}: {
  management: Partial<Record<"immediate" | "definitive" | "supportive" | "followUp", string[]>>;
}) {
  const groups: Array<[string, string[] | undefined]> = [
    ["Immediate", management.immediate],
    ["Definitive", management.definitive],
    ["Supportive", management.supportive],
    ["Follow-up", management.followUp],
  ];
  const filled = groups.filter(([, items]) => items && items.length > 0);
  if (filled.length === 0) return <p className="text-neutral-600">Nothing written down — that&apos;s a gap.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {filled.map(([label, items]) => (
        <div key={label}>
          <p className="mb-1 font-medium text-neutral-400">{label}</p>
          <List items={items!} />
        </div>
      ))}
    </div>
  );
}

function ExaminerBankBlock({ bank }: { bank: OsceCase["examinerBank"] }) {
  return (
    <div className="space-y-3">
      {bank.map((q) => (
        <div key={q.id} className="rounded-lg border border-neutral-800 p-3">
          <p className="text-neutral-200">
            <span className="text-neutral-500">
              {q.triggerPhase}
              {q.triggerAfterSec ? ` · after ${Math.round(q.triggerAfterSec / 60)} min` : ""} —{" "}
            </span>
            “{q.question}”
          </p>
          <p className="mt-2 text-neutral-400">
            <span className="font-medium text-neutral-500">He&apos;s listening for: </span>
            {q.modelAnswer}
          </p>
          <p className="mt-1 text-neutral-500">
            <span className="font-medium">Marked as: </span>
            {q.gradingNotes}
          </p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ClinicalBody({ c }: { c: ClinicalCase }) {
  const v = c.examination.vitals;
  const exam: Array<[string, string]> = [
    ["General", c.examination.general],
    ["Respiratory", c.examination.respiratory],
    ["Cardiovascular", c.examination.cardio],
    ["Abdominal", c.examination.abdo],
    ["Neurological", c.examination.neuro],
    ...(Object.entries(c.examination.other) as Array<[string, string]>),
  ];
  const pathophys = Object.entries(c.pathophys);
  const rubricTotal = Object.values(c.rubric).reduce((a, b) => a + b, 0);

  return (
    <>
      <Section title="Who she meets" hint="A person, not a vignette — does this patient sound like someone from your wards?">
        <p className="text-neutral-100">
          {c.patient.name} · {c.patient.age}
          {c.patient.sex} · {c.patient.occupation || "occupation not given"}
        </p>
        <p className="mt-1 text-neutral-400">{c.patient.personality}</p>
        <p className="mt-2 rounded-lg border border-neutral-800 p-3 text-neutral-300 italic">
          “{c.patient.openingLine}”
        </p>
      </Section>

      <Section title="The complaint she starts from" hint="Symptom first, diagnosis last — the framework is what the mark sheet should follow.">
        <p>{c.presentingComplaint}</p>
        <p className="mt-1 text-neutral-500">Framework: {c.framework}</p>
      </Section>

      <Section
        title={`What the patient can tell her (${c.history.length} facts)`}
        hint="The patient may say nothing beyond this. Check the story is complete — and that the trigger words cover how you would really phrase the question."
      >
        <div className="space-y-2">
          {c.history.map((fact) => (
            <div key={fact.id} className="rounded-lg border border-neutral-800 p-3">
              <p className="text-neutral-200">
                <Chip tone={fact.disclosure === "volunteered" ? "sky" : "amber"}>
                  {fact.disclosure === "volunteered" ? "says it unprompted" : "only if asked"}
                </Chip>{" "}
                {fact.fact}
              </p>
              {fact.triggers.length > 0 && (
                <p className="mt-1.5 flex flex-wrap gap-1">
                  {fact.triggers.map((t) => (
                    <Chip key={t}>{t}</Chip>
                  ))}
                </p>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="What she finds on examination" hint="Revealed only when she says she performs the step. Do the findings match the diagnosis — and each other?">
        <p className="text-neutral-400">
          HR {v.hr} · BP {v.bp} · RR {v.rr} · T {v.temp}°C · SpO₂ {v.spo2}
          {v.bmi != null ? ` · BMI ${v.bmi}` : ""}
        </p>
        <dl className="mt-2 space-y-1.5">
          {exam.map(([label, finding]) => (
            <Row key={label} label={label}>
              {finding || <span className="text-neutral-600">—</span>}
            </Row>
          ))}
        </dl>
      </Section>

      <Section title="Results, if she orders them" hint="Real values only, and the key ones must actually confirm the diagnosis.">
        <ul className="space-y-1.5">
          {c.investigations.map((ix) => (
            <li key={ix.name} className="flex flex-col gap-0.5 rounded-lg border border-neutral-800 p-2.5 sm:flex-row sm:items-baseline sm:gap-3">
              <span className="shrink-0 text-neutral-200 sm:w-56">{ix.name}</span>
              <span className="min-w-0 flex-1 text-neutral-400">{ix.result}</span>
              {ix.key && <Chip tone="sky">key</Chip>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="The differential it expects" hint="Ranked, with the reasoning attached. If the ranking is wrong for KZN, reject it.">
        <div className="space-y-2">
          {c.differentials.map((d) => (
            <div key={d.dx} className="rounded-lg border border-neutral-800 p-2.5">
              <p className="text-neutral-200">
                #{d.rank} {d.dx}
              </p>
              <p className="mt-1 text-neutral-400">
                <span className="text-emerald-500">For:</span> {d.for.length > 0 ? d.for.join("; ") : "—"}
              </p>
              <p className="text-neutral-400">
                <span className="text-red-400">Against:</span> {d.against.length > 0 ? d.against.join("; ") : "—"}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Why each symptom happens" hint="The examiner asks “walk me through the mechanism” from this map. Wrong physiology here becomes wrong physiology in the viva.">
        {pathophys.length === 0 ? (
          <p className="text-neutral-600">Nothing mapped — the examiner will have nothing to probe.</p>
        ) : (
          <dl className="space-y-1.5">
            {pathophys.map(([symptom, mechanism]) => (
              <Row key={symptom} label={symptom}>
                {mechanism}
              </Row>
            ))}
          </dl>
        )}
      </Section>

      {c.staging && (
        <Section title="Staging" hint="South African / WHO staging as it would be written in the notes.">
          <p>{c.staging}</p>
        </Section>
      )}

      <Section title="Management" hint="Must be SA practice — EML / Adult Hospital Level STGs, not a textbook from elsewhere.">
        <ManagementBlock management={c.management} />
      </Section>

      <Section
        title={`The mark sheet (${c.stationChecklist.length} items)`}
        hint="This is what you are scored against. If something here isn't findable in the case above, it's an unfair mark."
      >
        <div className="space-y-2">
          {c.stationChecklist.map((item) => (
            <div key={item.id} className="rounded-lg border border-neutral-800 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip>{item.phase}</Chip>
                <Chip tone="neutral">weight {item.weight}</Chip>
                {item.critical && <CriticalBadge />}
              </div>
              <p className="mt-1.5 text-neutral-200">{item.item}</p>
              {item.answer && (
                <p className="mt-1 text-neutral-400">
                  <span className="text-neutral-500">Answer: </span>
                  {item.answer}
                </p>
              )}
              <p className="mt-1 text-neutral-500">{item.why}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="What the examiner will ask" hint="Fair questions for a 4th year, answerable from this case alone.">
        <ExaminerBankBlock bank={c.examinerBank} />
      </Section>

      <Section title="How the 100 marks split" hint={rubricTotal === 100 ? undefined : `These add up to ${rubricTotal}, not 100 — the schema should have caught that.`}>
        <p className="flex flex-wrap gap-1.5">
          {Object.entries(c.rubric).map(([domain, weight]) => (
            <Chip key={domain} tone={rubricTotal === 100 ? "neutral" : "amber"}>
              {domain} {weight}
            </Chip>
          ))}
        </p>
      </Section>
    </>
  );
}

function InterpretationBody({ c }: { c: InterpretationCase }) {
  return (
    <>
      <Section title={`The stimulus (${c.stimulus.kind.toUpperCase()})`} hint="Read it cold, the way you would in the station.">
        <p className="text-neutral-300 italic">“{c.stimulus.vignette}”</p>
        {c.stimulus.values && (
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {Object.entries(c.stimulus.values)
              .filter(([, val]) => val != null)
              .map(([key, val]) => (
                <div key={key} className="rounded-lg border border-neutral-800 p-2 text-center">
                  <p className="text-xs text-neutral-500">{key}</p>
                  <p className="tabular-nums text-neutral-100">{String(val)}</p>
                </div>
              ))}
          </div>
        )}
        {c.stimulus.imagePath && (
          <div className="mt-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- reviewed stimuli are static files in /public with unknown intrinsic size */}
            <img
              src={c.stimulus.imagePath}
              alt={`${c.stimulus.kind.toUpperCase()} stimulus for review`}
              className="max-h-96 w-full rounded-lg border border-neutral-800 bg-black object-contain"
            />
            <p className="mt-1 text-xs text-neutral-600">{c.stimulus.imagePath}</p>
          </div>
        )}
      </Section>

      <Section title="Findings she must spot" hint="Everything marked “must not miss” has to be genuinely visible in the stimulus above.">
        <ul className="space-y-1.5">
          {c.findingsKey.map((f) => (
            <li key={f.finding} className="flex flex-wrap items-start gap-2">
              {f.critical ? <CriticalBadge /> : <Chip>minor</Chip>}
              <span className="min-w-0 flex-1">{f.finding}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="The method being marked" hint="Order matters — this is the systematic approach she has to say out loud.">
        <ol className="list-decimal space-y-1 pl-5">
          {c.interpretationChecklist.map((step) => (
            <li key={step.id}>
              {step.item} <span className="text-neutral-500">(weight {step.weight})</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="What the examiner will ask" hint="Probing questions, answerable from this stimulus.">
        <ExaminerBankBlock bank={c.examinerBank} />
      </Section>

      <Section title="What she should do next" hint="The management implications of the interpretation.">
        <ManagementBlock management={c.management} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

export function CaseHeadline({
  diagnosis,
  stationType,
  discipline,
  commonness,
  difficulty,
}: {
  diagnosis: string;
  stationType: string;
  discipline: string;
  commonness: string;
  difficulty: number;
}) {
  const tone: Tone = commonness === "uncommon" ? "amber" : "neutral";
  return (
    <>
      <h2 className="text-lg font-semibold text-neutral-100">{diagnosis}</h2>
      <p className="mt-1.5 flex flex-wrap gap-1.5">
        <Chip tone="sky">{stationType === "interpretation" ? "interpretation" : "clinical"}</Chip>
        <Chip>{systemLabel(discipline)}</Chip>
        <Chip tone={tone}>{commonness}</Chip>
        <Chip>difficulty {difficulty}/3</Chip>
      </p>
    </>
  );
}

export function CaseBody({ osceCase }: { osceCase: OsceCase }) {
  return (
    <div className={`${TILE} p-4 sm:p-5`}>
      {osceCase.stationType === "clinical" ? (
        <ClinicalBody c={osceCase} />
      ) : (
        <InterpretationBody c={osceCase} />
      )}
    </div>
  );
}
