-- ============================================================================
-- HEIMDALL — CLAN RANKING SYSTEM SUPABASE SCHEMA
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

-- 2. Staging table for easy CSV uploads from in-game clan list exports
--    To update your roster:
--      In Supabase Table Editor -> select `roster_upload` -> "Import data from CSV"
--      Your CSV only needs two columns: `rsn` and `joined_date` (e.g. 2025-10-18 or 18-Oct-2025).
--      Heimdall automatically detects rows in `roster_upload`, adds new members,
--      updates existing members, marks missing members as having left the clan,
--      and clears `roster_upload` for your next import.
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

-- 4. Enable Realtime on clan_members and roster_upload so Heimdall updates immediately
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
exception
  when others then
    null;
end $$;
