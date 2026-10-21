-- ============================================================================
-- HEIMDALL — CLAN RANKING & GROWTH CHART SUPABASE SCHEMA
-- Paste this entire file into your Supabase Dashboard -> SQL Editor -> Run.
-- ============================================================================

-- 1. Main table storing all clan members and their tenure / XP / rank state
create table if not exists public.clan_members (
  id bigserial primary key,
  rsn text not null unique,
  joined_date date not null,
  active boolean not null default true,
  xp integer not null default 0,
  eligible_rank text not null default 'Bronze',
  confirmed_rank text not null default 'Bronze',
  weeks_awarded integer not null default 0,
  months_awarded integer not null default 0,
  years_awarded integer not null default 0,
  pending_alert_message_id text,
  pending_alert_type text,
  left_at timestamptz,
  left_logged boolean not null default false,
  left_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_clan_members_active on public.clan_members (active);
create index if not exists idx_clan_members_xp on public.clan_members (xp desc);

-- Clamp any join date earlier than Clan Creation Date (2026-10-11)
create or replace function public.clamp_clan_creation_date()
returns trigger
language plpgsql
as $$
begin
  if new.joined_date < date '2026-10-11' then
    new.joined_date := date '2026-10-11';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_clamp_clan_creation_date on public.clan_members;
create trigger trg_clamp_clan_creation_date
before insert or update on public.clan_members
for each row
execute function public.clamp_clan_creation_date();

-- 2. Staging table for easy CSV uploads from in-game clan list exports
create table if not exists public.roster_upload (
  id bigserial primary key,
  rsn text not null,
  joined_date text not null,
  uploaded_at timestamptz not null default now()
);

-- 3. Audit log table for XP awards, rank-ups, and clan departures
create table if not exists public.xp_rank_logs (
  id bigserial primary key,
  rsn text not null,
  event_type text not null, -- 'xp_award' | 'rank_up' | 'member_left' | 'member_left_confirmed'
  xp_delta integer not null default 0,
  total_xp integer not null default 0,
  old_rank text,
  new_rank text,
  reason text,
  staff_user_id text,
  staff_user_tag text,
  created_at timestamptz not null default now()
);

create index if not exists idx_xp_rank_logs_rsn on public.xp_rank_logs (rsn);
create index if not exists idx_xp_rank_logs_created_at on public.xp_rank_logs (created_at desc);

-- 4. Dated Clan Growth History table (tracks member count & net change over time)
create table if not exists public.clan_growth_history (
  id bigserial primary key,
  recorded_date date not null unique,
  active_members integer not null default 0,
  members_joined integer not null default 0,
  members_left integer not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_clan_growth_history_date on public.clan_growth_history (recorded_date asc);

-- 5. Weekly Events (Skill of the Week & Boss of the Week) state & baselines
create table if not exists public.weekly_events (
  week_key text primary key,
  week_index integer not null,
  event_type text not null, -- 'sotw' | 'botw'
  target_name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  baselines jsonb not null default '{}'::jsonb,
  standings jsonb not null default '[]'::jsonb,
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Disable RLS so the bot can read/write freely
alter table public.clan_members disable row level security;
alter table public.roster_upload disable row level security;
alter table public.xp_rank_logs disable row level security;
alter table public.clan_growth_history disable row level security;
alter table public.weekly_events disable row level security;

-- 5. Enable Realtime on clan_members, roster_upload, and clan_growth_history
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'clan_members'
  ) then
    alter publication supabase_realtime add table public.clan_members;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'roster_upload'
  ) then
    alter publication supabase_realtime add table public.roster_upload;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'clan_growth_history'
  ) then
    alter publication supabase_realtime add table public.clan_growth_history;
  end if;
exception
  when others then
    null;
end $$;
