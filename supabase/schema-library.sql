-- St Mungo's — LIBRARY schema (Phase 6: self-serve, production-autonomous).
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- What this replaces: until now the KB lived in grounding/kb/*.md and cases in
-- cases/{drafts,bank}/*.json on Nadeem's laptop, so uploading a guide,
-- generating a station and approving it were all local-only operations and
-- production could merely REPLAY whatever had been committed to git. These four
-- tables move all of that server-side.
--
-- Security model matches the rest of the app: RLS is ON with NO policies, so the
-- anon/publishable key can read nothing at all. Every access goes through the
-- server using SUPABASE_SECRET_KEY, behind the app's password cookie.

-- ---------------------------------------------------------------------------
-- 1. Source documents — her uploaded study guides (the raw material)

create table if not exists st_source_docs (
  id           text primary key,
  filename     text        not null,
  mime         text        not null,
  size_bytes   bigint      not null default 0,
  -- Path inside the private "grounding" Storage bucket. Null once purged.
  storage_path text,
  -- uploaded -> extracting -> distilling -> ready | failed
  status       text        not null default 'uploaded',
  done_steps   int         not null default 0,
  total_steps  int         not null default 0,
  -- Resume point: extracted text, chunk plan, per-chunk results so far.
  checkpoint   jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists st_source_docs_status_idx on st_source_docs (status);
create index if not exists st_source_docs_created_idx on st_source_docs (created_at desc);

-- ---------------------------------------------------------------------------
-- 2. KB topics — the distilled, exam-relevant essence of those guides.
--    This is what grounds case generation (one topic in, one station out).

create table if not exists st_kb_topics (
  slug        text primary key,
  title       text        not null,
  -- resp | cardio | gi-hep | endo | neuro | renal | haem | id | rheum | other
  system      text        not null default 'other',
  content     text        not null,
  -- Provenance: which upload produced this, and which pages.
  source_doc  text        references st_source_docs (id) on delete set null,
  source_ref  text,
  token_count int         not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists st_kb_topics_system_idx on st_kb_topics (system);

-- Full-text search over title + content, so keyword lookup during generation
-- is a real query rather than a filename match (the file store's approach).
alter table st_kb_topics
  add column if not exists tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) stored;

create index if not exists st_kb_topics_tsv_idx on st_kb_topics using gin (tsv);

-- ---------------------------------------------------------------------------
-- 3. Cases — drafts AND the approved bank, in one table with a status column.
--    The review gate becomes an UPDATE instead of a filesystem rename, which is
--    the specific reason /admin/review could never work on Vercel.

create table if not exists st_cases (
  id           text primary key,
  -- draft = awaiting review · bank = approved, playable · rejected = kept for
  -- the audit trail rather than deleted, so a bad generation run is traceable.
  status       text        not null default 'draft',
  station_type text        not null,
  discipline   text        not null,
  diagnosis    text        not null,
  commonness   text        not null default 'common',
  difficulty   int         not null default 3,
  -- The whole OsceCase JSON. Validated against OsceCaseSchema before insert AND
  -- again on approval — nothing reaches a student without passing the schema.
  data         jsonb       not null,
  kb_source    text,
  review_note  text,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint st_cases_status_check check (status in ('draft', 'bank', 'rejected'))
);

create index if not exists st_cases_status_idx on st_cases (status);
create index if not exists st_cases_discipline_idx on st_cases (discipline, commonness);
-- Dedupe guard mirroring the generator's code-level check.
create unique index if not exists st_cases_diagnosis_idx
  on st_cases (lower(diagnosis))
  where status <> 'rejected';

-- ---------------------------------------------------------------------------
-- 4. Spend ledger — the guardrail. Every model call anywhere in the library
--    pipeline writes one row, so a per-job cap and a monthly ceiling are both
--    plain SQL rather than an honour system.

create table if not exists st_spend (
  id           bigserial primary key,
  job_id       text,
  -- distill | generate-case | survey | extract | reconcile
  kind         text        not null,
  model        text        not null,
  input_tokens int         not null default 0,
  output_tokens int        not null default 0,
  cache_read_tokens int    not null default 0,
  cache_write_tokens int   not null default 0,
  usd          numeric(10, 6) not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists st_spend_job_idx on st_spend (job_id);
create index if not exists st_spend_created_idx on st_spend (created_at desc);

-- Month-to-date spend, for the monthly ceiling check.
create or replace view st_spend_this_month as
  select coalesce(sum(usd), 0)::numeric(10, 6) as usd
  from st_spend
  where created_at >= date_trunc('month', now());

-- ---------------------------------------------------------------------------
-- RLS: on, with no policies. Service role bypasses; everyone else sees nothing.

alter table st_source_docs enable row level security;
alter table st_kb_topics   enable row level security;
alter table st_cases       enable row level security;
alter table st_spend       enable row level security;

drop policy if exists st_source_docs_none on st_source_docs;
drop policy if exists st_kb_topics_none   on st_kb_topics;
drop policy if exists st_cases_none       on st_cases;
drop policy if exists st_spend_none       on st_spend;

-- ---------------------------------------------------------------------------
-- Storage: create a PRIVATE bucket named exactly "grounding" in the dashboard
-- (Storage -> New bucket -> Public OFF). Her course material must never be
-- publicly addressable. No storage policies are needed: the server uses the
-- secret key.
