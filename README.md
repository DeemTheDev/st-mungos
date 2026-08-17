# St Mungo's

A voice-driven OSCE exam simulator, built for one medical student.

She walks into a station, takes a history from a patient who only reveals what she
actually asks about, gets grilled by an examiner, and comes out with a marked
report anchored to a real checklist. There's also a flashcard wing that turns her
own Q&A study documents into a spaced-repetition deck.

The authoritative spec is [`CLAUDE.md`](CLAUDE.md). Every non-obvious decision and
the reason for it is in [`DECISIONS.md`](DECISIONS.md). Diagrams live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quick start (zero services, zero cost)

```bash
pnpm install
pnpm dev
```

That's it. With no `.env.local` at all the app runs entirely on local files with a
deterministic mock brain: no Anthropic key, no Supabase, no Azure, **$0**. Open
http://localhost:3000.

To do anything real you need at minimum `ANTHROPIC_API_KEY` and
`APP_ACCESS_PASSWORD` in `.env.local` — copy [`.env.example`](.env.example), which
documents every variable and its default.

---

## The two switches that decide how everything behaves

| Variable | Values | What it changes |
|---|---|---|
| `BRAIN` | `mock` (default) · `live` | Who writes the patient's and examiner's words. `mock` is deterministic and free; `live` calls Anthropic. |
| `STORE` | `file` (default) · `supabase` | Where sessions, flashcards and the library (guides, KB, cases) are stored. |

They are independent. `BRAIN=live STORE=file` is a perfectly good local setup for
testing real dialogue without touching her data.

**Production must be `STORE=supabase`.** Vercel's filesystem is read-only and
ephemeral: in file mode a deployed instance loses every session and cannot approve
a case.

---

## Supabase setup

One dedicated project (not shared with any other app). In the SQL editor, run
these three files — each is idempotent and safe to re-run:

| File | Creates |
|---|---|
| `supabase/schema.sql` | `st_sessions` — her practice sessions |
| `supabase/schema-flashcards.sql` | `fc_documents`, `fc_sections`, `fc_cards`, `fc_reviews` |
| `supabase/schema-library.sql` | `st_source_docs`, `st_kb_topics`, `st_cases`, `st_spend` |

Then create two **private** Storage buckets (Storage → New bucket → Public **OFF**):

- `flashcards` — her uploaded Q&A documents
- `grounding` — her uploaded study guides

Every table has RLS enabled with **no policies**: the publishable key can read
nothing at all. All access goes through the server with `SUPABASE_SECRET_KEY`,
behind the password gate. Make sure that variable holds the `sb_secret_…` key —
the adapters throw a descriptive error if you paste the publishable one.

Finally, push the local knowledge base and case bank up:

```bash
pnpm migrate:library --dry-run
pnpm migrate:library
```

Idempotent, and it never demotes: a case you approved in production keeps its
approved status even if the local copy is still a draft.

---

## How a study guide becomes an exam station

The whole pipeline runs in the browser at `/library` in production, or from the
CLI locally. Only the middle three steps cost money, and all of them happen
*before* she ever sits a station.

1. **Upload** — a PDF/DOCX/MD study guide. Text is extracted page by page, with
   page numbers kept as provenance.
2. **Distil** — each chapter becomes one compact KB topic: presentation, red
   flags, differentials, investigations, SA-guideline management.
3. **Generate** — code picks a target diagnosis from a KZN-weighted pool
   (excluding everything already in the bank, so no call is ever wasted on a
   duplicate), then the model writes one complete station: patient persona,
   every history fact *with the trigger phrases that unlock it*, examination
   findings, investigations, ranked differentials, pathophysiology, management,
   the mark sheet, the examiner's question bank and rubric weights.
4. **Review** — a human approves it at `/review`. **Nothing unreviewed can ever
   reach a student**: the read-side case store serves `status='bank'` only.
5. **Play** — the engine reveals a fact only when her question matches that
   fact's triggers, and the patient model is only ever sent facts already
   revealed. It cannot leak what it never saw.

The AI writes the case once, offline. During the exam it only *acts* — it never
decides what is true. That is why a station costs cents and cannot invent a
diagnosis.

### Spend guardrails

The pipeline can spend money with nobody watching, so `LIBRARY_JOB_BUDGET_USD`
(default $2) and `LIBRARY_MONTH_BUDGET_USD` (default $10) are checked **before**
every model call. Hitting one returns HTTP 402 and the UI shows a calm notice —
the cap did its job. Every call is written to the `st_spend` ledger.

---

## Scripts

**Everyday**

```bash
pnpm dev · pnpm build · pnpm lint · pnpm exec tsc --noEmit
```

**Verification — all free, no API calls**

| Command | Proves |
|---|---|
| `pnpm simulate` | 70 checks over full 20-minute stations against the mock brain |
| `pnpm validate:cases` | every case in bank + drafts satisfies the schema |
| `pnpm gen:coverage` | the coverage matrix (systems × common/uncommon) |
| `pnpm verify:framing` | the 3D patient is actually framed in shot, across 7 aspect ratios |
| `pnpm smoke:speech` | speech queue sequencing, 26 checks |
| `pnpm verify:speech-token` | issues a real Azure token (needs the key) |

**Costs money**

| Command | Spends |
|---|---|
| `pnpm e2e:live` | ~$0.25 — two real stations. Asserts the disclosure guarantee against a live model, that marking flags un-asked items as missed, and that prompt caching is engaged. |
| `pnpm gen:cases --system cardio --count 3` | ~$0.10/case |
| `pnpm gen:interp --count 3` | ABG interpretation stations |
| `pnpm distill` | rebuilds KB topics from `/grounding` |
| `pnpm fc:test <file>` | flashcard extraction on one document |

`pnpm e2e:live` is the only test that can prove the property the whole product
rests on: it never asks about HIV, so the fact never matches a trigger, so the
patient model never receives it — and a model that *would* happily improvise
stays silent.

---

## Deployment

Vercel. Set in the project's environment variables:

```
ANTHROPIC_API_KEY, APP_ACCESS_PASSWORD,
SUPABASE_URL, SUPABASE_SECRET_KEY,
AZURE_SPEECH_KEY, AZURE_SPEECH_REGION,
BRAIN=live, STORE=supabase,
EXAM_DATE=YYYY-MM-DD          # optional: flashcard cram mode
```

`/grounding` is gitignored and never deployed — her course material stays on the
laptop and in the private Storage bucket. In production the knowledge base lives
in Supabase, which is why uploads must go through `/library` rather than the CLI.

The flashcards wing installs as a PWA on Android from `/flashcards`.
