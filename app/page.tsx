export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-neutral-950 px-6 text-neutral-100">
      <p className="text-sm tracking-[0.3em] text-neutral-500 uppercase">
        St Mungo&apos;s
      </p>
      <h1 className="mt-3 max-w-xl text-center font-serif text-3xl text-neutral-100 sm:text-4xl">
        Hospital for Magical Maladies <span className="text-emerald-400">&amp;</span> OSCE Injuries
      </h1>
      <p className="mt-4 max-w-md text-center text-sm text-neutral-400">
        The ward is being built. Phase 0: foundations poured, first patient
        (Ms&nbsp;Nomvula Dlamini, resp-001) admitted to the case bank.
      </p>
      <footer className="absolute bottom-6 text-xs text-neutral-600">
        A study tool, not medical advice. Practice here — verify with your guidelines.
      </footer>
    </main>
  );
}
