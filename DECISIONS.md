# Decisions

- **2026-08-12 · Name: St Mungo's** — the wizarding hospital; she's training to be a Healer. Subdomain of accioazra.com.
- **2026-08-12 · Examiner/marking/case-gen model: `claude-sonnet-5`** (brief said sonnet-4-6; Sonnet 5 is newer, same tier, intro-priced $2/$10 per MTok through 2026-08-31 — the exact build window). Patient stays `claude-haiku-4-5`.
- **2026-08-12 · Disclosure is engine-gated, not prompt-trusted**: the session engine matches student utterances against fact `triggers` and injects only volunteered + already-triggered facts into the patient model's context. The patient cannot leak what it never saw; prompt rules remain as defense-in-depth. Trigger lists are generated deliberately fat (synonyms, lay phrasings).
- **2026-08-12 · Persistence: dedicated Supabase project** (not the Teapot's) — different trust model (APP_ACCESS_PASSWORD gate + service-role from API routes vs two-user RLS). Until the project exists, the store port has a local JSON-file adapter so dev is unblocked.
- **2026-08-12 · KB pipeline runs as local CLI for Phases 1/5** (no serverless limits, incremental via manifest); the same `lib/kb-pipeline/` runs as a background job for Phase 6 uploads.
- **2026-08-12 · Package manager: pnpm.** Haiku prompt-cache note: Haiku 4.5 minimum cacheable prefix is 4096 tokens — patient system prompt (persona + case) must clear it, verify `cache_read_input_tokens > 0` in dev.
- **2026-08-12 · /grounding is gitignored entirely** (her private course material). The distilled KB's storage is Supabase (runtime-updatable, §5d); repo keeps only pipeline code.
