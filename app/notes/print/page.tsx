// /notes/print — every completed report stacked in one printable sheet
// (§8: "Download PDF per session and combined"). The combined export is the
// browser's print-to-PDF driven by the @media print block below.
//
// The print rules are duplicated here rather than shared with the station page:
// app/session/[id]/station-client.tsx owns its own copy and pulling it into a
// shared stylesheet would mean editing that file.
import { cookies } from "next/headers";
import Link from "next/link";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";
import type { MarkingReport } from "@/lib/marking-schema";
import { loadNotes, type NotesEntry } from "@/lib/notes";
import { PrintButton } from "./print-button";

export const metadata = { title: "St Mungo's — All reports" };

const PRINT_CSS = `
@page { margin: 14mm; }
@media print {
  html, body { background: #fff !important; }
  .no-print { display: none !important; }
  .print-sheet, .print-sheet * {
    color: #111 !important;
    background: transparent !important;
    border-color: #c8c8c8 !important;
  }
  .print-sheet { background: #fff !important; }
  /* Keep a report whole where it fits, and always start a new one on a fresh page. */
  .print-report { page-break-inside: avoid; break-inside: avoid; }
  .print-report + .print-report { page-break-before: always; break-before: page; }
  /* Sub-blocks (a table, a narrative section) must never split mid-thought. */
  .print-block { page-break-inside: avoid; break-inside: avoid; }
  a { text-decoration: none !important; }
}
`;

function statusTone(status: string): string {
  if (status === "done") return "bg-emerald-950 text-emerald-300";
  if (status === "partial") return "bg-amber-950 text-amber-300";
  return "bg-red-950 text-red-300";
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="print-block mt-5">
      <h3 className="text-xs font-semibold tracking-widest text-neutral-500 uppercase">{title}</h3>
      <div className="mt-2 text-sm text-neutral-300">{children}</div>
    </section>
  );
}

function ReportBody({ report }: { report: MarkingReport }) {
  return (
    <>
      {report.criticalFlags.length > 0 && (
        <Block title="Critical items missed">
          <ul className="space-y-1.5">
            {report.criticalFlags.map((flag) => (
              <li key={flag.checklistId} className="rounded border border-amber-900/60 p-2.5 text-amber-200">
                {flag.message}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {report.domainScores && (
        <Block title="Domain scores">
          <ul className="flex flex-wrap gap-1.5">
            {Object.entries(report.domainScores).map(([domain, value]) => (
              <li key={domain} className="rounded bg-neutral-800 px-2 py-1 text-xs">
                {domain} {Math.round(value)}
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block title="Checklist coverage">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-neutral-800 text-xs tracking-wider text-neutral-500 uppercase">
              <th className="py-1.5 pr-3">Item</th>
              <th className="py-1.5 pr-3">Status</th>
              <th className="py-1.5">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {report.checklist.map((row) => (
              <tr key={row.id} className="border-b border-neutral-900 align-top">
                <td className="py-2 pr-3 text-neutral-200">
                  {row.item}
                  <span className="ml-2 text-xs text-neutral-500">{row.phase}</span>
                  {row.critical && (
                    <span className="ml-2 rounded bg-red-950 px-1.5 py-0.5 text-xs text-red-300">critical</span>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${statusTone(row.status)}`}>{row.status}</span>
                </td>
                <td className="py-2 text-neutral-400">
                  {row.evidence ? `“${row.evidence}”` : <span className="text-neutral-600">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>

      {report.findings && report.findings.length > 0 && (
        <Block title="Findings">
          <ul className="space-y-1">
            {report.findings.map((f) => (
              <li key={f.finding}>
                <span className={f.identified ? "text-emerald-400" : "text-red-400"}>
                  {f.identified ? "✓" : "✗"}
                </span>{" "}
                {f.finding}
                {f.critical && <span className="ml-2 text-xs text-red-400">critical</span>}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {report.viva.length > 0 && (
        <Block title="Viva">
          <ul className="space-y-2">
            {report.viva.map((v) => (
              <li key={v.questionId} className="rounded border border-neutral-800 p-2.5">
                <p className="text-neutral-200">“{v.question}”</p>
                <p className="mt-1 text-neutral-400">
                  <span className="text-neutral-500">{v.grade}/2 — </span>
                  {v.comment}
                </p>
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block title="Strengths">
        <ul className="list-disc space-y-1 pl-5">
          {report.narrative.strengths.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </Block>

      <Block title="Priority improvements">
        <ul className="list-disc space-y-1 pl-5">
          {report.narrative.improvements.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </Block>

      <Block title="What the complete station looked like">
        <p className="whitespace-pre-line text-neutral-300">{report.narrative.modelStation}</p>
      </Block>
    </>
  );
}

function ReportSheet({ e }: { e: NotesEntry }) {
  return (
    <article className="print-report rounded-lg border border-neutral-800 p-5">
      <header className="print-block flex flex-wrap items-baseline justify-between gap-3 border-b border-neutral-800 pb-3">
        <div>
          <h2 className="text-lg font-semibold text-neutral-100">{e.diagnosis}</h2>
          <p className="mt-1 text-xs text-neutral-500">
            {new Date(e.startedAt).toLocaleString()}
            {e.discipline ? ` · ${e.discipline}` : ""} · {e.stationType}
            {e.mode === "management" ? " · management focus" : ""} · {e.caseId}
          </p>
        </div>
        <p className="text-xl font-semibold text-neutral-100">
          {Math.round(e.globalScore)}/100 <span className="text-sm text-neutral-400">{e.band}</span>
        </p>
      </header>
      <ReportBody report={e.state.report!} />
    </article>
  );
}

export default async function NotesPrintPage() {
  const store = await cookies();
  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 text-neutral-200">
        <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <h1 className="text-lg font-semibold text-neutral-100">St Mungo&apos;s — all reports</h1>
          <p className="mt-1 text-sm text-neutral-400">Enter the access password to print your reports.</p>
          <form action="/api/admin/login" method="post" className="mt-4 flex gap-2">
            <input type="hidden" name="next" value="/notes/print" />
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

  const { entries, storeError } = await loadNotes();

  return (
    <div className="print-sheet min-h-screen bg-neutral-950 text-neutral-200">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="no-print border-b border-neutral-800 px-4 py-3">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-neutral-200">
              {entries.length} report{entries.length === 1 ? "" : "s"} — one per page
            </p>
            <p className="text-xs text-neutral-500">
              Print, then choose “Save as PDF” as the destination.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/notes" className="text-sm text-neutral-400 underline-offset-4 hover:text-neutral-200 hover:underline">
              Back to notes
            </Link>
            {entries.length > 0 && <PrintButton />}
          </div>
        </div>
      </div>

      <main className="px-4 py-8">
        <div className="mx-auto max-w-4xl">
          <header className="print-block mb-6">
            <h1 className="font-serif text-2xl text-neutral-100">St Mungo&apos;s — station reports</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Generated {new Date().toLocaleDateString()}. A study tool, not medical advice.
            </p>
          </header>

          {storeError && (
            <p className="no-print mb-6 rounded bg-amber-950 p-3 text-sm text-amber-300">
              Storage warning: {storeError} — some reports may be missing.
            </p>
          )}

          {entries.length === 0 ? (
            <p className="text-sm text-neutral-500">
              Nothing to print yet — take a station and end it for marking first.
            </p>
          ) : (
            <div className="space-y-6">
              {entries.map((e) => (
                <ReportSheet key={e.id} e={e} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
