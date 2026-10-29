"use strict";
const { getSupabase } = require("./db");
const { config } = require("./config");
const {
  fetchHiscores, diffProgress, cleanRsn,
  BOSS_GROUPS, BOSS_GROUP_MEMBERS, bossKeys,
} = require("./jagex");
const { awardRankXp } = require("./xpqueue");

// ── Categories ───────────────────────────────────────────────────────────────
const TREES = [
  { key: "gathering",  label: "Gathering",  emoji: "🌿" },
  { key: "production", label: "Production", emoji: "⚒️" },
  { key: "combat",     label: "Combat",     emoji: "⚔️" },
  { key: "utility",    label: "Utility",    emoji: "🏃" },
  { key: "boss",       label: "Boss PvM",   emoji: "🦴" },
  { key: "raids",      label: "Raids",      emoji: "🏆" },
  { key: "minigames",  label: "Minigames",  emoji: "🎯" },
];

const TREE_BY_KEY = Object.fromEntries(TREES.map((t) => [t.key, t]));
const QUEST_TREES = TREES.map((t) => t.key);

const SKILL_TREE = {
  mining: "gathering", fishing: "gathering", woodcutting: "gathering",
  farming: "gathering", hunter: "gathering",
  smithing: "production", crafting: "production", fletching: "production",
  herblore: "production", cooking: "production", firemaking: "production",
  construction: "production", runecrafting: "production",
  attack: "combat", strength: "combat", defence: "combat", ranged: "combat",
  magic: "combat", prayer: "combat", hitpoints: "combat",
  agility: "utility", thieving: "utility", sailing: "utility", slayer: "utility",
};

const SKILLS_BY_TREE = Object.fromEntries(
  TREES.map((t) => [t.key, Object.keys(SKILL_TREE).filter((s) => SKILL_TREE[s] === t.key)])
);

const RAID_BOSSES = [
  "chambers_of_xeric", "chambers_of_xeric_challenge_mode",
  "theatre_of_blood", "theatre_of_blood_hard_mode",
  "tombs_of_amascut", "tombs_of_amascut_expert_mode",
];

const MINIGAME_BOSSES = [
  "guardians_of_the_rift", "wintertodt", "tempoross",
  "soul_wars", "last_man_standing",
];

// Slayer bosses and multi-hour endgame gauntlets are never assigned as quest
// targets. They still count toward "any boss" objectives — being told to get
// 45 Zuk KC in a week is not a reasonable quest.
const UNASSIGNABLE_BOSSES = [
  "abyssal_sire", "alchemical_hydra", "araxxor", "cerberus", "grotesque_guardians",
  "kraken", "shellbane_gryphon", "thermonuclear_smoke_devil", "skotizo",
  "hespori", "mimic", "sol_heredit", "tzkal_zuk",
];

// Boss grouping lives in ./jagex so the selection pool and the progress diff
// can never disagree about what counts toward what.

const ALL_BOSSES = [
  "abyssal_sire", "alchemical_hydra", "amoxliatl", "araxxor", "artio", "barrows_chests",
  "bryophyta", "callisto", "calvarion", "cerberus", "chaos_elemental", "chaos_fanatic",
  "commander_zilyana", "corporeal_beast", "crazy_archaeologist", "dagannoth_prime",
  "dagannoth_rex", "dagannoth_supreme", "deranged_archaeologist", "doom_of_mokhaiotl",
  "duke_sucellus", "general_graardor", "giant_mole", "grotesque_guardians",
  "kalphite_queen", "king_black_dragon", "kraken", "kreearra", "kril_tsutsaroth",
  "lunar_chests", "mad_angel", "maggot_king", "mimic", "nex", "nightmare",
  "phosanis_nightmare", "obor", "phantom_muspah", "sarachnis", "scorpia", "scurrius",
  "shellbane_gryphon", "skotizo", "spindel", "the_gauntlet", "the_corrupted_gauntlet",
  "the_hueycoatl", "the_leviathan", "the_royal_titans", "the_whisperer",
  "thermonuclear_smoke_devil", "tzkal_zuk", "tztok_jad", "vardorvis", "venenatis",
  "vetion", "vorkath", "yama", "zalcano", "zulrah",
  // Virtual group target — no hiscores row of its own, resolved by bossKeys().
  "dagannoth_kings",
];

const BOSS_POOL = ALL_BOSSES.filter(
  (b) =>
    !RAID_BOSSES.includes(b) &&
    !MINIGAME_BOSSES.includes(b) &&
    !UNASSIGNABLE_BOSSES.includes(b) &&
    !BOSS_GROUP_MEMBERS.has(b)
);

// ── Targets & rewards ────────────────────────────────────────────────────────
// Solo: one category, targets scale with quest type.
const SOLO_REQUIREMENTS = {
  skill:  { daily: { count: 1, xp: 20000 },  weekly: { count: 1, xp: 75000 },  monthly: { count: 2, xp: 150000 } },
  boss:   { daily: { kc: 15 },               weekly: { kc: 40 },                monthly: { kc: 100 } },
  raid:   { daily: { kc: 3 },                weekly: { kc: 8 },                 monthly: { kc: 20 } },
  minigame: { daily: { kc: 5 },              weekly: { kc: 15 },                monthly: { kc: 40 } },
};

// Flat HM. Team quests pay each member the same amount, because the target is
// a single shared total — whoever did the most work doesn't change the reward.
const SOLO_HM = { daily: 50, weekly: 150, monthly: 400 };
const PARTY_HM_BY_SIZE = { duo: 250, trio: 350, quad: 450 };
const PARTY_DIFFICULTY_MULT = { easy: 1, hard: 1.6 };

const PARTY_REQUIREMENTS = {
  skill:    { duo: { count: 2, xp: 135000 }, trio: { count: 3, xp: 200000 }, quad: { count: 4, xp: 270000 } },
  boss:     { duo: { count: 1, kc: 150 },    trio: { count: 2, kc: 250 },     quad: { count: 3, kc: 350 } },
  raid:     { duo: { kc: 15 },               trio: { kc: 30 },                quad: { kc: 45 } },
  minigame: { duo: { count: 1, kc: 50 },     trio: { count: 2, kc: 125 },     quad: { count: 3, kc: 200 } },
};

const QUEST_DURATION_DAYS = { daily: 1, weekly: 7, monthly: 30 };
const PARTY_DURATION_DAYS = 14;
const RESET_PERIOD = { daily: 1, weekly: 7, monthly: 30 };

function pickRandom(arr, n) {
  const pool = [...arr];
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

function treeKind(tree) {
  if (tree === "boss") return "boss";
  if (tree === "raids") return "raid";
  if (tree === "minigames") return "minigame";
  return "skill";
}

/** Builds the target map for one member's solo quest. */
function buildSoloTargets(tree, questType) {
  const kind = treeKind(tree);
  const req = SOLO_REQUIREMENTS[kind][questType];
  const targets = { skills: {}, bosses: {} };

  if (kind === "skill") {
    const skills = pickRandom(SKILLS_BY_TREE[tree] || [], req.count);
    for (const s of skills) targets.skills[s] = req.xp;
  } else if (kind === "boss") {
    // Boss requirement carries only `kc` (a daily is one boss, not two), so
    // the count has to default — passing undefined here silently produced a
    // quest with no targets at all.
    const picked = pickRandom(BOSS_POOL, req.count || 1);
    for (const b of picked) targets.bosses[b] = req.kc;
  } else if (kind === "raid") {
    // Raid difficulty is deliberately collapsed: normal and hard/expert are the
    // same content for quest purposes.
    const picked = pickRandom(["chambers_of_xeric", "theatre_of_blood", "tombs_of_amascut"], req.count || 1);
    for (const r of picked) targets.bosses[r] = req.kc;
  } else {
    const picked = pickRandom(MINIGAME_BOSSES, req.count || 1);
    for (const m of picked) targets.bosses[m] = req.kc;
  }
  return targets;
}

function buildPartyTargets(tree, size, difficulty) {
  const kind = treeKind(tree);
  const req = PARTY_REQUIREMENTS[kind][size];
  const mult = PARTY_DIFFICULTY_MULT[difficulty] || 1;
  const targets = { skills: {}, bosses: {} };

  if (kind === "skill") {
    const skills = pickRandom(SKILLS_BY_TREE[tree] || [], req.count);
    for (const s of skills) targets.skills[s] = Math.round(req.xp * mult);
  } else if (kind === "boss") {
    const picked = pickRandom(BOSS_POOL, req.count);
    for (const b of picked) targets.bosses[b] = Math.round(req.kc * mult);
  } else if (kind === "raid") {
    const picked = pickRandom(["chambers_of_xeric", "theatre_of_blood", "tombs_of_amascut"], 1);
    for (const r of picked) targets.bosses[r] = Math.round(req.kc * mult);
  } else {
    const picked = pickRandom(MINIGAME_BOSSES, req.count || 1);
    for (const m of picked) targets.bosses[m] = Math.round(req.kc * mult);
  }
  return targets;
}

function soloHmReward(questType) {
  return SOLO_HM[questType] || 0;
}

function partyHmReward(size, difficulty) {
  const base = PARTY_HM_BY_SIZE[size] || 0;
  return Math.round(base * (PARTY_DIFFICULTY_MULT[difficulty] || 1));
}

// ── Reset helpers ────────────────────────────────────────────────────────────
function dayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function weekStamp(d = new Date()) {
  // ISO week start (Monday), UTC.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return date.toISOString().slice(0, 10);
}

function monthStamp(d = new Date()) {
  return d.toISOString().slice(0, 7) + "-01";
}

function resetStampFor(questType, d = new Date()) {
  if (questType === "daily") return dayStamp(d);
  if (questType === "weekly") return weekStamp(d);
  return monthStamp(d);
}

// ── Persistence ──────────────────────────────────────────────────────────────
async function getMember(userId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("hm_members").select("*").eq("user_id", userId).maybeSingle();
  return data || null;
}

async function getMemberByRsn(guildId, rsn) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from("hm_members")
    .select("*")
    .eq("guild_id", guildId)
    .ilike("rsn", cleanRsn(rsn))
    .maybeSingle();
  return data || null;
}

async function getCounts(userId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.from("hm_quest_counts").select("*").eq("user_id", userId).maybeSingle();
  const today = dayStamp();
  const week = weekStamp();
  const month = monthStamp();
  return {
    daily_used: data?.daily_reset === today ? Number(data.daily_used) || 0 : 0,
    weekly_used: data?.weekly_reset === week ? Number(data.weekly_used) || 0 : 0,
    monthly_used: data?.monthly_reset === month ? Number(data.monthly_used) || 0 : 0,
    solo_daily: Number(data?.solo_daily) || 0,
    solo_weekly: Number(data?.solo_weekly) || 0,
    solo_monthly: Number(data?.solo_monthly) || 0,
    duo: Number(data?.duo) || 0,
    trio: Number(data?.trio) || 0,
    quad: Number(data?.quad) || 0,
    total_completed: Number(data?.total_completed) || 0,
    daily_reset: data?.daily_reset ?? null,
    weekly_reset: data?.weekly_reset ?? null,
    monthly_reset: data?.monthly_reset ?? null,
  };
}

async function getActiveSoloQuests(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("hm_quests").select("*").eq("user_id", userId);
  return data || [];
}

async function getActiveSoloQuest(userId, questType) {
  const all = await getActiveSoloQuests(userId);
  return all.find((q) => q.quest_type === questType) || null;
}

async function getActivePartyQuestForUser(userId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from("hm_party_quests")
    .select("*")
    .contains("members", [userId])
    .maybeSingle();
  return data || null;
}

/**
 * Creates a solo quest. Rejects if the slot is full or the daily/weekly/monthly
 * cap for this reset period is spent.
 */
async function createSoloQuest({ guildId, member, tree, questType }) {
  const supabase = getSupabase();
  if (!supabase) return { error: "Database unavailable." };
  if (!TREE_BY_KEY[tree]) return { error: "Unknown category." };
  if (!QUEST_DURATION_DAYS[questType]) return { error: "Unknown quest type." };
  if (!member?.rsn) return { error: "Register your RuneScape name first with `/register`." };

  const existing = await getActiveSoloQuest(member.user_id, questType);
  if (existing) return { error: `You already have an active ${questType} quest. Finish it or turn it in first.` };

  const counts = await getCounts(member.user_id);
  const usedKey = `${questType}_used`;
  if (counts[usedKey] >= 1) {
    return { error: `You've already completed your ${questType} quest for this period.` };
  }

  const baseline = await fetchHiscores(member.rsn);
  if (!baseline) {
    return {
      error:
        "Couldn't read your hiscores. Check that your RSN is spelled exactly right and that " +
        "your profile isn't private, then try again.",
    };
  }

  const targets = buildSoloTargets(tree, questType);
  const now = new Date();
  const expires = new Date(now.getTime() + QUEST_DURATION_DAYS[questType] * 86400000);

  const { error } = await supabase.from("hm_quests").insert({
    guild_id: guildId,
    user_id: member.user_id,
    quest_type: questType,
    tree,
    difficulty: "normal",
    targets,
    baseline,
    hm_reward: soloHmReward(questType),
    rank_xp_reward: config.rankXp[`quest_solo_${questType}`] || 0,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
  });

  if (error) {
    if (error.code === "23505") return { error: `You already have an active ${questType} quest.` };
    console.error("[Quests] createSoloQuest:", error.message);
    return { error: "Couldn't create that quest. Try again in a moment." };
  }
  return { ok: true };
}

async function createPartyQuest({ guildId, members, tree, size, difficulty }) {
  const supabase = getSupabase();
  if (!supabase) return { error: "Database unavailable." };
  if (!TREE_BY_KEY[tree]) return { error: "Unknown category." };

  const expected = { duo: 2, trio: 3, quad: 4 }[size];
  if (!expected) return { error: "Unknown team size." };

  const unique = [...new Set(members)].filter(Boolean);
  if (unique.length !== expected) {
    return { error: `A ${size} needs exactly ${expected} members (got ${unique.length}).` };
  }

  // Every member needs a registered RSN, because progress is read per-RSN.
  const roster = [];
  for (const id of unique) {
    const m = await getMember(id);
    if (!m?.rsn) return { error: `<@${id}> hasn't registered a RuneScape name yet.` };
    roster.push(m);
  }

  // One active team quest per member, matching the original rule.
  for (const m of roster) {
    const active = await getActivePartyQuestForUser(m.user_id);
    if (active) return { error: `<@${m.user_id}> is already on a team quest.` };
  }

  const baselines = {};
  for (const m of roster) {
    const snap = await fetchHiscores(m.rsn);
    if (!snap) return { error: `Couldn't read hiscores for **${m.rsn}**.` };
    baselines[m.user_id] = snap;
  }

  const targets = buildPartyTargets(tree, size, difficulty);
  const now = new Date();
  const expires = new Date(now.getTime() + PARTY_DURATION_DAYS * 86400000);

  const { error } = await supabase.from("hm_party_quests").insert({
    guild_id: guildId,
    tree,
    size,
    difficulty,
    members: unique,
    targets,
    baseline: baselines,
    hm_reward: partyHmReward(size, difficulty),
    rank_xp_reward: config.rankXp[`quest_party_${size}`] || 0,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
  });

  if (error) {
    console.error("[Quests] createPartyQuest:", error.message);
    return { error: "Couldn't create that team quest. Try again in a moment." };
  }
  return { ok: true };
}

/** Adds HM to a balance and writes the ledger row in one place. */
async function creditHm({ guildId, userId, amount, kind, reason, idempotencyKey, refId }) {
  const supabase = getSupabase();
  if (!supabase || amount <= 0) return { ok: false, balance: 0 };

  const { data: bal } = await supabase
    .from("hm_balances")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  const current = Number(bal?.balance) || 0;
  const next = current + amount;

  const { error: upErr } = await supabase.from("hm_balances").upsert(
    {
      user_id: userId,
      guild_id: guildId,
      balance: next,
      total_earned: (Number(bal?.total_earned) || 0) + amount,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (upErr) {
    console.error("[Quests] creditHm balance:", upErr.message);
    return { ok: false, balance: current };
  }

  try {
    await supabase.from("hm_transactions").insert({
      guild_id: guildId,
      user_id: userId,
      delta: amount,
      balance_after: next,
      kind,
      reason,
      ref_id: refId || null,
      idempotency_key: idempotencyKey || null,
    });
  } catch { /* ledger is best-effort; the balance is the source of truth */ }

  return { ok: true, balance: next };
}

async function bumpCounts({ guildId, userId, questType, size }) {
  const supabase = getSupabase();
  if (!supabase) return;

  const existing = await getCounts(userId);
  const today = dayStamp();
  const week = weekStamp();
  const month = monthStamp();

  const patch = {
    user_id: userId,
    guild_id: guildId,
    total_completed: existing.total_completed + 1,
    daily_used: existing.daily_reset === today ? existing.daily_used : 0,
    daily_reset: today,
    weekly_used: existing.weekly_reset === week ? existing.weekly_used : 0,
    weekly_reset: week,
    monthly_used: existing.monthly_reset === month ? existing.monthly_used : 0,
    monthly_reset: month,
    solo_daily: existing.solo_daily,
    solo_weekly: existing.solo_weekly,
    solo_monthly: existing.solo_monthly,
    duo: existing.duo,
    trio: existing.trio,
    quad: existing.quad,
    updated_at: new Date().toISOString(),
  };

  if (questType) {
    patch[`${questType}_used`] += 1;
    patch[`solo_${questType}`] += 1;
  }
  if (size) {
    patch[size] += 1;
    // A team quest consumes the member's daily slot for that period, matching
    // the original behaviour where team quests counted toward the same cap.
  }

  const { error } = await supabase.from("hm_quest_counts").upsert(patch, { onConflict: "user_id" });
  if (error) console.error("[Quests] bumpCounts:", error.message);
}

module.exports = {
  TREES, TREE_BY_KEY, QUEST_TREES, SKILL_TREE, SKILLS_BY_TREE,
  BOSS_POOL, BOSS_GROUPS, BOSS_GROUP_MEMBERS, bossKeys, RAID_BOSSES, MINIGAME_BOSSES,
  SOLO_HM, PARTY_HM_BY_SIZE, PARTY_DIFFICULTY_MULT,
  QUEST_DURATION_DAYS, PARTY_DURATION_DAYS, RESET_PERIOD,
  buildSoloTargets, buildPartyTargets, soloHmReward, partyHmReward,
  dayStamp, weekStamp, monthStamp, resetStampFor,
  getMember, getMemberByRsn, getCounts,
  getActiveSoloQuests, getActiveSoloQuest, getActivePartyQuestForUser,
  createSoloQuest, createPartyQuest, creditHm, bumpCounts,
  awardRankXp,
  diffProgress, fetchHiscores, cleanRsn,
};
