-- ============================================================================
-- HONOUR MARKS — SCHEMA v1
-- Paste into Supabase Dashboard -> SQL Editor -> Run. Safe to re-run.
-- Shares a database with Heimdall: `pending_rank_xp` and `clan_members` are
-- Heimdall's tables. This file creates everything else and only ever ALTERs
-- what it must.
-- ============================================================================

-- 1. Per-guild config. Message IDs MUST be keyed by guild + channel, otherwise
--    two servers fight over the same panel message.
create table if not exists public.bot_config (
  guild_id   text not null,
  key        text not null,
  value      text,
  updated_at timestamptz not null default now(),
  primary key (guild_id, key)
);

-- 2. Member identity: Discord user <-> RuneScape name
create table if not exists public.hm_members (
  user_id      text primary key,
  guild_id     text not null,
  rsn          text,
  display_name text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists uq_hm_members_rsn
  on public.hm_members (guild_id, lower(rsn)) where rsn is not null;

-- 3. Balances
create table if not exists public.hm_balances (
  user_id         text primary key,
  guild_id        text not null,
  balance         integer not null default 0 check (balance >= 0),
  total_earned    bigint  not null default 0,
  total_spent     bigint  not null default 0,
  double_hm_until timestamptz,
  updated_at      timestamptz not null default now()
);

-- 4. Ledger — append only. `idempotency_key` is what stops a double award.
create table if not exists public.hm_transactions (
  id              bigserial primary key,
  guild_id        text not null,
  user_id         text not null,
  delta           integer not null,
  balance_after   integer,
  kind            text not null,
  reason          text,
  ref_id          text,
  idempotency_key text unique,
  created_at      timestamptz not null default now()
);

create index if not exists idx_hm_tx_user  on public.hm_transactions (user_id, created_at desc);
create index if not exists idx_hm_tx_guild on public.hm_transactions (guild_id, created_at desc);

-- 5. Active solo quests — one per type per member.
create table if not exists public.hm_quests (
  id              bigserial primary key,
  guild_id        text not null,
  user_id         text not null,
  quest_type      text not null check (quest_type in ('daily','weekly','monthly')),
  tree            text not null,
  difficulty      text not null default 'easy',
  targets         jsonb not null default '{}'::jsonb,
  baseline        jsonb not null default '{}'::jsonb,
  hm_reward       integer not null default 0,
  rank_xp_reward  integer not null default 0,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);

create unique index if not exists uq_hm_quests_slot
  on public.hm_quests (guild_id, user_id, quest_type);
create index if not exists idx_hm_quests_expiry on public.hm_quests (expires_at);

-- 6. Active party quests (duo / trio / quad)
create table if not exists public.hm_party_quests (
  id              bigserial primary key,
  guild_id        text not null,
  tree            text not null,
  size            text not null check (size in ('duo','trio','quad')),
  difficulty      text not null default 'easy',
  members         text[] not null,
  targets         jsonb not null default '{}'::jsonb,
  baseline        jsonb not null default '{}'::jsonb,
  hm_reward       integer not null default 0,
  rank_xp_reward  integer not null default 0,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index if not exists idx_hm_party_expiry  on public.hm_party_quests (expires_at);
create index if not exists idx_hm_party_members on public.hm_party_quests using gin (members);

-- 7. Looking-for-group board
create table if not exists public.hm_lfg_posts (
  id         bigserial primary key,
  guild_id   text not null,
  poster_id  text not null,
  team_size  text not null check (team_size in ('duo','trio','quad')),
  categories text[] not null default '{}',
  members    text[] not null default '{}',
  -- The poster's hand-picked shared target (a Quest Choice Token spent at
  -- post time), stored up front so anyone browsing the board can see it
  -- before joining. Null means "not hand-picked, rolls at random when the
  -- listing fills."
  picks      jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_hm_lfg_poster
  on public.hm_lfg_posts (guild_id, poster_id);

-- Safety net for a database that already ran an older copy of this file
-- before `picks` existed.
alter table public.hm_lfg_posts
  add column if not exists picks jsonb;

-- 8. Reset counters (fast path for the quest board + per-member caps)
create table if not exists public.hm_quest_counts (
  user_id         text primary key,
  guild_id        text not null,
  total_completed integer not null default 0,
  daily_used      integer not null default 0,
  daily_reset     date,
  weekly_used     integer not null default 0,
  weekly_reset    date,
  monthly_used    integer not null default 0,
  monthly_reset   date,
  solo_daily      integer not null default 0,
  solo_weekly     integer not null default 0,
  solo_monthly    integer not null default 0,
  duo             integer not null default 0,
  trio            integer not null default 0,
  quad            integer not null default 0,
  updated_at      timestamptz not null default now()
);

-- 9. Solo completion history (authoritative)
create table if not exists public.hm_quest_completions (
  id               bigserial primary key,
  guild_id         text not null,
  user_id          text not null,
  quest_type       text not null,
  tree             text not null,
  difficulty       text,
  hm_awarded       integer not null default 0,
  rank_xp_awarded  integer not null default 0,
  progress_pct     numeric(5,2) not null default 100,
  created_at       timestamptz not null default now()
);

create index if not exists idx_hm_qc_user    on public.hm_quest_completions (user_id);
create index if not exists idx_hm_qc_created on public.hm_quest_completions (created_at desc);

-- 10. Party completion history — one row per team, attributed to every member
create table if not exists public.hm_party_quest_completions (
  id                 bigserial primary key,
  guild_id           text not null,
  quest_id           bigint,
  members            text[] not null,
  size               text not null,
  tree               text not null,
  difficulty         text,
  completed          boolean not null default true,
  hm_awarded         integer not null default 0,
  rank_xp_awarded    integer not null default 0,
  -- Per-member Rank XP: { "<user_id>": <amount actually queued for them> }.
  -- Needed because each member can have a DIFFERENT active Boost for this
  -- quest's category, so they are no longer all paid the same amount —
  -- `rank_xp_awarded` above is just the sum, kept for a quick total.
  rank_xp_breakdown  jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Safety net for a database that already ran an older copy of this file
-- before `rank_xp_breakdown` existed.
alter table public.hm_party_quest_completions
  add column if not exists rank_xp_breakdown jsonb not null default '{}'::jsonb;

create index if not exists idx_hm_pqc_members on public.hm_party_quest_completions using gin (members);

-- 11. Shop ownership
create table if not exists public.hm_perks (
  user_id    text not null,
  guild_id   text not null,
  tree       text not null,
  tier       integer not null default 0 check (tier between 0 and 5),
  updated_at timestamptz not null default now(),
  primary key (user_id, tree)
);

-- This table predates the Items shop tier going live and was carried over
-- unused. Its `slot` values keep their original column names for zero
-- migration cost, but two of the three now mean something different from
-- what the name suggests — no ALTER needed, this is purely a semantic note
-- for anyone reading the schema cold:
--   'quest_reduction' -> Slot 1, Quest & Threshold Reduction (name still matches: unchanged)
--   'hm_bonus'        -> Slot 2, Clan Chat XP Bonus (renamed in product; this slot now
--                         boosts RANK XP, not HM, despite the column value's name)
--   'boost_length'     -> Slot 3, Quest Expansion (an entirely new mechanic reusing
--                         this otherwise-dead enum value)
-- See src/quests.js's ITEM_SLOT map for the single source of truth tying
-- these raw strings back to their current meaning.
create table if not exists public.hm_items (
  user_id    text not null,
  guild_id   text not null,
  tree       text not null,
  slot       text not null check (slot in ('quest_reduction','hm_bonus','boost_length')),
  tier       integer not null default 0 check (tier between 0 and 3),
  updated_at timestamptz not null default now(),
  primary key (user_id, tree, slot)
);

create table if not exists public.hm_inventory (
  id         bigserial primary key,
  user_id    text not null,
  guild_id   text not null,
  tree       text not null,
  boost_tier integer not null default 0,
  quantity   integer not null default 0 check (quantity >= 0),
  unique (user_id, tree, boost_tier)
);

create table if not exists public.hm_active_boosts (
  id         bigserial primary key,
  user_id    text not null,
  guild_id   text not null,
  tree       text not null,
  multiplier numeric(4,2) not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_hm_ab_user on public.hm_active_boosts (user_id, tree, expires_at desc);

create table if not exists public.hm_tutorial_progress (
  user_id            text primary key,
  guild_id           text not null,
  completed_chapters text[] not null default '{}',
  completed_at       timestamptz,
  reward_given       boolean not null default false
);

-- 12. PANEL LEDGER — how the character limit is solved.
--     A panel renders as N pages. This records which message is which page, so
--     a refresh edits pages in place, posts any missing, and deletes surplus.
create table if not exists public.hm_panels (
  guild_id   text not null,
  channel_id text not null,
  panel_key  text not null,
  page_index integer not null default 0,
  message_id text not null,
  updated_at timestamptz not null default now(),
  primary key (guild_id, panel_key, page_index)
);

-- 13. Audit log
create table if not exists public.hm_audit_log (
  id         bigserial primary key,
  guild_id   text not null,
  kind       text not null,
  actor_id   text,
  subject_id text,
  amount     integer not null default 0,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_hm_al_guild on public.hm_audit_log (guild_id, created_at desc);

-- 14. RANK XP RULES — the tuning table. Flat XP only: multiplier_source is
--     'none' everywhere, because tenure is the only stream with a multiplier.
create table if not exists public.hm_rank_xp_rules (
  guild_id  text not null,
  event_key text not null,
  xp        integer not null default 0,
  enabled   boolean not null default true,
  note      text,
  updated_at timestamptz not null default now(),
  primary key (guild_id, event_key)
);

insert into public.hm_rank_xp_rules (guild_id, event_key, xp, note) values
  ('default','quest_solo_daily',   100, 'Scenario C — thin trickle, keeps Legacy near 21 months'),
  ('default','quest_solo_weekly',  250, ''),
  ('default','quest_solo_monthly', 750, ''),
  ('default','quest_party_duo',    750, ''),
  ('default','quest_party_trio',  1200, ''),
  ('default','quest_party_quad',  2000, ''),
  ('default','tutorial_complete',  500, 'one-time')
on conflict (guild_id, event_key) do nothing;

-- 15. Database-channel read model: one row per member, every quest type + HM.
--     Created with drop/create so a re-run always picks up column changes.
drop view if exists public.hm_member_totals;
create view public.hm_member_totals as
with solo as (
  select user_id,
         count(*)                                     as solo_total,
         count(*) filter (where quest_type = 'daily')   as solo_daily,
         count(*) filter (where quest_type = 'weekly')  as solo_weekly,
         count(*) filter (where quest_type = 'monthly') as solo_monthly,
         coalesce(sum(hm_awarded), 0)                 as solo_hm,
         coalesce(sum(rank_xp_awarded), 0)            as solo_rank_xp
  from public.hm_quest_completions group by user_id
),
party as (
  -- Every member of a party was paid the same HM (the reward was always a
  -- flat amount per member), but — since Boosts went live — NOT necessarily
  -- the same Rank XP, so Rank XP is read per member out of the breakdown
  -- instead of assuming everyone got the row's shared total.
  select m as user_id,
         count(*) filter (where size = 'duo'  and completed) as duo,
         count(*) filter (where size = 'trio' and completed) as trio,
         count(*) filter (where size = 'quad' and completed) as quad,
         coalesce(sum(hm_awarded), 0)                                       as party_hm,
         coalesce(sum(coalesce((rank_xp_breakdown ->> m)::numeric, 0)), 0)  as party_rank_xp
  from public.hm_party_quest_completions, unnest(members) as m
  group by m
)
select
  mem.user_id,
  mem.guild_id,
  mem.rsn,
  mem.display_name,
  coalesce(b.balance, 0)                                   as balance,
  coalesce(b.total_earned, 0)                              as total_earned,
  coalesce(b.total_spent, 0)                               as total_spent,
  coalesce(s.solo_daily, 0)                                as solo_daily,
  coalesce(s.solo_weekly, 0)                               as solo_weekly,
  coalesce(s.solo_monthly, 0)                              as solo_monthly,
  coalesce(p.duo, 0)                                       as duo,
  coalesce(p.trio, 0)                                      as trio,
  coalesce(p.quad, 0)                                      as quad,
  coalesce(s.solo_total, 0) + coalesce(p.duo, 0) + coalesce(p.trio, 0) + coalesce(p.quad, 0)
                                                           as quests_total,
  coalesce(s.solo_hm, 0) + coalesce(p.party_hm, 0)         as hm_from_quests,
  coalesce(s.solo_rank_xp, 0) + coalesce(p.party_rank_xp, 0) as rank_xp_from_quests
from public.hm_members mem
left join public.hm_balances b on b.user_id = mem.user_id
left join solo s               on s.user_id = mem.user_id
left join party p              on p.user_id = mem.user_id;

-- 16. RLS off — the bot uses the service-role key.
do $$
declare t text;
begin
  foreach t in array array[
    'bot_config','hm_members','hm_balances','hm_transactions','hm_quests',
    'hm_party_quests','hm_lfg_posts','hm_quest_counts','hm_quest_completions',
    'hm_party_quest_completions','hm_perks','hm_items','hm_inventory',
    'hm_active_boosts','hm_tutorial_progress','hm_panels','hm_audit_log',
    'hm_rank_xp_rules'
  ] loop
    execute format('alter table public.%I disable row level security', t);
  end loop;
exception when others then null;
end $$;

-- 17. Realtime on the tables the panels watch.
do $$
declare t text;
begin
  foreach t in array array['hm_balances','hm_quests','hm_quest_counts'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
exception when others then null;
end $$;
