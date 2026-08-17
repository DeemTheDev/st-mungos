// The same no-JS cookie gate as /session and /notes (lib/admin-auth.ts), shared
// across the three flashcards pages so the copy lives in one place. Server
// component — plain HTML form POST to /api/admin/login with a same-site `next`.

export function FlashcardsLoginGate({
  next,
  blurb,
  passwordConfigured,
}: {
  next: string;
  blurb: string;
  passwordConfigured: boolean;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 text-neutral-200">
      <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">St Mungo&apos;s — flashcards</h1>
        <p className="mt-1 text-sm text-neutral-400">{blurb}</p>
        {!passwordConfigured && (
          <p className="mt-3 rounded bg-amber-950 p-2 text-sm text-amber-300">
            APP_ACCESS_PASSWORD is not set on the server — logging in is impossible until it is configured.
          </p>
        )}
        <form action="/api/admin/login" method="post" className="mt-4 flex gap-2">
          <input type="hidden" name="next" value={next} />
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
