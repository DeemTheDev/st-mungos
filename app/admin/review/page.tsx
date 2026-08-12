// /admin/review — the human review gate (CLAUDE.md §5 Stage C).
// Server component: reads cases/drafts from disk per request (the page is
// dynamic via cookies()), renders every draft human-readably, and drives
// approve/reject through plain HTML forms → POST /api/admin/review. No client
// JS, no new deps. Gated by APP_ACCESS_PASSWORD via an httpOnly cookie.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import {
  OsceCaseSchema,
  type ClinicalCase,
  type InterpretationCase,
  type OsceCase,
} from "@/lib/case-schema";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";

export const metadata = { title: "St Mungo's — Draft review" };

const DRAFTS_DIR = join(process.cwd(), "cases", "drafts");

type DraftEntry =
  | { file: string; id: string; status: "valid"; osceCase: OsceCase }
  | { file: string; id: string; status: "invalid"; errors: string[] };

function loadDrafts(): DraftEntry[] {
  if (!existsSync(DRAFTS_DIR)) return [];
  return readdirSync(DRAFTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file): DraftEntry => {
      const id = file.replace(/\.json$/, "");
      try {
        const parsed = OsceCaseSchema.safeParse(JSON.parse(readFileSync(join(DRAFTS_DIR, file), "utf8")));
        if (parsed.success) return { file, id, status: "valid", osceCase: parsed.data };
        return {
          file,
          id,
          status: "invalid",
          errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        };
      } catch (err) {
        return { file, id, status: "invalid", errors: [err instanceof Error ? err.message : String(err)] };
      }
    });
}

// ---------------------------------------------------------------------------
// small presentational helpers

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">{title}</h3>
      <div className="mt-2 text-sm text-neutral-300">{children}</div>
    </section>
  );
}

function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "amber" | "sky" }) {
  const tones = {
    neutral: "bg-neutral-800 text-neutral-300",
    amber: "bg-amber-950 text-amber-300",
    sky: "bg-sky-950 text-sky-300",
  } as const;
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${tones[tone]}`}>{children}</span>;
}

function CriticalBadge() {
  return <span className="rounded bg-red-950 px-1.5 py-0.5 text-xs font-semibold text-red-300">critical</span>;
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

function ActionButtons({ id }: { id: string }) {
  return (
    <div className="flex gap-2">
      <form action="/api/admin/review" method="post">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="action" value="approve" />
        <button
          type="submit"
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-emerald-50 hover:bg-emerald-600"
        >
          Approve → bank
        </button>
      </form>
      <form action="/api/admin/review" method="post">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="action" value="reject" />
        <button
          type="submit"
          className="rounded bg-red-900 px-3 py-1.5 text-sm font-medium text-red-100 hover:bg-red-800"
        >
          Reject (delete)
        </button>
      </form>
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
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {groups
        .filter(([, items]) => items && items.length > 0)
        .map(([label, items]) => (
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
        <div key={q.id} className="rounded border border-neutral-800 p-3">
          <p className="text-neutral-200">
            <span className="text-neutral-500">{q.id} · {q.triggerPhase}
              {q.triggerAfterSec ? ` @ ${q.triggerAfterSec}s` : ""} — </span>
            “{q.question}”
          </p>
          <p className="mt-2 text-neutral-400">
            <span className="font-medium text-neutral-500">Model answer: </span>
            {q.modelAnswer}
          </p>
          <p className="mt-1 text-neutral-500">
            <span className="font-medium">Grading: </span>
            {q.gradingNotes}
          </p>
        </div>
      ))}
    </div>
  );
}

function ChecklistBlock({ checklist }: { checklist: ClinicalCase["stationChecklist"] }) {
  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr className="border-b border-neutral-800 text-xs uppercase tracking-wider text-neutral-500">
          <th className="py-1.5 pr-3">Phase</th>
          <th className="py-1.5 pr-3">Item</th>
          <th className="py-1.5 pr-3">Answer</th>
          <th className="py-1.5 pr-3">Why it matters</th>
          <th className="py-1.5 pr-3">Wt</th>
          <th className="py-1.5" />
        </tr>
      </thead>
      <tbody>
        {checklist.map((item) => (
          <tr key={item.id} className="border-b border-neutral-900 align-top">
            <td className="py-2 pr-3 text-neutral-500">{item.phase}</td>
            <td className="py-2 pr-3 text-neutral-200">{item.item}</td>
            <td className="py-2 pr-3">{item.answer ?? <span className="text-neutral-600">—</span>}</td>
            <td className="py-2 pr-3 text-neutral-400">{item.why}</td>
            <td className="py-2 pr-3">{item.weight}</td>
            <td className="py-2">{item.critical && <CriticalBadge />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// clinical draft body

function ClinicalBody({ c }: { c: ClinicalCase }) {
  const v = c.examination.vitals;
  return (
    <>
      <Section title="Patient">
        <p className="text-neutral-200">
          {c.patient.name}, {c.patient.age}{c.patient.sex} · {c.patient.occupation}
        </p>
        <p className="mt-1 text-neutral-400">Personality: {c.patient.personality}</p>
        <p className="mt-1 italic text-neutral-400">Opens with: “{c.patient.openingLine}”</p>
      </Section>

      <Section title="Presenting complaint">
        <p>{c.presentingComplaint}</p>
        <p className="mt-1 text-neutral-500">Framework: {c.framework}</p>
      </Section>

      <Section title={`History (${c.history.length} facts)`}>
        <div className="space-y-2">
          {c.history.map((fact) => (
            <div key={fact.id} className="rounded border border-neutral-800 p-2.5">
              <p className="text-neutral-200">
                <Chip tone={fact.disclosure === "volunteered" ? "sky" : "amber"}>{fact.disclosure}</Chip>{" "}
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

      <Section title="Examination">
        <p className="text-neutral-400">
          Vitals: HR {v.hr} · BP {v.bp} · RR {v.rr} · T° {v.temp} · SpO2 {v.spo2}
          {v.bmi != null ? ` · BMI ${v.bmi}` : ""}
        </p>
        <dl className="mt-2 space-y-1">
          {(
            [
              ["General", c.examination.general],
              ["Respiratory", c.examination.respiratory],
              ["Cardiovascular", c.examination.cardio],
              ["Abdominal", c.examination.abdo],
              ["Neurological", c.examination.neuro],
              ...Object.entries(c.examination.other),
            ] as Array<[string, string]>
          ).map(([label, finding]) => (
            <div key={label} className="flex gap-2">
              <dt className="w-32 shrink-0 text-neutral-500">{label}</dt>
              <dd>{finding}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Investigations (revealed only when requested)">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-neutral-800 text-xs uppercase tracking-wider text-neutral-500">
              <th className="py-1.5 pr-3">Test</th>
              <th className="py-1.5 pr-3">Result</th>
              <th className="py-1.5">Key</th>
            </tr>
          </thead>
          <tbody>
            {c.investigations.map((ix) => (
              <tr key={ix.name} className="border-b border-neutral-900 align-top">
                <td className="py-2 pr-3 text-neutral-200">{ix.name}</td>
                <td className="py-2 pr-3 text-neutral-400">{ix.result}</td>
                <td className="py-2">{ix.key && <Chip tone="sky">key</Chip>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Differentials">
        <div className="space-y-2">
          {c.differentials.map((d) => (
            <div key={d.dx} className="rounded border border-neutral-800 p-2.5">
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

      <Section title="Station checklist (the mark sheet)">
        <ChecklistBlock checklist={c.stationChecklist} />
      </Section>

      <Section title="Examiner bank">
        <ExaminerBankBlock bank={c.examinerBank} />
      </Section>

      <Section title="Pathophysiology map">
        <dl className="space-y-1">
          {Object.entries(c.pathophys).map(([symptom, mechanism]) => (
            <div key={symptom} className="flex gap-2">
              <dt className="w-40 shrink-0 text-neutral-500">{symptom}</dt>
              <dd>{mechanism}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {c.staging && (
        <Section title="Staging">
          <p>{c.staging}</p>
        </Section>
      )}

      <Section title="Management">
        <ManagementBlock management={c.management} />
      </Section>

      <Section title="Rubric (domain weights /100)">
        <p className="flex flex-wrap gap-1.5">
          {Object.entries(c.rubric).map(([domain, weight]) => (
            <Chip key={domain}>
              {domain} {weight}
            </Chip>
          ))}
        </p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// interpretation draft body

function InterpretationBody({ c }: { c: InterpretationCase }) {
  return (
    <>
      <Section title={`Stimulus (${c.stimulus.kind.toUpperCase()})`}>
        <p className="italic text-neutral-300">“{c.stimulus.vignette}”</p>
        {c.stimulus.values && (
          <div className="mt-3 grid max-w-xl grid-cols-3 gap-2 sm:grid-cols-5">
            {Object.entries(c.stimulus.values)
              .filter(([, val]) => val != null)
              .map(([key, val]) => (
                <div key={key} className="rounded border border-neutral-800 p-2 text-center">
                  <p className="text-xs text-neutral-500">{key}</p>
                  <p className="text-neutral-100">{val}</p>
                </div>
              ))}
          </div>
        )}
        {c.stimulus.imagePath && <p className="mt-2 text-neutral-400">Image: {c.stimulus.imagePath}</p>}
      </Section>

      <Section title="Findings key">
        <ul className="space-y-1.5">
          {c.findingsKey.map((f) => (
            <li key={f.finding} className="flex items-start gap-2">
              {f.critical ? <CriticalBadge /> : <Chip>minor</Chip>}
              <span>{f.finding}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Interpretation checklist (stepwise method)">
        <ol className="list-decimal space-y-1 pl-5">
          {c.interpretationChecklist.map((step) => (
            <li key={step.id}>
              {step.item} <span className="text-neutral-500">(weight {step.weight})</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Examiner bank">
        <ExaminerBankBlock bank={c.examinerBank} />
      </Section>

      <Section title="Management">
        <ManagementBlock management={c.management} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// page shell

function DraftCard({ entry }: { entry: DraftEntry }) {
  if (entry.status === "invalid") {
    return (
      <article className="rounded-lg border border-red-950 bg-neutral-900 p-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-red-300">{entry.file}</h2>
            <p className="mt-1 text-sm text-neutral-400">Fails schema validation — fix the file or reject it.</p>
          </div>
          <form action="/api/admin/review" method="post">
            <input type="hidden" name="id" value={entry.id} />
            <input type="hidden" name="action" value="reject" />
            <button
              type="submit"
              className="rounded bg-red-900 px-3 py-1.5 text-sm font-medium text-red-100 hover:bg-red-800"
            >
              Reject (delete)
            </button>
          </form>
        </header>
        <ul className="mt-3 list-disc pl-5 text-sm text-red-400">
          {entry.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </article>
    );
  }

  const c = entry.osceCase;
  return (
    <article className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-neutral-100">{c.diagnosis}</h2>
          <p className="mt-1 flex flex-wrap gap-1.5 text-sm">
            <Chip tone="sky">{c.stationType}</Chip>
            <Chip>{c.discipline}</Chip>
            <Chip tone={c.commonness === "uncommon" ? "amber" : "neutral"}>{c.commonness}</Chip>
            <Chip>difficulty {c.difficulty}</Chip>
            <Chip>{c.id}</Chip>
          </p>
        </div>
        <ActionButtons id={entry.id} />
      </header>
      {c.stationType === "clinical" ? <ClinicalBody c={c} /> : <InterpretationBody c={c} />}
    </article>
  );
}

function LoginGate({ showError, passwordConfigured }: { showError: boolean; passwordConfigured: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-neutral-200">
      <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">St Mungo&apos;s — draft review</h1>
        <p className="mt-1 text-sm text-neutral-400">Enter the access password to review case drafts.</p>
        {!passwordConfigured && (
          <p className="mt-3 rounded bg-amber-950 p-2 text-sm text-amber-300">
            APP_ACCESS_PASSWORD is not set on the server — logging in is impossible until it is configured.
          </p>
        )}
        {showError && <p className="mt-3 rounded bg-red-950 p-2 text-sm text-red-300">Wrong password — try again.</p>}
        <form action="/api/admin/login" method="post" className="mt-4 flex gap-2">
          <input
            type="password"
            name="password"
            required
            autoFocus
            placeholder="Password"
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
          >
            Enter
          </button>
        </form>
      </div>
    </main>
  );
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const store = await cookies();
  const params = await searchParams;

  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return <LoginGate showError={params.error === "1"} passwordConfigured={Boolean(process.env.APP_ACCESS_PASSWORD)} />;
  }

  const drafts = loadDrafts();
  const actionError = typeof params.actionError === "string" ? params.actionError : null;

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-200">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-neutral-100">Draft review</h1>
          <p className="mt-1 text-sm text-neutral-400">
            {drafts.length === 0
              ? "No drafts awaiting review."
              : `${drafts.length} draft${drafts.length === 1 ? "" : "s"} awaiting review — approve moves a case to the bank, reject deletes it. Nothing reaches the student unreviewed.`}
          </p>
          {actionError && (
            <p className="mt-3 rounded bg-red-950 p-2 text-sm text-red-300">Last action failed: {actionError}</p>
          )}
        </header>
        <div className="space-y-6">
          {drafts.map((entry) => (
            <DraftCard key={entry.file} entry={entry} />
          ))}
        </div>
        {drafts.length === 0 && (
          <p className="text-sm text-neutral-500">
            Generate some with <code className="rounded bg-neutral-900 px-1.5 py-0.5">pnpm gen:cases --system resp --count 5</code> or{" "}
            <code className="rounded bg-neutral-900 px-1.5 py-0.5">pnpm gen:interp --kind abg --count 3</code>.
          </p>
        )}
      </div>
    </main>
  );
}
