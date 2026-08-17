// The front door. Keeps the St Mungo's identity + the §1 disclaimer, but the
// point of the page is now the primary actions — landing here used to dead-end
// with no way through to /session or the review queue. Server component, zero JS.
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";

const EXPLAINERS: Array<[string, string]> = [
  ["Station practice", "Interview and examine a virtual patient in a timed OSCE station."],
  ["Examiner viva", "A UKZN-style examiner interrupts to probe your reasoning, mid-station."],
  ["Marked report", "Scored against the real station checklist, with the model answers to study from."],
  ["Flashcards", "Upload a Q&A document — extracted cards come back on a spaced-repetition schedule."],
  ["Your library", "Drop in a study guide. It becomes knowledge-base topics, and those become stations."],
  ["Your say-so", "Every generated case waits in review until you decide it holds up clinically."],
];

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col bg-neutral-950 text-neutral-100">
      <SiteNav active="home" />

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center px-4 py-12">
        <p className="text-xs font-semibold tracking-[0.3em] text-neutral-500 uppercase">St Mungo&apos;s</p>
        <h1 className="mt-3 max-w-2xl font-serif text-3xl text-neutral-100 sm:text-4xl">
          Hospital for Magical Maladies <span className="text-emerald-400">&amp;</span> OSCE Injuries
        </h1>
        <p className="mt-4 max-w-xl text-sm text-neutral-400">
          Timed internal-medicine OSCE practice, grounded in KwaZulu-Natal epidemiology and South
          African guidelines. Symptom first, diagnosis last — the way the station actually runs.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/session"
            className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 transition-colors hover:bg-emerald-600"
          >
            Start a station
          </Link>
          <Link
            href="/flashcards"
            className="rounded border border-emerald-900 px-4 py-2 text-sm font-medium text-emerald-300 transition-colors hover:border-emerald-700 hover:bg-emerald-950/40"
          >
            Flashcards
          </Link>
          <Link
            href="/library"
            className="rounded border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-900"
          >
            Add study guides
          </Link>
          <Link
            href="/review"
            className="rounded border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-900"
          >
            Case review
          </Link>
          <Link href="/notes" className="text-sm text-neutral-500 underline-offset-4 transition-colors hover:text-neutral-300 hover:underline">
            Past sessions &amp; notes
          </Link>
        </div>

        {/* The pipeline in one line: it is not obvious that the bank is something
            she builds, so the front door says it out loud. */}
        <p className="mt-6 max-w-xl text-sm text-neutral-500">
          The station bank is yours to grow:{" "}
          <Link href="/library" className="text-neutral-300 underline underline-offset-4 hover:text-neutral-100">
            upload a study guide
          </Link>
          , generate cases from what it learns, then{" "}
          <Link href="/review" className="text-neutral-300 underline underline-offset-4 hover:text-neutral-100">
            approve the ones that hold up
          </Link>
          . Nothing is playable until you say so.
        </p>

        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {EXPLAINERS.map(([title, body]) => (
            <li key={title} className="rounded border border-neutral-800 p-4">
              <p className="text-xs font-semibold tracking-widest text-neutral-500 uppercase">{title}</p>
              <p className="mt-2 text-sm text-neutral-400">{body}</p>
            </li>
          ))}
        </ul>
      </main>

      <footer className="border-t border-neutral-900 px-4 py-4 text-center text-xs text-neutral-600">
        A study tool, not medical advice. Practice here — verify with your guidelines.
      </footer>
    </div>
  );
}
