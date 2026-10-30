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

-- 1b. SPLIT THE XP STREAMS
--     `xp` is the DISPLAYED / RANK total.
--     `tenure_xp`  = replayed from the join date by Heimdall. The only stream
--                    that applies a multiplier. Safe to recompute any time.
--     `bonus_xp`   = flat Honour Marks quest XP, additive only, never recomputed.
--     The streams never read each other; they are summed only into `xp`.
alter table public.clan_members add column if not exists tenure_xp integer not null default 0;
alter table public.clan_members add column if not exists bonus_xp  integer not null default 0;

-- One-time backfill for rows created before the split: everything they have is
-- tenure, nothing is quest XP.
update public.clan_members
   set tenure_xp = xp,
       bonus_xp  = 0
 where tenure_xp = 0
   and bonus_xp  = 0
   and xp        > 0;

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

-- 3b. RANK XP QUEUE — the one seam between Heimdall and the Honour Marks bot.
--     The HM bot INSERTs here; it never touches clan_members. Heimdall is the
--     sole writer of the ladder, so a quest award can't be silently overwritten
--     by the tenure replay.
--
--     `idempotency_key` makes a retried insert a no-op.
--     `consumed_at` + the conditional claim in Heimdall prevent double credits
--     when the 30-minute timer and a Realtime nudge overlap.
--     `attempts` lets an unresolvable row (RSN not on the roster yet) sink to
--     the back of the queue instead of blocking it forever.
create table if not exists public.pending_rank_xp (
  id              bigserial primary key,
  guild_id        text,
  user_id         text,
  rsn             text,
  amount          integer not null check (amount > 0),
  reason          text,
  event_key       text,
  idempotency_key text unique,
  attempts        integer not null default 0,
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  consumed_at     timestamptz,
  consumed_by     text
);

-- Safety net for a database that already has an OLDER `pending_rank_xp` from
-- before these columns existed: `create table if not exists` is a no-op on a
-- table that already exists, so without this, the indexes below would fail
-- with "column does not exist" on a partially-migrated database. Every
-- column this table needs is listed explicitly, so this file is safe to
-- paste and re-run regardless of what state the table was already in.
alter table public.pending_rank_xp add column if not exists guild_id        text;
alter table public.pending_rank_xp add column if not exists user_id        text;
alter table public.pending_rank_xp add column if not exists rsn            text;
alter table public.pending_rank_xp add column if not exists reason         text;
alter table public.pending_rank_xp add column if not exists event_key      text;
alter table public.pending_rank_xp add column if not exists idempotency_key text;
alter table public.pending_rank_xp add column if not exists attempts       integer not null default 0;
alter table public.pending_rank_xp add column if not exists last_attempt_at timestamptz;
alter table public.pending_rank_xp add column if not exists created_at     timestamptz not null default now();
alter table public.pending_rank_xp add column if not exists consumed_at    timestamptz;
alter table public.pending_rank_xp add column if not exists consumed_by    text;
alter table public.pending_rank_xp alter column user_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pending_rank_xp_idempotency_key_key'
  ) then
    alter table public.pending_rank_xp add constraint pending_rank_xp_idempotency_key_key unique (idempotency_key);
  end if;
exception
  when duplicate_object then null;
  when others then null;
end $$;

create index if not exists idx_pending_rank_xp_open
  on public.pending_rank_xp (attempts asc, created_at asc)
  where consumed_at is null;

create index if not exists idx_pending_rank_xp_rsn
  on public.pending_rank_xp (lower(rsn))
  where consumed_at is null;

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

-- 6. Weekly HiScores Snapshot & Recap — one row per clan member per recap week
--    (week_key = the Sunday the snapshot was taken, e.g. '2026-11-01'). Stores
--    the full skills/activities hiscores plus Rank XP at snapshot time so the
--    bot can diff this week's row against the previous week's to build the
--    Sunday 5pm Central recap embed (top XP gainers, PvMers, raiders, etc.).
create table if not exists public.weekly_recap_snapshots (
  id          bigserial primary key,
  week_key    text not null,
  rsn         text not null,
  skills      jsonb not null default '{}'::jsonb,     -- { "Attack": 12345, ... } xp per skill
  activities  jsonb not null default '{}'::jsonb,     -- { "Zulrah": 120, "Chambers of Xeric": 45, ... } kc/score per activity
  rank_xp     integer not null default 0,              -- clan_members.xp at snapshot time
  captured_at timestamptz not null default now(),
  unique (week_key, rsn)
);

create index if not exists idx_weekly_recap_snapshots_week on public.weekly_recap_snapshots (week_key);

-- Disable RLS so the bot can read/write freely
alter table public.clan_members disable row level security;
alter table public.roster_upload disable row level security;
alter table public.xp_rank_logs disable row level security;
alter table public.clan_growth_history disable row level security;
alter table public.weekly_events disable row level security;
alter table public.pending_rank_xp disable row level security;
alter table public.weekly_recap_snapshots disable row level security;

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

  -- Lets Heimdall react to a quest award in seconds instead of waiting for the
  -- next 30-minute sync.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pending_rank_xp'
  ) then
    alter publication supabase_realtime add table public.pending_rank_xp;
  end if;
exception
  when others then
    null;
end $$;
