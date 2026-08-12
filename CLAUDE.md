# CLAUDE.md â€” OSCE Simulator ("St Mungo's")

A voice-driven OSCE (Objective Structured Clinical Examination) simulator for a 4th-year
medical student at UKZN, currently in her internal medicine block. Exams are at the end of
August â€” **bias every decision toward shipping a usable practice tool fast.**

---

## 1. Mission & context

- Simulate a realistic 20-minute OSCE station: the student interviews and examines a virtual
  patient, is interrupted mid-session by a virtual examiner with probing questions, and is
  marked afterwards against a real-style station checklist.
- Pedagogy this must respect: **symptom â†’ differential**, never diagnosis-first. The student
  starts from a presenting complaint and works forward. Pathophysiology of each symptom
  matters as much as the label. End goal per station: differential â†’ investigations to
  confirm â†’ final diagnosis â†’ management.
- Clinical context: **KwaZulu-Natal, South Africa.** Case epidemiology must reflect it â€”
  high HIV prevalence (and its opportunistic infections), TB (pulmonary and extrapulmonary),
  hepatitis B, diabetes and its emergencies, hypertensive heart disease/CCF, CKD, rheumatic
  heart disease. Ground management in South African practice (SA EML / Adult Hospital Level
  STGs, WHO clinical staging for HIV, SA TB guidelines).
- Single user (the student). No public signup. Simple access gate (shared password or a
  minimal auth flow via the existing Supabase integration â€” your call) is enough.
- This is a study tool, not medical advice. Put a one-line disclaimer in the footer and move on.

## 2. Non-negotiables

1. **The patient never invents medicine.** The patient LLM answers strictly from the case
   JSON. If asked something the case doesn't specify, it answers with a realistic negative or
   "I'm not sure, doctor" â€” it must NOT hallucinate new findings, results, or history.
2. **All marking is anchored to the case's checklist and examiner bank** â€” never freestyle
   vibes-based grading.
3. **Unreviewed cases never reach the student.** Generated cases land in `cases/drafts/` and
   are only promoted to `cases/bank/` after human review (see Â§5).
4. **No secrets in the repo.** All keys via env vars. The Azure Speech key never reaches the
   browser â€” the client gets a short-lived token from an API route.
5. Verify your own work: after edits run `pnpm build` (or `pnpm tsc --noEmit`) as a check;
   after refactors, grep for stale references. Show real results, don't claim success.
6. Don't deploy, push, or create external resources without an explicit go-ahead from Nadeem.
   Prepare the exact commands; he pulls the trigger.

## 3. Tech stack & architecture

**Fixed choices (product decisions â€” don't relitigate):**

- **Next.js (App Router) + TypeScript + Tailwind + shadcn/ui**, deployed on **Vercel**
  (subdomain of Nadeem's existing domain; Vercel is already set up).
- **Anthropic API** (server-side only, via `@anthropic-ai/sdk`):
  - Patient roleplay: `claude-haiku-4-5-20251001` (fast, cheap, many turns).
  - Examiner + end-of-session marking + case generation + KB distillation: `claude-sonnet-4-6`.
  - **Use prompt caching**: the case JSON + persona system prompt is identical across all
    turns of a session â€” cache it. This cuts per-turn cost ~90%.
- **Azure Speech Services** for voice, both directions (Azure pay-as-you-go account available;
  F0 free tier covers expected usage):
  - STT: streaming recognition via the Speech SDK in the browser.
  - TTS: neural voices â€” patient = `en-ZA-LeahNeural` (or `en-ZA-LukeNeural` if the case
    patient is male), examiner = the other one. Two distinct SA voices.
  - Browser auth: `/api/speech/token` route exchanges the server-side key for a ~10-min token.
- **react-three-fiber + drei** for the 3D room and the patient `.glb` (a Spider-Man model â€”
  inside joke, keep it).
- **jsPDF** (or `@react-pdf/renderer`) for the downloadable session report.

**Delegated to you (infrastructure decisions):** persistence, storage, and job handling.
**Supabase is already integrated** (Postgres, storage, auth available) and is the default
candidate â€” but you decide the exact shape: what lives in Postgres vs storage buckets vs the
repo, how the KB is stored so it's runtime-updatable (see Â§5d), how ingestion jobs run within
Vercel's serverless limits (long PDF distillation won't fit one function invocation â€” chunk,
queue, or background it as you see fit). Choose for efficiency, scalability, and low cost;
record every non-obvious infra decision briefly in `DECISIONS.md` with the why.

Hard requirements the infra must satisfy, however you build it:
- Sessions survive refresh/quit and resume exactly (state persisted every turn).
- The KB must be updatable at runtime without a redeploy (future self-serve uploads, Â§5d).
- No secrets client-side; uploads validated (type/size) before processing.

### Ports & adapters

Keep vendors behind interfaces so any of them can be swapped without touching the engine:

```ts
interface SpeechToText { start(onPartial, onFinal): void; stop(): void }
interface TextToSpeech { speak(text, voice: "patient" | "examiner"): Promise<void>; onSpeaking(cb): void }
interface CaseStore    { list(): CaseSummary[]; get(id): OsceCase }
interface KbStore      { search(keywords): KbTopic[]; upsert(topic): void }
interface Brain        { patientTurn(ctx): Promise<string>; examinerTurn(ctx): Promise<string>; mark(ctx): Promise<MarkingReport> }
```

The session engine depends only on these ports. Azure/Anthropic/Supabase are adapters.

### Runtime flow (one voice turn)

```
[hold space] â†’ mic â†’ Azure STT (streaming) â†’ final transcript
  â†’ POST /api/session/turn { sessionId, utterance }
  â†’ server: load session state + case JSON â†’ decide speaker (engine, Â§6)
  â†’ Anthropic (Haiku patient / Sonnet examiner) â†’ reply text
  â†’ append both utterances to transcript (timestamped, phase-tagged) â†’ persist
  â†’ client: Azure TTS speaks reply in the correct voice â†’ 3D model bobs on speaking events
```

Push-to-talk (hold spacebar / on-screen button) is deliberate: it removes VAD/barge-in
complexity entirely and suits exam turn-taking.

## 4. The case JSON schema (the heart of the project)

Define this as Zod schemas in `lib/case-schema.ts` and validate every case against it.
TypeScript types derive from Zod. Shape:

```jsonc
{
  "id": "resp-001-ptb-hiv",
  "version": 1,
  "discipline": "respiratory",           // system: resp | cardio | gi-hep | endo | neuro | renal | haem | id | rheum
  "diagnosis": "Pulmonary tuberculosis with newly diagnosed HIV",
  "commonness": "common",                // common | uncommon  (bank target: ~80/20)
  "difficulty": 2,                       // 1-3
  "framework": "chronic cough + constitutional symptoms",  // the symptom-to-differential framework in play

  "patient": {
    "name": "Nomvula Dlamini",
    "age": 28, "sex": "F",
    "occupation": "till operator",
    "personality": "soft-spoken, worried, minimises symptoms unless asked directly",
    "openingLine": "Doctor, I've had this cough that just won't go away..."
  },

  "presentingComplaint": "6-week productive cough, weight loss, night sweats",

  "history": [
    // EVERY fact tagged with disclosure rules. The patient LLM may ONLY reveal per these rules.
    { "id": "hx-onset", "fact": "Cough started ~6 weeks ago, gradually worsening",
      "disclosure": "volunteered" },
    { "id": "hx-sputum", "fact": "Productive of yellow sputum, twice blood-streaked",
      "disclosure": "onAsk", "triggers": ["sputum", "coughing up", "phlegm", "blood"] },
    { "id": "hx-hiv", "fact": "Never tested for HIV; partner recently diagnosed positive",
      "disclosure": "onAsk", "triggers": ["hiv", "tested", "partner", "sexual history"] },
    { "id": "hx-tb-contact", "fact": "Uncle in same household treated for TB last year",
      "disclosure": "onAsk", "triggers": ["tb", "contact", "household", "family sick"] }
    // ... full HPI, systems review negatives, PMH, meds, allergies, social, family
  ],

  "examination": {
    // Revealed ONLY when the student states she performs the relevant exam step.
    "general": "Thin, chronically unwell-looking. Pallor +. No clubbing. Generalised lymphadenopathy.",
    "vitals": { "hr": 104, "bp": "108/68", "rr": 22, "temp": 37.9, "spo2": "94% RA", "bmi": 18 },
    "respiratory": "Right upper zone: dull percussion, bronchial breathing, coarse crackles.",
    "cardio": "Normal heart sounds, no murmurs.",
    "abdo": "2cm smooth hepatomegaly, non-tender. No splenomegaly.",
    "neuro": "Grossly intact.",
    "other": {}
  },

  "investigations": [
    // A catalogue with REAL values. Only given when specifically requested.
    { "name": "Sputum GeneXpert MTB/RIF", "result": "MTB detected, rifampicin resistance NOT detected", "key": true },
    { "name": "HIV ELISA", "result": "Positive", "key": true },
    { "name": "CD4 count", "result": "187 cells/ÂµL", "key": true },
    { "name": "CXR", "result": "Right upper lobe consolidation with early cavitation", "key": true },
    { "name": "FBC", "result": "Hb 9.8 normocytic, WCC 7.2, Plt 512" },
    { "name": "U&E", "result": "Normal" }
    // include plausible non-key tests too, so ordering everything isn't free
  ],

  "differentials": [
    { "dx": "Pulmonary TB", "rank": 1, "for": ["contact", "constitutional", "duration", "haemoptysis"], "against": [] },
    { "dx": "Community-acquired pneumonia", "rank": 2, "for": ["productive cough", "fever"], "against": ["6-week course", "weight loss"] },
    { "dx": "Bronchiectasis", "rank": 3, "for": [], "against": [] },
    { "dx": "Lung malignancy", "rank": 4, "for": [], "against": ["age"] }
  ],

  "pathophys": {
    // Symptom â†’ mechanism map. Used by the examiner's "why" questions and the report.
    "night sweats": "Cytokine-mediated (TNF-Î±, IL-1) hypothalamic set-point fluctuation in chronic granulomatous infection",
    "haemoptysis": "Caseating granulomas eroding into bronchial vessels; cavitation exposes vasculature",
    "weight loss": "TNF-Î± (cachectin) driven catabolism + anorexia of chronic infection Â± HIV wasting"
  },

  "staging": "WHO HIV clinical stage 3 (pulmonary TB); drug-susceptible TB, new patient",

  "management": {
    "immediate": ["Respiratory isolation considerations", "Notify TB (notifiable disease)"],
    "definitive": ["Standard 6-month regimen: 2HRZE/4HR, weight-banded FDC", "Start ART ~2 weeks after TB treatment (CD4 <50 â†’ within 2/52; otherwise within 8/52)", "Co-trimoxazole prophylaxis (CD4 <200)", "Pyridoxine"],
    "supportive": ["Nutritional support", "Contact tracing & household screening", "Adherence counselling"],
    "followUp": ["Sputum at 2 months", "Monitor LFTs if symptomatic", "VL/CD4 monitoring per ART guidelines"]
  },

  "stationChecklist": [
    // THE MARK SHEET. Every question/action the student is expected to take,
    // with the case's answer and why it matters. This drives marking AND the learning report.
    { "id": "cl-intro", "phase": "history", "item": "Introduces self, confirms patient identity, gains consent",
      "answer": null, "why": "Professionalism / communication", "weight": 1, "critical": false },
    { "id": "cl-socrates", "phase": "history", "item": "Characterises the cough (duration, sputum, haemoptysis, pattern)",
      "answer": "6 weeks, productive, twice blood-streaked", "why": "Duration >2 weeks triggers TB workup in SA", "weight": 2, "critical": true },
    { "id": "cl-constitutional", "phase": "history", "item": "Screens constitutional symptoms (weight loss, night sweats, fever)",
      "answer": "All present", "why": "Core TB screen", "weight": 2, "critical": true },
    { "id": "cl-hiv", "phase": "history", "item": "Asks HIV status / offers testing; takes sexual history",
      "answer": "Never tested; partner positive", "why": "HIV testing is standard of care in any SA TB presentation", "weight": 3, "critical": true },
    { "id": "cl-tb-contact", "phase": "history", "item": "Asks about TB contacts",
      "answer": "Household uncle treated last year", "why": "Strongest single risk factor here", "weight": 2, "critical": true },
    { "id": "cl-resp-exam", "phase": "examination", "item": "Performs focused respiratory exam (percussion, auscultation)",
      "answer": "RUZ dullness, bronchial breathing, crackles", "why": "Localises pathology", "weight": 2, "critical": false },
    { "id": "cl-ddx", "phase": "differentials", "item": "Offers ranked differential with reasoning (TB > CAP > bronchiectasis > malignancy)",
      "answer": null, "why": "Symptomâ†’differential is the whole exam philosophy", "weight": 3, "critical": true },
    { "id": "cl-ix", "phase": "investigations", "item": "Requests GeneXpert, HIV test, CXR (Â± CD4 once positive)",
      "answer": "See investigations", "why": "Confirmatory pathway", "weight": 3, "critical": true },
    { "id": "cl-mx", "phase": "management", "item": "Outlines 2HRZE/4HR, ART timing, CTX prophylaxis, notification, contact tracing",
      "answer": null, "why": "Management per SA guidelines", "weight": 3, "critical": false }
  ],

  "examinerBank": [
    // Viva questions the examiner interjects with. Each has a model answer + grading notes.
    { "id": "ex-1", "triggerPhase": "history", "triggerAfterSec": 300,
      "question": "Before you go on â€” what is your differential at this point, and what in the history drives each?",
      "modelAnswer": "TB top (contact, >2wk cough, constitutional sx, haemoptysis), then CAP, bronchiectasis, malignancy...",
      "gradingNotes": "Full marks: ranked ddx WITH linked reasoning. Partial: list without reasoning." },
    { "id": "ex-2", "triggerPhase": "examination",
      "question": "You mentioned night sweats. Walk me through the pathophysiology.",
      "modelAnswer": "(pull from pathophys map)", "gradingNotes": "Wants mechanism, not restatement." },
    { "id": "ex-3", "triggerPhase": "investigations",
      "question": "Her CD4 comes back at 187. How does that change your management and why?",
      "modelAnswer": "CTX prophylaxis (CD4<200); ART timing after TB tx initiation; OI vigilance; IRIS counselling",
      "gradingNotes": "Critical thinking under new information." }
  ],

  "rubric": {
    // Domain weights for the global rating (out of 100), alongside checklist coverage.
    "communication": 10, "historyTaking": 25, "examination": 15,
    "clinicalReasoning": 25, "investigations": 10, "management": 15
  }
}
```

## 4b. Interpretation stations (CXR, ABG, ECG) â€” high priority for this exam

A second station type. Cases carry `"stationType": "clinical" | "interpretation"` (the schema
above is `clinical`; add the discriminator). Interpretation stations are short (default
**7 minutes**), stimulus-first, and marked against a **stepwise interpretation framework** â€”
the systematic method matters as much as the final answer.

```jsonc
{
  "id": "interp-abg-004",
  "stationType": "interpretation",
  "stimulus": {
    "kind": "abg",                        // abg | ecg | cxr
    "vignette": "58-year-old man, known COPD, 3 days of worsening breathlessness. ABG on room air:",
    // ABG: raw values only â€” no image needed.
    "values": { "pH": 7.28, "pCO2_kPa": 9.1, "pO2_kPa": 7.2, "HCO3": 31, "BE": 4,
                "Na": 138, "Cl": 100, "K": 4.4, "lactate": 1.1 },
    // ECG/CXR: an image + structured findings key.
    "imagePath": null                     // e.g. "/stimuli/ecg-afib-rvr-01.png" for ecg|cxr
  },
  "findingsKey": [
    { "finding": "Acidaemia (pH 7.28)", "critical": true },
    { "finding": "Raised pCO2 â†’ primary respiratory acidosis", "critical": true },
    { "finding": "Raised HCO3 â†’ partial metabolic compensation (chronic element)", "critical": true },
    { "finding": "Type 2 respiratory failure (pO2 7.2 + pCO2 9.1)", "critical": true },
    { "finding": "Normal anion gap (~7)", "critical": false }
  ],
  "interpretationChecklist": [
    // The stepwise method she must verbalise, in order. Derived from the relevant KB chapter.
    { "id": "ic-1", "item": "Comments on clinical context first", "weight": 1 },
    { "id": "ic-2", "item": "Assesses oxygenation (pO2 vs FiO2)", "weight": 2 },
    { "id": "ic-3", "item": "Identifies acidaemia/alkalaemia from pH", "weight": 2 },
    { "id": "ic-4", "item": "Identifies primary disorder (resp vs metabolic)", "weight": 3 },
    { "id": "ic-5", "item": "Assesses compensation (acute vs chronic)", "weight": 3 },
    { "id": "ic-6", "item": "Calculates anion gap where relevant", "weight": 2 },
    { "id": "ic-7", "item": "Synthesises: diagnosis + clinical correlation", "weight": 3 },
    { "id": "ic-8", "item": "States immediate management implications", "weight": 2 }
  ],
  "diagnosis": "Acute-on-chronic type 2 respiratory failure (infective exacerbation of COPD)",
  "examinerBank": [ /* same shape as clinical stations: probing questions + model answers */ ],
  "management": { /* brief â€” what she should do next */ }
}
```

Generation & validation rules per kind:
- **ABG:** fully synthetic â€” generate values, then **validate with physiology, not vibes**:
  Henderson-Hasselbalch consistency between pH/pCO2/HCO3, and expected-compensation rules
  (Winter's formula for metabolic acidosis, acute vs chronic respiratory compensation deltas).
  Reject internally inconsistent gases in the generator. Deterministic checks > LLM review.
- **ECG / CXR:** need real images. Sources, in order of preference: (1) images extracted from
  the grounding PDF/notes during ingest (`/grounding/stimuli-candidates/`, human-reviewed then
  promoted to `/public/stimuli/`), (2) images Nadeem/she add manually from her course
  material, (3) openly-licensed images (e.g. Wikimedia Commons). Each promoted image gets a
  JSON sidecar (findings key + checklist) generated from the KB and reviewed like any case.
  **Never generate or alter medical images with AI.** If no image exists for a wanted case,
  skip it â€” do not fake a stimulus.
- Interpretation frameworks (the checklist steps) come from the KB's "approach to CXR/ABG/ECG"
  chapters if present, else standard systematic methods (CXR: RIPE quality check then ABCDE;
  ECG: rate â†’ rhythm â†’ axis â†’ intervals â†’ morphology by territory).

**Integration with clinical stations:** when a clinical case's key investigation has a
stimulus available (`investigations[].stimulusRef`), don't just read out the result â€” show
the image/values and require her to interpret it first. The examiner confirms or corrects
only after she commits. This is exactly how the real station plays.

## 5. Grounding knowledge base & case generation pipeline

**Principle: the raw grounding files are never fed into prompts wholesale.** They are
processed gradually into a distilled, referenceable knowledge base (`/grounding/kb/`), and
everything downstream reads the KB â€” not the raw sources. The KB is the single referenceable
store; the raw PDF/docx/md files are source-of-truth only. All grounding material is the
student's own private course/study material: keep the repo private, never redistribute it,
and gitignore `/grounding/` raw files if the repo ever risks going public.

### Stage A â€” Ingest & normalise (`scripts/ingest-grounding.ts`)
- **Build ingest + distil as a shared library** (`lib/kb-pipeline/`) invoked by the CLI now
  and by the upload API route later (Â§5d) â€” same code path, two entry points.
- Handles **pdf and md** (all current grounding files are one of the two; if other formats
  appear, convert them too): PDFs via text extraction â€” check for a text layer first, OCR if
  scanned; md passes through. Normalised output â†’ `/grounding/normalized/<source-slug>/`.
- For the 309-page `approach-to-everything.pdf`: split by chapter/heading
  ("Approach to ...") into one file per chapter. **Also extract embedded images** (ECGs,
  CXRs, tables rendered as images) into `/grounding/stimuli-candidates/` with a note of the
  chapter they came from â€” these feed the interpretation stations (Â§4b) after human review.
- Maintain `/grounding/manifest.json` (source file hashes â†’ outputs). Re-runs are
  **incremental**: only new or changed sources get processed. This is the "gradual
  extraction" mechanism â€” new notes can be dropped in any time and only they get ingested.

### Stage B â€” Distil into the KB (`scripts/distill-kb.ts`)
- One `claude-sonnet-4-6` call **per chapter/note** (never batched into one giant prompt),
  producing `/grounding/kb/<topic-slug>.md` with a fixed structure: framework steps,
  ranked differentials, red flags, key history questions, exam findings, first-line and
  confirmatory investigations, management outline, pathophys pearls, KZN/SA-specific notes.
- **Merge the student's own notes into the same topic file** when they cover the same
  subject, under an `## Her notes emphasise` section â€” her notes reflect what her lecturers
  actually stressed, so case generation and examiner questions must weight that section
  heavily.
- Build `/grounding/kb/_index.json`: keywords/symptoms/systems â†’ KB files.
- Incremental via the same manifest; distillation runs chapter-by-chapter and can be resumed.

### Stage C â€” Case generation (`scripts/generate-cases.ts`)
- CLI: `pnpm gen:cases --system resp --count 5 [--uncommon]` and
  `pnpm gen:interp --kind abg|ecg|cxr --count 5` (see Â§4b).
- Per case: retrieve only the matching KB file(s) via the index, plus
  `/grounding/_epidemiology-kzn.md` (write this brief if missing), then call
  `claude-sonnet-4-6` with the Zod schema + few-shot example to produce complete cases.
- **The `stationChecklist` and `framework` field must be derived from the matching "Approach
  to X" chapter whenever one exists** â€” the checklist is that chapter's framework turned into
  a mark sheet. Same for the examiner's "walk me through your approach" style questions.
- Every generated case is validated with Zod; failures are retried once with the validation
  errors fed back, then discarded with a log.
- Output â†’ `cases/drafts/<id>.json`. A tiny review page at `/admin/review` renders a draft
  case human-readably (checklist, answers, management) with Approve â†’ moves to `cases/bank/`
  and Reject â†’ deletes. **Nothing enters the bank without approval.**
- Dedupe: refuse a draft whose (diagnosis + presenting complaint pattern) already exists in
  bank + drafts.
- Bank targets: **~50 cases, ~80% common / ~20% uncommon**, spread across systems with a
  coverage matrix printed by `pnpm gen:coverage` (system Ã— commonness table) so gaps are visible.
- Case bank and KB storage location is your infra call (Â§3) â€” the constraint is that both
  must be runtime-updatable (Â§5d) and the persistence layer holds session data separately.
- Review gate note: the student herself is the ideal clinical reviewer â€” the `/admin/review`
  page must be usable by either her or Nadeem (it's readable clinical content, not code).

### Â§5d â€” Self-serve notes upload (scale feature; design for it from day one)
The student can upload her own notes **from the platform UI** â€” md preferred, pdf accepted â€”
and the knowledge base updates itself:

- Upload page: drag-and-drop, md/pdf only, sane size cap, clear rejection messages.
- On upload: store the raw file, then run the **same shared KB pipeline** (Stage A â†’ Stage B,
  `lib/kb-pipeline/`) as a background job â€” incremental via the manifest, one distillation
  call per document/chapter, respecting Vercel execution limits (your infra design from Â§3
  decides how: chunked invocations, queue, or background function).
- Status feedback in the UI: `uploaded â†’ processing â†’ done`, ending with a human summary:
  "Added/updated KB topics: approach to jaundice, approach to seizures."
- New/updated KB topics immediately become available to case generation; offer a one-click
  "generate cases from new topics" that produces **drafts** â€” the review gate (Â§5 Stage C)
  still applies before anything reaches the bank.
- Uploaded raw files are private user content: stored privately, never committed to the repo.

## 6. Session engine

A server-side state machine keyed by `sessionId`, persisted via the persistence layer (Â§3,
your infra design) after every turn so **quit/resume works** (resume restores phase, elapsed
time, transcript, and revealed facts).

Phases: `intro â†’ history â†’ examination â†’ differentials â†’ investigations â†’ management â†’ wrap`.
Phase transitions: primarily student-driven (she says "I'd now like to examine the patient" /
"I want to order some tests") with the examiner nudging at time checkpoints if she's stuck in
a phase too long (e.g., >8 min still in history â†’ examiner: "In the interest of time, doctor,
let's move to your examination.").

- **Timer: 20:00 hard.** At 0:00 the examiner ends the station ("Thank you doctor, time's up
  â€” we'll go to marking.") and the marking pass runs. Warnings at 10:00 and 17:00 (examiner
  voice, in-character).
- **Speaker arbitration:** default responder is the patient. The examiner speaks when (a) an
  `examinerBank` trigger fires (phase entry / elapsed time), (b) the student addresses the
  examiner ("I'd like to present my differential"), (c) a timer event fires. Examiner
  interjections wait for the current TTS utterance to finish â€” no talking over.
- **Patient prompt (Haiku, cached system prompt):** persona + full case JSON + hard rules:
  answer only from `history`/`examination`/`investigations` per disclosure rules; stay in
  character; layperson language (a patient says "sugar sickness", not "poorly controlled
  T2DM"); brief natural answers; never volunteer `onAsk` facts unless a trigger topic is asked.
  Exam findings are narrated clinically when she performs the step ("On auscultation you
  hear..."), investigations returned verbatim when ordered â€” these are system narration, use
  the examiner voice channel for them.
- **Examiner prompt (Sonnet, cached):** professional UKZN internal medicine examiner. Firm,
  fair, probing. Asks from `examinerBank`; may ask ONE spontaneous follow-up per bank question
  if her answer begs it, grounded in the case JSON only. Never teaches mid-station; never
  reveals whether an answer was right.
- **Transcript:** every utterance stored `{ speaker: student|patient|examiner, text, ts, phase }`.
  Also track which checklist `triggers` were hit and which exam steps/investigations were
  requested â€” this makes marking cheaper and more deterministic.
- **Interpretation stations** run a simpler machine: `present â†’ interpret â†’ probe â†’ wrap`,
  7-minute default timer, no patient â€” the examiner presents the vignette + stimulus, she
  talks through her interpretation aloud (same push-to-talk), examiner probes from the bank,
  then marking runs against `interpretationChecklist` + `findingsKey`. In clinical stations,
  ordering an investigation with a `stimulusRef` pauses the flow into a mini interpret-step
  before the result is confirmed.

## 7. Marking engine (end of session or on quit-with-mark)

One `claude-sonnet-4-6` call with: full transcript + case JSON + tracked reveal/request log.
Output (Zod-validated `MarkingReport`):

1. **Checklist coverage:** each `stationChecklist` item â†’ `done | partial | missed`, with a
   short quoted evidence snippet from the transcript. Weighted score per phase.
2. **Critical flags:** any `critical: true` item missed is listed prominently ("You did not
   establish HIV status â€” in this presentation that's an automatic examiner concern.").
3. **Viva grading:** each examinerBank question asked â†’ her answer graded vs `modelAnswer`
   per `gradingNotes` (0â€“2 scale + one-line comment).
4. **Domain scores** per `rubric` weights â†’ global score /100 + band (Distinction / Pass /
   Borderline / Fail â€” map 75+/60+/50+/<50).
5. **Narrative feedback:** 3 strengths, 3 priority improvements, and a "what the complete
   station looked like" section â€” the full checklist WITH model answers and the pathophys map,
   so every session doubles as study notes.
6. Persist via the persistence layer under the session; render in-app; exportable as PDF.
7. **Interpretation stations:** mark `interpretationChecklist` step coverage (did she follow
   the systematic method, in order?) + `findingsKey` hit rate (critical findings missed are
   flagged like clinical critical items) + final diagnosis correctness. Report shows the
   model interpretation walked through step-by-step so a failed station is still a lesson.

## 8. UI spec (dark, minimal, purposeful â€” not generic AI-gradient slop)

- **Exam room:** full-viewport react-three-fiber scene, simple dark room, the Spider-Man
  `.glb` centre-frame on a bed/chair. Subtle idle animation; scale/bob or slight head motion
  driven by TTS speaking events when the patient talks. Keep the scene cheap â€” no lighting
  rabbit holes.
- **Examiner bubble:** corner avatar (simple circle/initials) that pulses/animates while the
  examiner speaks; shows a live caption of the examiner's line.
- **HUD:** 20:00 countdown, current phase chip, push-to-talk button ("hold SPACE to speak")
  with live partial transcript, mute/repeat-last-line, and **Quit** (choices: save & resume
  later / end & mark now).
- **Sidebar (collapsible):** past sessions â€” date, case discipline, diagnosis (hidden until
  taken/revealed), score, band. Click â†’ full report.
- **Notes popup:** all reports/notes aggregated, **Download PDF** per session and combined.
- **Stimulus viewer:** for interpretation steps/stations â€” zoomable/pannable image panel for
  ECG/CXR (dark backdrop, no chrome), or a clean ABG values card. Overlays the room scene.
- **New exam flow:** Random case (respecting common/uncommon weighting) OR filtered: by
  system, by diagnosis, by station type (**clinical / ABG / ECG / CXR**), or
  "management-focus" mode (skips to a post-diagnosis viva on treatment of a chosen disease â€”
  she picks "heart failure management", gets a rapid-fire examiner viva from that case's
  management + examinerBank).
- Text-mode toggle: the entire session must also be playable via a chat input (this is also
  the Phase 2 deliverable and the permanent fallback when mic/browser misbehaves).

## 9. Data model (logical â€” storage engine is your call, Â§3; Supabase Postgres is the default candidate)

```
Session:  id, caseId, startedAt, endedAt?, phase, elapsedSec, status: active|completed|abandoned,
          transcript[], revealedFactIds[], orderedInvestigations[], askedExaminerQIds[]
Report:   sessionId, MarkingReport
KbTopic:  slug, content, sourceRefs[], updatedAt        (runtime-updatable, see Â§5d)
Upload:   id, filename, kind, status, resultSummary     (for Â§5d)
```

## 10. Environment variables

```
ANTHROPIC_API_KEY=            # server only
AZURE_SPEECH_KEY=             # server only â€” client gets short-lived tokens
AZURE_SPEECH_REGION=          # e.g. southafricanorth
SUPABASE_*                    # already integrated; exact vars per your infra design
APP_ACCESS_PASSWORD=          # simple gate
# Finalise this list yourself as infra decisions land; document additions in DECISIONS.md
```

## 11. Build phases â€” acceptance criteria per phase, in order, no skipping

- **Phase 0 â€” Scaffold:** Next.js + TS + Tailwind + shadcn, persistence wired (Supabase
  available), env template,
  Zod case schema + types, ONE hand-checked seed case (use the TB/HIV example above,
  clinically reviewed). âœ… `pnpm build` clean.
- **Phase 1 â€” Grounding KB + case pipeline:** KB pipeline built as the shared library
  (`lib/kb-pipeline/`), ingest (pdf/md â†’ normalized md, image
  extraction, manifest), distil-to-KB script run over the "Approach to Everything" chapters
  and her notes, generator script, draftsâ†’reviewâ†’bank flow, coverage report.
  âœ… KB built for â‰¥10 topics; 10 approved cases in bank across â‰¥3 systems, each traceable to
  its KB source file.
- **Phase 2 â€” Text-mode session E2E (the de-risking milestone):** full state machine, patient
  + examiner via Anthropic, timer, interrupts, quit/resume, marking report rendered + PDF.
  âœ… A complete 20-min station playable in text with a real report at the end.
- **Phase 2b â€” Interpretation stations:** ABG generator with physiology validation, stimulus
  viewer, interpretation session flow + marking, sidecar pipeline for reviewed ECG/CXR images.
  âœ… One ABG station and one image-based station (with whatever reviewed image exists)
  playable end-to-end in text mode.
- **Phase 3 â€” Voice:** Azure token route, push-to-talk STT, dual-voice TTS, captions,
  speaking events wired to UI. âœ… Full station playable hands-on-keyboard-free except PTT.
- **Phase 4 â€” Room & polish:** R3F scene + .glb, examiner bubble, sidebar, notes popup,
  new-exam flow, access gate. âœ… Deployable build ready for Nadeem to ship to the subdomain.
- **Phase 5 â€” Bank to 50:** generate + review to ~50 cases (80/20), regenerate coverage matrix,
  incorporate any grounding files that have arrived.
- **Phase 6 â€” Self-serve notes upload (Â§5d):** upload UI, background KB pipeline runs,
  status feedback, "generate cases from new topics" into drafts. Cheap to build because
  Phase 1 shipped the pipeline as a shared lib. âœ… Upload an md and a pdf; watch the KB gain
  topics and new draft cases appear for review â€” no redeploy.

After each phase: run the build, list what changed, flag anything cut or deferred. Do not
start the next phase without a green build.

## 12. Working agreement (how to behave in this repo)

- Verify against reality: run it, don't assume it. Prefer showing a passing build/real output.
- Keep scope tight. Adjacent ideas â†’ note in `IDEAS.md`, don't build them.
- Read before you edit; follow existing conventions; no dead code left behind.
- When there's a genuine fork, recommend one option with the why â€” don't dump option lists.
- Brief comments on non-obvious decisions; log infra/architecture choices you make (and the
  why) in `DECISIONS.md` as you go.
- Never commit anything from `/grounding` that looks like copyrighted textbook material to a
  public repo â€” keep the repo private or gitignore `/grounding`.

## 13. Open items (Nadeem to supply â€” proceed without blocking)

- [x] "Approach to Everything" PDF (309pp, primary frameworks source) â†’ `/grounding/approach-to-everything.pdf`
- [x] Her own notes (md + pdf; docx already converted to pdf) â†’ `/grounding/` as-is, with
      descriptive topic filenames. The ingest script handles the rest.
- [ ] ECG and CXR images for interpretation stations: review `/grounding/stimuli-candidates/`
      after ingest; add more from her course material if the PDF yields few.
- [ ] Additional study guides / block objectives / past-paper themes â†’ `/grounding/`
- [ ] The internal medicine handbook chapters (neuro, GI-hep, endo) â†’ `/grounding/`
- [ ] Confirmed list of systems this block's OSCE examines (adjust coverage matrix targets)
- [ ] The Spider-Man `.glb` â†’ `/public/models/patient.glb`
- [ ] Azure Speech resource (F0 on the pay-as-you-go sub) + Supabase keys + Anthropic key â†’ `.env.local`

