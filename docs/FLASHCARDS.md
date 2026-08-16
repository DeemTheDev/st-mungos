# Flashcards — design document

New wing of St Mungo's: Azra uploads Q&A PDFs (or Word docs), the system extracts
structured question/answer cards, stores them in Supabase, and serves them back as
a spaced-repetition study tool. Installable as a PWA on her Android phone.

Status: **planned, awaiting go-ahead.** Sequenced alongside BRAIN=live + Phase 5
(bank to 50) after the API top-up; the flashcard *build* itself costs ~$0, and
per-document extraction costs cents (table below).

---

## 1. What extracted PDF data actually looks like (the honest part)

We cannot promise clean "Q: … A: …" text, because Q&A PDFs come in flavours:

| Flavour | What extraction yields | Frequency |
|---|---|---|
| Inline Q&A (`1. Question… Answer: …`) | Clean pairs, locally adjacent | common |
| MCQ bank with **answer key at the end** | Questions on pp 1–40, answers on pp 41–43 — locality is broken by design | very common in med school |
| Two-column / tabular layouts | Text extractors can scramble reading order across columns | occasional |
| Scanned pages (no text layer) | **Nothing** — needs OCR | occasional |

Consequences baked into the design:
- Every page is extracted **individually with page anchors** (we already do this in
  `lib/kb-pipeline` with `unpdf`), so cards carry `source_pages` provenance and she
  can always check the original.
- A **survey pass** classifies the document layout before extraction (below) —
  this is what makes the answer-key-at-the-end flavour solvable.
- Scanned PDFs are **detected and refused with a friendly message** in MVP
  ("this looks like a scan — OCR support is coming"). tesseract.js OCR is a
  fast-follow, not an MVP promise.
- DOCX: `mammoth` (battle-tested) → text; same pipeline from there.

## 2. Pipeline — three passes, no callbacks

Nadeem proposed batching chunks to the LLM with a **callback URL** into the app,
including "ask for the next batch" when an answer is missing. We keep the batching
idea and drop the callback mechanism:

- Anthropic's Batches API doesn't push webhooks — the supported pattern is polling.
- Inbound callbacks on Vercel add an auth surface + cold-start latency for zero gain.
- The "answer didn't arrive in this batch" problem has a cleaner structural fix:
  **overlapping windows + a reconciliation pass** (below). The model never needs to
  request more data; the pipeline already guarantees it sees every pair intact
  somewhere, or the orphan is resolved in pass 3.

### Pass 1 — survey (1 cheap call)
Input: a document skeleton (per-page first ~300 chars + detected headings + TOC
pages verbatim if present). Output (structured):
`{ layout: "inline-qa" | "answer-key" | "notes-only" | "mixed", sections: [{title, page_range}], answer_key_pages?: [..], junk_pages: [..] }`
This implements "build from the table of contents" and "remove redundant
information" (cover pages, indexes, ads) *before* we pay to extract them.

### Pass 2 — windowed extraction (N calls, batched)
- Chunk ~3k tokens per window with **~15% overlap** so a pair split across a
  boundary appears whole in at least one window. Dedupe later by normalized
  question hash.
- If layout = `answer-key`: each question window is sent **together with the
  matching slice of the answer key** (paired by question numbering from the
  survey). Locality restored by construction.
- Model output per window (structured outputs, schema-enforced):
  `{ cards: [{topic, question, answer, qnum?, confidence}], orphan_questions: [...], orphan_answers: [...] }`
- Instructions: pair Q↔A by numbering/format/adjacency; never invent an answer;
  when unsure, emit an orphan rather than a guess.

### Pass 3 — reconciliation (0–1 call)
Deterministic first: match orphan questions ↔ orphan answers across windows by
question number, then by normalized-prefix match. Whatever survives goes in ONE
cleanup call (all orphans together). Still unmatched → stored as
`needs_review` cards so nothing silently disappears; the UI shows them in a
"needs a look" tray.

### Job orchestration (serverless-friendly)
`fc_documents.status: uploaded → surveying → extracting (n/m) → reconciling → ready | failed`.
The PWA polls a job endpoint; each poll tick processes **one step** server-side
(one window = one invocation, always under Vercel's function limit) and returns
progress — the loading tab UI falls out of this for free, and a killed job resumes
from the last completed window (same manifest-checkpoint philosophy as the KB
pipeline). For big documents we can later submit all windows as one Anthropic
**Batch** (50% off) and poll batch status instead — same job table, cheaper, slower.

## 3. Model choice + cost (the decision)

**Anthropic Haiku 4.5 + structured outputs.** Reasons over free Google AI Studio:
1. **Structured outputs are schema-enforced by the API** — the exact feature that
   eliminated our case-generator waste. For "structured return data" this is the
   difference between cents and debugging sessions.
2. Extraction is transcription-shaped work — Haiku-grade, `thinking: disabled`,
   instructions cached across windows (90% off repeated prefix).
3. One platform: existing key, existing SDK, existing code patterns
   (`gen-common.ts` is 80% reusable). Gemini free would save pennies and cost a
   second integration + no schema enforcement. (Gemini stays where it is — the
   Teapot's Daily Prophet.)

| Item | Est. cost |
|---|---|
| Survey pass | ~$0.01 |
| 100-page Q&A PDF, ~35 windows, Haiku sync | ~$0.30 |
| Same via Batches API | ~$0.15 |
| Reconciliation | ~$0.01 |
| **Her entire exam corpus (guess: 5–10 docs)** | **~$1–2 total** |
| Optional "explain this answer" button | ~$0.001/click, on demand |

## 4. Storage (Supabase) & search

```
fc_documents (id, filename, status, progress, layout, toc jsonb, error, created_at)
fc_sections  (id, document_id, title, ord, page_range)
fc_cards     (id, document_id, section_id, topic, question, answer, qnum,
              source_pages int[], confidence, status auto|needs_review,
              qhash unique-per-doc, created_at)
fc_reviews   (card_id pk, due_at, stability, difficulty, reps, lapses,
              state, last_grade, last_reviewed_at)   -- FSRS state
```
- Raw uploads → private Supabase Storage bucket.
- **Search: Postgres full-text search** (generated tsvector over
  topic+question+answer) — free, built-in, covers "search by topic or even
  question and answers". Embeddings/pgvector deferred until FTS provably falls short.
- Migration file: `supabase/schema-flashcards.sql`, same run-once pattern.

## 5. Learning science (what actually makes it absorb)

The two effects with the strongest evidence in all of learning research:

1. **Retrieval practice / the testing effect** (Roediger & Karpicke) — being forced
   to *recall* beats re-reading by a wide margin. Design consequence: the answer is
   never visible until she commits — tap to reveal, then **grade herself**
   (Again / Hard / Good / Easy).
2. **Spaced repetition** (Ebbinghaus forgetting curve) — reviews scheduled at
   expanding intervals exactly when forgetting is about to win. We use **FSRS**
   (the modern open-source scheduler that outperforms classic SM-2/Anki; `ts-fsrs`
   on npm, MIT) fed by her four-button grades. This is the single highest-value
   feature — flashcards without scheduling are just notes with extra steps.
   - **Cram mode**: exam is Aug 31, so the scheduler takes an exam date and caps
     intervals — retention targeted *at the exam*, not at the ideal long-term curve.
3. **Interleaving** — sessions mix topics rather than blocking one topic, which
   feels harder and works better. Default review deck = due cards shuffled across
   all topics; topic filter is opt-in for targeted drilling.
4. **Provenance** — every card links to its source pages; trust drives usage.

**The killer integration (fast-follow, near-zero cost):** St Mungo's already knows
her weaknesses — `/notes` aggregates most-missed checklist items across stations.
One button turns each missed item + its model answer into a flashcard deck.
No other flashcard app on earth can generate cards from her actual exam failures.

Deferred boosters: cloze deletions, AI "explain why" elaboration, image occlusion,
audio cards via the existing TTS.

## 6. PWA

- `@serwist/next` service worker + manifest + icons → installable on Android.
- MVP: install + online review. Fast-follow: offline review (due cards cached in
  IndexedDB, grades queued and synced) — genuinely valuable for studying anywhere.
- New nav entry: **Flashcards** → `/flashcards` (decks + due-today count + upload),
  `/flashcards/review` (session player: card, reveal, grade, progress),
  `/flashcards/upload` (drag-drop, job progress tab; other decks remain usable
  while a document processes — jobs are background rows, not blocking UI).

## 7. MVP cut

**In:** upload (pdf/docx) → 3-pass pipeline → cards in Supabase → review player
with FSRS + 4-button grading + cram mode → topic/section browse → full-text
search → needs-review tray → job progress tab → PWA install → nav button.
**Out (fast-follow):** OCR for scans, offline sync, cards-from-missed-checklist,
Batches optimization, explain-why button, cloze.

## 8. Open questions for Nadeem/Azra

1. One sample PDF of hers (even 5 pages) before build finishes = the difference
   between tuned heuristics and guesses. Can she share one into `/grounding`?
2. MCQ handling: keep distractor options on the card (front shows options like the
   real exam) or strip to open Q→A? Default plan: keep options when detected,
   card front = stem + options, back = correct option + any explanation text.
