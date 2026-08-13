-- St Mungo's session persistence (STORE=supabase).
-- Run in the Supabase SQL editor.
--
-- Access model: only the server's secret key touches this table (API routes,
-- server-only). No RLS policies are added because no anon/publishable key is
-- ever used against it; keep it locked down by leaving RLS enabled with no
-- policies.

create table if not exists st_sessions (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table st_sessions enable row level security;

create index if not exists st_sessions_updated_at_idx on st_sessions (updated_at desc);
