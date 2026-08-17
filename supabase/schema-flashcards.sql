-- St Mungo's flashcards (docs/FLASHCARDS.md §4). Run once in the Supabase SQL
-- editor; safe to re-run (idempotent).
--
-- Access model: server-only. Every table has RLS ENABLED with NO policies —
-- the sb_secret_ (service) key bypasses RLS from the API routes, and the
-- publishable key can never read her cards. Same pattern as st_sessions in
-- supabase/schema.sql.
--
-- Storage: the raw uploads live in a PRIVATE Storage bucket named
-- "flashcards". Create it once in the dashboard: Storage → New bucket →
-- name "flashcards" → leave "Public bucket" OFF → Create. No storage
-- policies are needed (the server uses the secret key).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- documents: one row per upload; job state + pipeline checkpoint live here
-- ---------------------------------------------------------------------------
create table if not exists fc_documents (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  mime text not null default '',
  size_bytes bigint not null default 0,
  status text not null default 'uploaded'
    check (status in ('uploaded','surveying','extracting','reconciling','ready','failed')),
  -- { "done": n, "total": m } — extraction window progress
  progress jsonb not null default '{"done":0,"total":0}'::jsonb,
  layout text
    check (layout is null or layout in ('inline-qa','answer-key','notes-only','mixed')),
  -- survey section map (title + page range per section)
  toc jsonb,
  -- pipeline checkpoint (survey result, window plan, pending orphans, stats) —
  -- a killed job resumes from progress.done using this
  checkpoint jsonb,
  page_count int,
  card_count int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- sections: the survey's chapter/topic map, for browsing decks by section
-- ---------------------------------------------------------------------------
create table if not exists fc_sections (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references fc_documents(id) on delete cascade,
  title text not null,
  ord int not null default 0,
  page_start int,
  page_end int
);

-- ---------------------------------------------------------------------------
-- cards
-- ---------------------------------------------------------------------------
create table if not exists fc_cards (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references fc_documents(id) on delete cascade,
  section_id uuid references fc_sections(id) on delete set null,
  topic text not null default '',
  -- the governing vignette/case stem, verbatim; '' when the question stands
  -- alone. FRONT-of-card content — a card must be answerable from
  -- context + question alone (docs/FLASHCARDS.md §5.5)
  context text not null default '',
  -- shared by every sub-question of one vignette, so siblings schedule together
  group_id text,
  question text not null,
  -- MCQ options (jsonb string array), kept on the card front; '[]' = open question
  options jsonb not null default '[]'::jsonb,
  answer text not null default '',
  qnum text,
  source_pages int[] not null default '{}',
  confidence real,
  status text not null default 'auto' check (status in ('auto','needs_review')),
  -- normalized (context + question) hash: the cross-window dedupe key, unique
  -- per document. Context is part of the identity — "What is the diagnosis?"
  -- under two vignettes is two cards, not one.
  qhash text not null,
  created_at timestamptz not null default now(),
  -- full-text search over topic + context + question + answer
  -- (docs/FLASHCARDS.md §4) — including context so a card is findable by its
  -- vignette ("the 45-year-old with the barrel chest")
  tsv tsvector generated always as (
    to_tsvector('english'::regconfig,
      coalesce(topic, '') || ' ' || coalesce(context, '') || ' ' ||
      coalesce(question, '') || ' ' || coalesce(answer, ''))
  ) stored,
  unique (document_id, qhash)
);

-- ---------------------------------------------------------------------------
-- migration for databases created before the self-containment work. This file
-- has already been run once, so everything below has to be safe to re-run.
-- ---------------------------------------------------------------------------
alter table fc_cards add column if not exists context text not null default '';
alter table fc_cards add column if not exists group_id text;

-- A generated column's expression cannot be ALTERed in place, so the tsvector
-- is dropped and rebuilt — but only when it doesn't already cover `context`,
-- otherwise a re-run would needlessly reindex every card.
do $$
declare tsv_expr text;
begin
  select pg_get_expr(d.adbin, d.adrelid) into tsv_expr
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'fc_cards'::regclass and a.attname = 'tsv';

  if tsv_expr is null or position('context' in tsv_expr) = 0 then
    alter table fc_cards drop column if exists tsv;
    alter table fc_cards add column tsv tsvector generated always as (
      to_tsvector('english'::regconfig,
        coalesce(topic, '') || ' ' || coalesce(context, '') || ' ' ||
        coalesce(question, '') || ' ' || coalesce(answer, ''))
    ) stored;
    -- dropping the column dropped its index with it
    create index if not exists fc_cards_tsv_idx on fc_cards using gin (tsv);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- reviews: FSRS state, one row per studied card (absent row = new card)
-- ---------------------------------------------------------------------------
create table if not exists fc_reviews (
  card_id uuid primary key references fc_cards(id) on delete cascade,
  due_at timestamptz not null default now(),
  stability real not null default 0,
  difficulty real not null default 0,
  reps int not null default 0,
  lapses int not null default 0,
  state text not null default 'New'
    check (state in ('New','Learning','Review','Relearning')),
  scheduled_days int not null default 0,
  learning_steps int not null default 0,
  last_grade text check (last_grade is null or last_grade in ('again','hard','good','easy')),
  last_reviewed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- indexes
-- ---------------------------------------------------------------------------
create index if not exists fc_documents_created_idx on fc_documents (created_at desc);
create index if not exists fc_sections_document_idx on fc_sections (document_id, ord);
create index if not exists fc_cards_document_idx on fc_cards (document_id);
create index if not exists fc_cards_topic_idx on fc_cards (topic);
create index if not exists fc_cards_status_idx on fc_cards (status);
-- sub-questions of one vignette are fetched and scheduled as a block
create index if not exists fc_cards_group_idx on fc_cards (group_id);
create index if not exists fc_cards_tsv_idx on fc_cards using gin (tsv);
create index if not exists fc_reviews_due_idx on fc_reviews (due_at);

-- ---------------------------------------------------------------------------
-- RLS: enabled, deliberately NO policies (server-only via the secret key)
-- ---------------------------------------------------------------------------
alter table fc_documents enable row level security;
alter table fc_sections enable row level security;
alter table fc_cards enable row level security;
alter table fc_reviews enable row level security;

-- Idempotence guard: if any earlier run ever added policies, remove them so
-- the publishable key stays locked out.
drop policy if exists fc_documents_all on fc_documents;
drop policy if exists fc_sections_all on fc_sections;
drop policy if exists fc_cards_all on fc_cards;
drop policy if exists fc_reviews_all on fc_reviews;
