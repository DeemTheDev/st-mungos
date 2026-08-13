# St Mungo's — Architecture & Flow

How the whole machine fits together. Diagrams are Mermaid — GitHub renders them; in VS Code use a Mermaid preview extension.

💰 marks the steps that spend Anthropic API credit. Everything else is free.

---

## 1. The big picture (components, ports & adapters)

The session engine only ever talks to **ports** (interfaces). Vendors are swappable **adapters** behind them — that's why the whole app runs at $0 against `MockBrain`, and why Azure/Anthropic/Supabase could each be replaced without touching the engine.

```mermaid
flowchart LR
  subgraph Browser
    UI["/session station UI<br/>(timer, transcript, input)"]
    ADMIN["/admin/review<br/>(approve/reject drafts)"]
  end

  subgraph "Next.js server (API routes)"
    API["/api/session/*"]
    ENGINE["Session Engine<br/>state machine · timer ·<br/>disclosure gate · arbitration"]
  end

  subgraph Ports
    BRAIN[("Brain")]
    CSTORE[("CaseStore")]
    SSTORE[("SessionStore")]
    KSTORE[("KbStore")]
  end

  subgraph Adapters
    MOCK["MockBrain<br/>(scripted, $0)"]
    ANTH["AnthropicBrain 💰<br/>patient: haiku-4-5<br/>examiner+marking: sonnet-5"]
    FS["file store (.sessions/)"]
    SB["Supabase (st_sessions)"]
    BANK["cases/bank/*.json"]
    KB["grounding/kb/*.md"]
  end

  UI --> API --> ENGINE
  ENGINE --> BRAIN & CSTORE & SSTORE
  BRAIN -.BRAIN=mock.-> MOCK
  BRAIN -.BRAIN=live.-> ANTH
  SSTORE -.STORE=file.-> FS
  SSTORE -.STORE=supabase.-> SB
  CSTORE --> BANK
  KSTORE --> KB
  ADMIN -->|approve| BANK
```

---

## 2. One conversation turn (text mode — what exists today)

The heart of the app. Note the **disclosure gate**: the patient model never receives the full case — only facts the student has already earned. It cannot leak what it never saw.

```mermaid
sequenceDiagram
  actor A as Azra
  participant UI as Station UI
  participant API as POST /api/session/:id/turn
  participant E as Session Engine
  participant S as SessionStore
  participant B as Brain (patient/examiner)

  A->>UI: types "Do you cough anything up?"
  UI->>API: { utterance }
  API->>S: load session state
  API->>E: turn(state, utterance)
  E->>E: clock check (nudges? 10:00/17:00 warning? 20:00 stop?)
  E->>E: intent detection (phase transition? exam step? test order?)
  E->>E: 🔒 DISCLOSURE GATE — match utterance vs each onAsk fact's triggers<br/>newly triggered: hx-sputum → add to revealedFactIds
  E->>B: patientTurn(persona + ONLY volunteered+revealed facts)
  Note over B: mock: template reply, $0<br/>live 💰: haiku-4-5, system prompt cached<br/>(turn 2+ reads cache at 10% price)
  B-->>E: "Yes doctor, yellow phlegm... twice there was blood."
  E->>E: examiner due? (bank trigger by phase/elapsed, or student addressed examiner)
  E->>S: persist transcript + revealedFactIds + orderedInvestigations (every turn → quit/resume safe)
  E-->>API: replies [{speaker, text}] + phase/timer view
  API-->>UI: render patient bubble (+ examiner bubble if triggered)
```

---

## 3. End of station — marking

One API call per session (💰 the priciest single call, ~$0.05–0.08), anchored to the checklist — never vibes.

```mermaid
sequenceDiagram
  actor A as Azra
  participant UI as Station UI
  participant API as POST /api/session/:id/end
  participant E as Engine
  participant B as Brain.mark
  participant S as SessionStore

  A->>UI: "End & mark now" (or timer hits 20:00)
  UI->>API: { mode: "mark" }
  API->>E: finalize(state)
  E->>B: mark(transcript + case JSON + tracked logs<br/>revealedFactIds, orderedInvestigations, askedExaminerQIds)
  Note over B: mock: deterministic scoring from logs, $0<br/>live 💰: sonnet-5, structured output = schema-guaranteed MarkingReport
  B-->>E: MarkingReport (checklist done/partial/missed + evidence quotes,<br/>critical flags, viva grades 0–2, domain scores → /100 + band,<br/>3 strengths, 3 fixes, full model station)
  E->>S: persist report under session
  API-->>UI: render report (print stylesheet → PDF)
```

---

## 4. Knowledge pipeline — her notes become examiners

**This answers the upload question: yes.** New notes (md preferred, pdf accepted — including AI-generated ones) enter here. Today stages A–B run as a CLI; Phase 6 adds the in-app upload UI that calls the *same* `lib/kb-pipeline/` code, so nothing is rebuilt.

```mermaid
flowchart TD
  N1["Her notes / handbooks<br/>(.md, .pdf — dropped in /grounding,<br/>Phase 6: uploaded in-app)"] --> A
  subgraph "Stage A — ingest (free, deterministic)"
    A["split into sections by headings<br/>normalize → grounding/normalized/<br/>manifest.json: sha256 → outputs<br/>(re-runs skip unchanged files)"]
  end
  A --> B
  subgraph "Stage B — distill 💰 (~$0.10/topic, one-time)"
    B["one sonnet-5 call per section →<br/>grounding/kb/topic.md<br/>framework · differentials · red flags ·<br/>'Her notes emphasise' (weighted!) <br/>+ _index.json"]
  end
  B --> C
  subgraph "Stage C — case generation 💰 (~$0.06/case, one-time)"
    C["code picks target diagnosis →<br/>sonnet-5 + structured outputs →<br/>Zod-validated case JSON"]
  end
  C --> D["cases/drafts/*.json"]
  D --> R{"/admin/review<br/>👩‍⚕️ human gate — you & Azra"}
  R -->|approve| BANK["cases/bank/ → playable in /session"]
  R -->|reject| X["deleted"]
  ABG["ABG stations: values computed & validated<br/>in code (Henderson-Hasselbalch, Winter's) —<br/>LLM only wraps them 💰(small)"] --> D
```

Key properties: **incremental** (only new/changed notes are processed — money is never spent twice), **resumable** (manifest checkpoints after every call), **gated** (nothing reaches Azra without human approval), **private** (raw notes stay on disk, gitignored; only distilled excerpts ride in API calls, which Anthropic does not train on).

---

## 5. Session phases (the exam itself)

```mermaid
stateDiagram-v2
  [*] --> intro
  intro --> history: opening line
  history --> examination: "I'd like to examine..."
  examination --> differentials: "my differential is..."
  differentials --> investigations: "I'd like to order..."
  investigations --> management: "my management plan..."
  investigations --> interpretStep: ordered test has stimulusRef
  interpretStep --> investigations: interpretation committed
  management --> wrap: 20:00 or student concludes
  wrap --> [*]: marking runs

  note right of history
    examiner nudges if >8 min here
    warnings at 10:00 and 17:00
    hard stop at 20:00
  end note
```

Interpretation stations (ABG/ECG/CXR) run the shorter `present → interpret → probe → wrap` machine with a 7:00 timer.

---

## 6. Voice turn (Phase 3 — next to build)

Push-to-talk wraps the *existing* text turn; nothing in §2 changes. The browser never sees the Azure key — it gets a ~10-minute token.

```mermaid
sequenceDiagram
  actor A as Azra
  participant UI as Station UI
  participant TOK as /api/speech/token
  participant AZ as Azure Speech (eastus)
  participant API as /api/session/:id/turn

  UI->>TOK: on load (authed)
  TOK->>AZ: exchange server key
  AZ-->>TOK: short-lived token
  TOK-->>UI: token (~10 min, auto-refresh)
  A->>UI: holds SPACE, speaks
  UI->>AZ: audio stream (STT, live partial captions)
  AZ-->>UI: final transcript
  UI->>API: { utterance } — same flow as §2
  API-->>UI: replies [{speaker, text}]
  UI->>AZ: TTS — patient=en-ZA-Leah, examiner=en-ZA-Luke
  AZ-->>A: 🔊 spoken reply (3D model bobs on speaking events — Phase 4)
```

---

## 7. Where the money goes

| Step | Model | When | Cost |
|---|---|---|---|
| Distill a KB topic | sonnet-5 | once per topic | ~$0.10 |
| Generate a case | sonnet-5 (structured, no thinking) | once per case | ~$0.06 |
| Patient turn | haiku-4-5 (cached) | per turn, live sessions | ~$0.002 |
| Examiner follow-up | sonnet-5 | few per session | ~$0.01 |
| Marking report | sonnet-5 (structured) | once per session | ~$0.05–0.08 |
| **Full 20-min live station** | | | **≈ $0.10–0.15** |
| Mock station, review UI, timers, ABG math, ingest | — | always | $0 |

Azure Speech (Phase 3): F0 free tier = 5h STT + 0.5M TTS chars/month; beyond that ~$1/h.
