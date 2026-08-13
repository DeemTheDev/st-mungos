// /session — the new-exam flow (CLAUDE.md §8): random station (80/20
// common/uncommon) or a specific bank case, plus resume for saved sessions.
// Server component, plain HTML forms, gated by the same admin cookie as
// /admin/review. Text mode is the Phase 2 deliverable and permanent fallback.
import { cookies } from "next/headers";
import Link from "next/link";
import { ADMIN_COOKIE, isAdminToken } from "@/lib/admin-auth";
import type { CaseSummary, SessionSummary } from "@/lib/ports";
import { getCaseStore, getSessionStore } from "@/lib/stores";

export const metadata = { title: "St Mungo's — New station" };

function LoginGate({ passwordConfigured }: { passwordConfigured: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-neutral-200">
      <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">St Mungo&apos;s</h1>
        <p className="mt-1 text-sm text-neutral-400">Enter the access password to practise a station.</p>
        {!passwordConfigured && (
          <p className="mt-3 rounded bg-amber-950 p-2 text-sm text-amber-300">
            APP_ACCESS_PASSWORD is not set on the server — logging in is impossible until it is configured.
          </p>
        )}
        <form action="/api/admin/login" method="post" className="mt-4 flex gap-2">
          <input type="hidden" name="next" value="/session" />
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

function RandomButton({ label, stationType }: { label: string; stationType?: string }) {
  return (
    <form action="/api/session" method="post">
      <input type="hidden" name="random" value="1" />
      {stationType && <input type="hidden" name="stationType" value={stationType} />}
      <button
        type="submit"
        className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-emerald-50 hover:bg-emerald-600"
      >
        {label}
      </button>
    </form>
  );
}

function CaseRow({ c }: { c: CaseSummary }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-800 p-3">
      <div>
        <p className="text-sm text-neutral-200">{c.diagnosis}</p>
        <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-neutral-500">
          <span className="rounded bg-neutral-800 px-1.5 py-0.5">{c.stationType}</span>
          <span className="rounded bg-neutral-800 px-1.5 py-0.5">{c.discipline}</span>
          <span className={`rounded px-1.5 py-0.5 ${c.commonness === "uncommon" ? "bg-amber-950 text-amber-300" : "bg-neutral-800"}`}>
            {c.commonness}
          </span>
          <span className="rounded bg-neutral-800 px-1.5 py-0.5">difficulty {c.difficulty}</span>
        </p>
      </div>
      <form action="/api/session" method="post">
        <input type="hidden" name="caseId" value={c.id} />
        <button
          type="submit"
          className="rounded bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
        >
          Start
        </button>
      </form>
    </div>
  );
}

function SessionRow({ s }: { s: SessionSummary }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-800 p-3">
      <div className="text-sm">
        <p className="text-neutral-300">
          {new Date(s.startedAt).toLocaleString()} · {s.stationType}
          {s.band && <span className="ml-2 rounded bg-sky-950 px-1.5 py-0.5 text-xs text-sky-300">{s.band}</span>}
        </p>
        <p className="mt-0.5 text-xs text-neutral-500">{s.status}</p>
      </div>
      <Link
        href={`/session/${s.id}`}
        className="rounded bg-neutral-800 px-3 py-1.5 text-sm font-medium text-neutral-200 hover:bg-neutral-700"
      >
        {s.status === "active" ? "Resume" : "View report"}
      </Link>
    </div>
  );
}

export default async function SessionPickerPage() {
  const store = await cookies();
  if (!isAdminToken(store.get(ADMIN_COOKIE)?.value)) {
    return <LoginGate passwordConfigured={Boolean(process.env.APP_ACCESS_PASSWORD)} />;
  }

  // A store hiccup must never 500 the picker — degrade to empty lists + banner.
  const [casesRes, sessionsRes] = await Promise.allSettled([getCaseStore().list(), getSessionStore().list()]);
  const cases = casesRes.status === "fulfilled" ? casesRes.value : [];
  const sessions = sessionsRes.status === "fulfilled" ? sessionsRes.value : [];
  const storeError = [casesRes, sessionsRes]
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
    .join("; ");
  const resumable = sessions.filter((s) => s.status === "active");
  const finished = sessions.filter((s) => s.status !== "active").slice(0, 10);

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-200">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-neutral-100">New station</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Text-mode OSCE practice. 20 minutes clinical, 7 minutes interpretation — the examiner keeps time.
          </p>
        </header>

        {storeError && (
          <p className="mb-6 rounded bg-amber-950 p-3 text-sm text-amber-300">
            Storage warning: {storeError} — sessions may not be listed. Check STORE / SUPABASE_* env vars.
          </p>
        )}

        <section className="mb-8 flex flex-wrap gap-2">
          <RandomButton label="Random station" />
          <RandomButton label="Random clinical" stationType="clinical" />
          <RandomButton label="Random interpretation" stationType="interpretation" />
        </section>

        {resumable.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
              Saved sessions — resume where you left off
            </h2>
            <div className="space-y-2">
              {resumable.map((s) => (
                <SessionRow key={s.id} s={s} />
              ))}
            </div>
          </section>
        )}

        <section className="mb-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Pick a case ({cases.length} in the bank)
          </h2>
          {cases.length === 0 ? (
            <p className="text-sm text-neutral-500">
              The bank is empty — approve some drafts at{" "}
              <Link href="/admin/review" className="underline">
                /admin/review
              </Link>
              .
            </p>
          ) : (
            <div className="space-y-2">
              {cases.map((c) => (
                <CaseRow key={c.id} c={c} />
              ))}
            </div>
          )}
        </section>

        {finished.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">Past sessions</h2>
            <div className="space-y-2">
              {finished.map((s) => (
                <SessionRow key={s.id} s={s} />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
