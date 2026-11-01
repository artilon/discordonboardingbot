"use strict";
const { getSupabase } = require("./db");
const { fetchHiscores, bossKeys } = require("./jagex");
const { BOSS_POOL, MINIGAME_BOSSES } = require("./quests");

/**
 * Clan Pool — one shared monthly quest the whole clan works toward together
 * (a toned-down revival of the original mimir.js Clan Pool concept; rebuilt
 * from scratch for this codebase, see the design discussion for context).
 *
 * Exactly one `hm_clan_quest` row exists per guild at a time. Every
 * REGISTERED member's current total is snapshotted into `baselines` the
 * moment a quest starts; progress is the SUM, across every tracked member,
 * of how much their own total has grown since their own baseline — a member
 * who registers mid-quest is lazily added with their current total the next
 * time progress is checked, so only what they do after that point counts.
 *
 * The moment the target is hit: the quest completes, a coin flip picks one
 * of 2 possible clan-wide reward boosts (both last exactly 1 week — the
 * stated maximum — and a new one REPLACES rather than stacks with whatever
 * was still running), and a brand new quest of a random type starts right
 * away so there is never a gap with no active Clan Pool quest.
 *
 * Target numbers scale up with the clan's registered member count, so the
 * quest stays roughly as grindy-but-achievable as the clan grows instead of
 * staying fixed forever. Every CLAN_MEMBER_THRESHOLD_STEP members past
 * CLAN_MEMBER_THRESHOLD_START (30, 40, 50, ...) is one more "tier", and each
 * tier adds one CLAN_QUEST_TARGET_STEP on top of that category's
 * CLAN_QUEST_BASE_TARGETS. Below 30 members, it's always just the base
 * number. A quest's target is computed ONCE, when it starts, from the member
 * count at that moment — it never changes mid-quest even if membership does.
 */

const CLAN_QUEST_TYPES = ["skill_xp", "boss_kc", "minigame", "quest_completions"];

const CLAN_QUEST_BASE_TARGETS = {
  skill_xp: 1_000_000, // total clan XP gained across all registered members, per month
  boss_kc: 500, // total Boss PvM KC (BOSS_POOL only — raids/minigames have their own category)
  minigame: 300, // total minigame completions (Wintertodt crates, Tempoross, GOTR rifts, etc.)
  quest_completions: 30, // total finished Honour Marks quests (solo + team), clan-wide
};

// How much each category's target rises by, per member-count tier reached.
const CLAN_QUEST_TARGET_STEP = {
  skill_xp: 250_000,
  boss_kc: 25,
  minigame: 25,
  quest_completions: 5,
};

const CLAN_MEMBER_THRESHOLD_START = 30; // first tier bump happens at this many registered members
const CLAN_MEMBER_THRESHOLD_STEP = 10; // then every this-many members after that (40, 50, 60, ...)

/** 0 below 30 members, 1 at 30-39, 2 at 40-49, 3 at 50-59, and so on. */
function clanMemberTier(memberCount) {
  if (!memberCount || memberCount < CLAN_MEMBER_THRESHOLD_START) return 0;
  return Math.floor((memberCount - CLAN_MEMBER_THRESHOLD_START) / CLAN_MEMBER_THRESHOLD_STEP) + 1;
}

/** The actual target for a quest type, given how many members are registered right now. */
function computeClanQuestTarget(questType, memberCount) {
  const tier = clanMemberTier(memberCount);
  const base = CLAN_QUEST_BASE_TARGETS[questType] || 0;
  const step = CLAN_QUEST_TARGET_STEP[questType] || 0;
  return base + tier * step;
}

const CLAN_QUEST_LABELS = {
  skill_xp: "Total Skilling XP",
  boss_kc: "Total Boss PvM KC",
  minigame: "Total Minigame Completions",
  quest_completions: "Total HM Quests Completed",
};

const CLAN_QUEST_EMOJI = {
  skill_xp: "📈",
  boss_kc: "☠️",
  minigame: "🎮",
  quest_completions: "📜",
};

const CLAN_BOOST_KINDS = ["hm_gain", "rank_xp"];
const CLAN_BOOST_PCT = 5;
const CLAN_BOOST_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 1 week — the stated maximum

const CLAN_BOOST_LABELS = {
  hm_gain: `+${CLAN_BOOST_PCT}% HM clan-wide for completing quests`,
  rank_xp: `+${CLAN_BOOST_PCT}% Clan Chat Rank XP clan-wide`,
};

async function getRegisteredMembers(guildId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("hm_members")
    .select("user_id,rsn,active")
    .eq("guild_id", guildId)
    .eq("active", true);
  return data || [];
}

/** Lifetime count of FINISHED (not partial/expired) Honour Marks quests per member. */
async function getLifetimeQuestCompletions(guildId) {
  const supabase = getSupabase();
  const counts = {};
  if (!supabase) return counts;

  const { data: solo } = await supabase
    .from("hm_quest_completions")
    .select("user_id")
    .eq("guild_id", guildId)
    .eq("progress_pct", 100);
  for (const row of solo || []) counts[row.user_id] = (counts[row.user_id] || 0) + 1;

  const { data: party } = await supabase
    .from("hm_party_quest_completions")
    .select("members")
    .eq("guild_id", guildId)
    .eq("completed", true);
  for (const row of party || []) {
    for (const uid of row.members || []) counts[uid] = (counts[uid] || 0) + 1;
  }

  return counts;
}

/** One member's current total for a given Clan Pool category. */
async function currentMemberTotal(questType, member, completionCounts) {
  if (questType === "quest_completions") return completionCounts?.[member.user_id] || 0;
  if (!member.rsn) return 0;

  const snap = await fetchHiscores(member.rsn);
  if (!snap) return 0;

  if (questType === "skill_xp") {
    return Object.values(snap.skills || {}).reduce((sum, s) => sum + (Number(s.experience) || 0), 0);
  }
  if (questType === "boss_kc") {
    return BOSS_POOL.reduce(
      (sum, b) => sum + bossKeys(b).reduce((t, k) => t + (snap.bosses?.[k]?.kills || 0), 0),
      0
    );
  }
  if (questType === "minigame") {
    return MINIGAME_BOSSES.reduce((sum, m) => sum + (snap.bosses?.[m]?.kills || 0), 0);
  }
  return 0;
}

/** Returns the active Clan Pool quest, creating one (random type) if none exists yet. */
async function ensureClanQuest(guildId) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data: existing } = await supabase.from("hm_clan_quest").select("*").eq("guild_id", guildId).maybeSingle();
  if (existing) return existing;

  const questType = CLAN_QUEST_TYPES[Math.floor(Math.random() * CLAN_QUEST_TYPES.length)];
  const members = await getRegisteredMembers(guildId);
  const target = computeClanQuestTarget(questType, members.length);
  const completionCounts = questType === "quest_completions" ? await getLifetimeQuestCompletions(guildId) : null;

  const baselines = {};
  for (const m of members) {
    baselines[m.user_id] = await currentMemberTotal(questType, m, completionCounts);
  }

  const row = { guild_id: guildId, quest_type: questType, target, baselines };
  const { data: inserted } = await supabase
    .from("hm_clan_quest")
    .upsert(row, { onConflict: "guild_id" })
    .select("*")
    .maybeSingle();
  return inserted || row;
}

/**
 * Picks one of the 2 reward boosts by coin flip, logs the completion, starts
 * the (exactly 1 week) clan-wide boost — replacing any still-active one —
 * and clears the quest row so the next check immediately spins up a new one.
 */
async function completeClanQuest(guildId, quest) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const kind = Math.random() < 0.5 ? "hm_gain" : "rank_xp";
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + CLAN_BOOST_DURATION_MS);

  await supabase.from("hm_clan_quest").delete().eq("guild_id", guildId);
  await supabase.from("hm_clan_quest_completions").insert({
    guild_id: guildId,
    quest_type: quest.quest_type,
    target: quest.target,
    boost_kind: kind,
  });
  await supabase.from("hm_clan_boost").upsert(
    {
      guild_id: guildId,
      kind,
      bonus_pct: CLAN_BOOST_PCT,
      started_at: startedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    },
    { onConflict: "guild_id" }
  );

  return { kind, expiresAt };
}

/**
 * Evaluates clan-wide progress against live totals, lazily tracks any newly
 * registered member, and completes + immediately restarts the quest once the
 * target is reached. Meant to be called on a periodic timer per guild.
 */
async function checkClanQuestProgress(guildId) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const quest = await ensureClanQuest(guildId);
  if (!quest) return null;

  const members = await getRegisteredMembers(guildId);
  const completionCounts =
    quest.quest_type === "quest_completions" ? await getLifetimeQuestCompletions(guildId) : null;

  const baselines = { ...(quest.baselines || {}) };
  let changedBaselines = false;
  let total = 0;

  for (const m of members) {
    if (!(m.user_id in baselines)) {
      baselines[m.user_id] = await currentMemberTotal(quest.quest_type, m, completionCounts);
      changedBaselines = true;
      continue; // just started being tracked — no progress credited this tick
    }
    const current = await currentMemberTotal(quest.quest_type, m, completionCounts);
    total += Math.max(0, current - baselines[m.user_id]);
  }

  if (changedBaselines) {
    await supabase.from("hm_clan_quest").update({ baselines }).eq("guild_id", guildId);
  }

  if (total >= quest.target) {
    const boost = await completeClanQuest(guildId, quest);
    const next = await ensureClanQuest(guildId);
    return { completed: true, finished: quest, boost, next, progress: quest.target, target: quest.target };
  }

  return { completed: false, quest: { ...quest, baselines }, progress: total, target: quest.target };
}

/** The active clan-wide boost, or null if none is running / it has expired but not yet swept. */
async function getActiveClanBoost(guildId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("hm_clan_boost").select("*").eq("guild_id", guildId).maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data;
}

function clanBoostMultiplier(boost, kind) {
  if (!boost || boost.kind !== kind) return 1;
  return 1 + (Number(boost.bonus_pct) || 0) / 100;
}

module.exports = {
  CLAN_QUEST_TYPES, CLAN_QUEST_BASE_TARGETS, CLAN_QUEST_TARGET_STEP,
  CLAN_MEMBER_THRESHOLD_START, CLAN_MEMBER_THRESHOLD_STEP,
  CLAN_QUEST_LABELS, CLAN_QUEST_EMOJI,
  CLAN_BOOST_KINDS, CLAN_BOOST_PCT, CLAN_BOOST_DURATION_MS, CLAN_BOOST_LABELS,
  clanMemberTier, computeClanQuestTarget,
  ensureClanQuest, checkClanQuestProgress, completeClanQuest, getActiveClanBoost, clanBoostMultiplier,
  getLifetimeQuestCompletions, currentMemberTotal, getRegisteredMembers,
};
