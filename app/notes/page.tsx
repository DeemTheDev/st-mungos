// /notes — the §8 "Notes popup" as a page: every completed session in one list,
// with the aggregate that makes it a study tool rather than an archive — the
// checklist items she keeps missing, counted across every station she has taken.
// Server component, same admin-cookie gate as /session and /admin/review.
import { cookies } from "next/headers";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";
import type { Band } from "@/lib/marking-schema";
import { loadNotes, type MissedItem, type NotesEntry } from "@/lib/notes";

export const metadata = { title: "St Mungo's — Study notes" };

const BAND_ORDER: Band[] = ["distinction", "pass", "borderline", "fail"];

const BAND_TONE: Record<Band, string> = {
  distinction: "bg-emerald-950 text-emerald-300",
  pass: "bg-emerald-950 text-emerald-300",
  borderline: "bg-amber-950 text-amber-300",
  fail: "bg-red-950 text-red-300",
};

function LoginGate({ passwordConfigured }: { passwordConfigured: boolean }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 text-neutral-200">
      <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">St Mungo&apos;s — study notes</h1>
        <p className="mt-1 text-sm text-neutral-400">Enter the access password to read your past reports.</p>
        {!passwordConfigured && (
          <p className="mt-3 rounded bg-amber-950 p-2 text-sm text-amber-300">
            APP_ACCESS_PASSWORD is not set on the server — logging in is impossible until it is configured.
          </p>
        )}
        <form action="/api/admin/login" method="post" className="mt-4 flex gap-2">
          <input type="hidden" name="next" value="/notes" />
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

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-neutral-800 p-4">
      <p className="text-xs font-semibold tracking-widest text-neutral-500 uppercase">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-neutral-100">{value}</p>
      {hint && <p className="mt-1 text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

function MissRow({ item, tone }: { item: MissedItem; tone: "amber" | "neutral" }) {
  return (
    <li
      className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded border p-3 ${
        tone === "amber" ? "border-amber-900/60 bg-amber-950/20" : "border-neutral-800"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className={tone === "amber" ? "text-sm text-amber-200" : "text-sm text-neutral-200"}>{item.item}</p>
        <p className="mt-1 text-xs text-neutral-500">
          {item.phase}
          {item.critical && <span className="ml-2 rounded bg-red-950 px-1.5 py-0.5 text-red-300">critical</span>}
        </p>
      </div>
      <p className="shrink-0 text-xs text-neutral-400">
        <span className={tone === "amber" ? "text-amber-300" : "text-neutral-200"}>
          {item.missed} missed
        </span>
        {item.partial > 0 && <span> · {item.partial} partial</span>}
        <span className="text-neutral-600">
          {" "}
          · seen in {item.seen} station{item.seen === 1 ? "" : "s"}
        </span>
      </p>
    </li>
  );
}

function SessionRow({ e }: { e: NotesEntry }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-800 p-3">
      <div className="min-w-0">
        <p className="text-sm text-neutral-200">{e.diagnosis}</p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
          <span>{new Date(e.startedAt).toLocaleString()}</span>
          {e.discipline && <span className="rounded bg-neutral-800 px-1.5 py-0.5">{e.discipline}</span>}
          <span className="rounded bg-neutral-800 px-1.5 py-0.5">{e.stationType}</span>
          {e.mode === "management" && (
            <span className="rounded bg-amber-950 px-1.5 py-0.5 text-amber-300">management focus</span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <p className="text-sm text-neutral-300">
          {Math.round(e.globalScore)}
          <span className="text-neutral-600">/100</span>
          <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${BAND_TONE[e.band]}`}>{e.band}</span>
        </p>
        <Link
          href={`/session/${e.id}`}
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm font-medium text-neutral-200 hover:bg-neutral-700"
        >
          View report
        </Link>
      </div>
    </div>
  );
}

export default async function NotesPage() {
  const store = await cookies();
  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return <LoginGate passwordConfigured={Boolean(process.env.APP_ACCESS_PASSWORD)} />;
  }

  const { entries, aggregate, storeError } = await loadNotes();

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200">
      <SiteNav active="notes" />
      <main className="px-4 py-8">
        <div className="mx-auto max-w-4xl">
          <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-neutral-100">Study notes</h1>
              <p className="mt-1 text-sm text-neutral-400">
                Every marked station, and the checklist items you keep dropping.
              </p>
            </div>
            {entries.length > 0 && (
              <Link
                href="/notes/print"
                className="rounded border border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-200 hover:border-neutral-500 hover:bg-neutral-900"
              >
                All reports → PDF
              </Link>
            )}
          </header>

          {storeError && (
            <p className="mb-6 rounded bg-amber-950 p-3 text-sm text-amber-300">
              Storage warning: {storeError} — some sessions may be missing. Check STORE / SUPABASE_* env vars.
            </p>
          )}

          {entries.length === 0 ? (
            <div className="rounded border border-neutral-800 p-8 text-center">
              <p className="text-sm text-neutral-300">No marked stations yet.</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
                Take a station and end it for marking — the report lands here, and after a few of them this
                page starts telling you what you keep forgetting.
              </p>
              <Link
                href="/session"
                className="mt-5 inline-block rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-600"
              >
                Start a station
              </Link>
            </div>
          ) : (
            <>
              <section className="mb-8 grid gap-3 sm:grid-cols-3">
                <StatTile
                  label="Stations marked"
                  value={String(aggregate.fullStations)}
                  hint={
                    aggregate.managementVivas > 0
                      ? `+ ${aggregate.managementVivas} management viva${aggregate.managementVivas === 1 ? "" : "s"}`
                      : undefined
                  }
                />
                <StatTile
                  label="Mean score"
                  value={aggregate.meanScore == null ? "—" : `${Math.round(aggregate.meanScore)}/100`}
                  hint="full stations only"
                />
                <div className="rounded border border-neutral-800 p-4">
                  <p className="text-xs font-semibold tracking-widest text-neutral-500 uppercase">Bands</p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {BAND_ORDER.map((band) => (
                      <li key={band} className="flex items-center justify-between">
                        <span className="text-neutral-400 capitalize">{band}</span>
                        <span className={`rounded px-1.5 py-0.5 text-xs ${BAND_TONE[band]}`}>
                          {aggregate.bands[band]}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>

              {aggregate.criticalMissed.length > 0 && (
                <section className="mb-8">
                  <h2 className="mb-2 text-xs font-semibold tracking-widest text-amber-500 uppercase">
                    Critical items you have missed
                  </h2>
                  <p className="mb-3 text-sm text-neutral-500">
                    Missing any of these is an automatic examiner concern. Fix these first.
                  </p>
                  <ul className="space-y-2">
                    {aggregate.criticalMissed.map((item) => (
                      <MissRow key={item.key} item={item} tone="amber" />
                    ))}
                  </ul>
                </section>
              )}

              {aggregate.mostMissed.length > 0 && (
                <section className="mb-8">
                  <h2 className="mb-2 text-xs font-semibold tracking-widest text-neutral-500 uppercase">
                    Most-missed checklist items
                  </h2>
                  <ul className="space-y-2">
                    {aggregate.mostMissed.map((item) => (
                      <MissRow key={item.key} item={item} tone="neutral" />
                    ))}
                  </ul>
                </section>
              )}

              <section>
                <h2 className="mb-2 text-xs font-semibold tracking-widest text-neutral-500 uppercase">
                  Every marked session ({entries.length})
                </h2>
                <div className="space-y-2">
                  {entries.map((e) => (
                    <SessionRow key={e.id} e={e} />
                  ))}
                </div>
                {aggregate.managementVivas > 0 && (
                  <p className="mt-3 text-xs text-neutral-600">
                    Management-focus vivas are listed but excluded from the aggregates above — they are
                    marked against the whole station checklist, so their scores and their missed history
                    rows are not comparable to a full station.
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
