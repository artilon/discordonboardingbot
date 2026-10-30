"use strict";
const { getSupabase } = require("./db");
const { config } = require("./config");
const {
  fetchHiscores, diffProgress, cleanRsn,
  BOSS_GROUPS, BOSS_GROUP_MEMBERS, bossKeys,
} = require("./jagex");
const { awardRankXp } = require("./xpqueue");
const { safeBossPool, levelsFromSnapshot, pickEasiestBoss } = require("./bossSafety");

// ── Shop item slots that affect quest generation/rewards ───────────────────
// Lives here (not src/shop.js) because createPartyQuest/joinOpenTeam need to
// read these for a whole roster without creating a circular import — shop.js
// already depends on this file, not the other way around. The DB table and
// slot values are unchanged from the original design; only slots 2 and 3 were
// RE-PURPOSED (see comments below) rather than renamed, so no migration or
// schema change was needed to bring them back.
const ITEM_SLOT = {
  REDUCTION: "quest_reduction",  // -2%/-5%/-10% off the XP/KC/clears/completions required
  CLAN_CHAT_XP: "hm_bonus",      // was "HM Bonus" — repurposed to +2%/+5%/+10% RANK XP instead
  EXPANSION: "boost_length",     // was "Boost Length Extension" — repurposed into "Quest Expansion"
};
const ITEM_PCT_BY_TIER = [0, 2, 5, 10]; // index = tier (0 = not owned)

function itemPercentForTier(tier) {
  return ITEM_PCT_BY_TIER[Math.max(0, Math.min(3, Number(tier) || 0))];
}

/** Mirrors shop.js's `perkBonusPercent` (tier * 5%) — kept as a one-line
 *  constant here too, since this file can't import shop.js without creating
 *  a cycle (shop.js already imports this file). */
function perkPercentForTier(tier) {
  return (Number(tier) || 0) * 5;
}

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
const PARTY_SIZES = { duo: 2, trio: 3, quad: 4 };

// Open (recruiting) team listings posted to the Looking For Group board.
// Unfilled listings are swept away after this many hours.
const LFG_EXPIRY_HOURS = 24;

function pickRandom(arr, n) {
  const pool = [...arr];
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

/**
 * Weighted skill rolls — a quest randomly rolling the same maxed skill over
 * and over while the one a member actually needs never comes up was the
 * whole complaint. Weight falls off linearly with level: a level-1 skill is
 * ~99x as likely as a level-99 one, but never literally zero — a 99 is still
 * technically reachable, just rare, same as the real odds of it mattering.
 */
function skillWeight(level) {
  return Math.max(1, 100 - (Number(level) || 1));
}

/**
 * Weighted sample of `n` skills without replacement. `levelsList` is one
 * `{skillKey: level}` object per player being asked about — a single-element
 * array for a solo quest, one per member for a team quest. For a team, each
 * skill is weighted by the LOWEST level among the team for it, so the roll
 * favours whatever's least developed for *anyone* on the team, not just
 * whoever's worst overall. Falls back to a uniform `pickRandom` when no
 * level data is available (e.g. existing callers that don't pass a baseline).
 */
function pickWeightedSkills(pool, n, levelsList) {
  if (!levelsList || !levelsList.length) return pickRandom(pool, n);

  const remaining = [...pool];
  const out = [];
  for (let i = 0; i < n && remaining.length; i++) {
    const weights = remaining.map((skill) => {
      const lowest = Math.min(...levelsList.map((lv) => Number(lv?.[skill]) || 1));
      return skillWeight(lowest);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let idx = weights.length - 1;
    for (let w = 0; w < weights.length; w++) {
      roll -= weights[w];
      if (roll <= 0) { idx = w; break; }
    }
    out.push(remaining.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * Picks up to `count` safe boss targets at `baseKc` each (the boss safety
 * check — see src/bossSafety.js). If fewer than `count` bosses are actually
 * safe for everyone involved (every snapshot in `snapshots` must individually
 * qualify), every available safe boss is used instead and its required KC is
 * scaled up by (count ÷ actual) so the total expected grind — and the reward
 * it earns, via the caller's `rewardScale` — stays equivalent to what the
 * full target count would have asked for. `snapshots` of `null`/empty skips
 * the safety filter entirely (keeps old behaviour for callers that don't
 * pass one, e.g. existing tests).
 */
function pickBossTargets(pool, count, baseKc, snapshots) {
  let usePool = pool;
  if (snapshots && (Array.isArray(snapshots) ? snapshots.length : true)) {
    const safe = safeBossPool(pool, snapshots, bossKeys);
    if (safe.length) {
      usePool = safe;
    } else {
      // Nobody qualifies for anything on file — fall back to the single
      // easiest boss in the pool rather than either blocking the quest
      // entirely or silently ignoring the safety check. Its KC gets scaled
      // up below exactly like any other partial-pool fallback.
      usePool = [pickEasiestBoss(pool)];
    }
  }

  const actual = Math.min(count, usePool.length);
  const picked = pickRandom(usePool, actual);
  const scale = actual > 0 ? count / actual : 1;
  const kc = Math.round(baseKc * scale);

  const out = {};
  for (const b of picked) out[b] = kc;
  return out;
}

function treeKind(tree) {
  if (tree === "boss") return "boss";
  if (tree === "raids") return "raid";
  if (tree === "minigames") return "minigame";
  return "skill";
}

/** Builds the target map for one member's solo quest. */
// Raid difficulty is deliberately collapsed: normal and hard/expert are the
// same content for quest purposes.
const SOLO_RAID_POOL = ["chambers_of_xeric", "theatre_of_blood", "tombs_of_amascut"];

/**
 * Which pool a solo quest in this category/type is drawn from, and how many
 * targets it needs. `expansionTier` (0-3, from a member's Quest Expansion
 * item) adds that many extra targets for skill/boss categories, clamped to
 * however many actually exist in the pool — used by the hand-pick UI so its
 * "select exactly N" always matches what the quest will really require.
 */
function soloTargetPool(tree, questType, expansionTier = 0) {
  const kind = treeKind(tree);
  const req = SOLO_REQUIREMENTS[kind][questType];
  if (!req) return null;

  const baseCount = req.count || 1;
  const wantsExtra = (kind === "skill" || kind === "boss") && expansionTier > 0;

  if (kind === "skill") {
    const pool = SKILLS_BY_TREE[tree] || [];
    const count = wantsExtra ? Math.min(baseCount + expansionTier, pool.length) : baseCount;
    return { kind, count, value: req.xp, pool };
  }
  if (kind === "boss") {
    const count = wantsExtra ? Math.min(baseCount + expansionTier, BOSS_POOL.length) : baseCount;
    return { kind, count, value: req.kc, pool: BOSS_POOL };
  }
  if (kind === "raid") return { kind, count: baseCount, value: req.kc, pool: SOLO_RAID_POOL };
  return { kind, count: baseCount, value: req.kc, pool: MINIGAME_BOSSES };
}

/**
 * Builds the target map for one member's solo quest.
 *
 * `picks` is how a Quest Choice Token hand-picks a target instead of letting
 * the bot roll one at random: pass the exact skill/boss keys the member chose
 * (validated against the real pool) and they're used as-is. Anything missing
 * or invalid is topped up with a random pick from the same pool, so a bad
 * `picks` value can never produce a quest with no targets at all.
 *
 * `baseline` (a hiscores snapshot) and `effects` (from `aggregateTeamEffects`)
 * are both optional and both new: `baseline` drives the weighted skill roll
 * and the boss safety check for whatever's randomly filled in (hand-picked
 * targets are never weighted or safety-filtered — that's an intentional,
 * informed choice). `effects` applies owned Items (reduction/expansion) to
 * the requirement before anything is rolled. Omitting either reproduces the
 * exact old behaviour (plain uniform random, base requirement, untouched).
 */
function buildSoloTargets(tree, questType, picks = null, baseline = null, effects = null) {
  const spec = soloTargetPool(tree, questType);
  if (!spec) return { skills: {}, bosses: {} };
  const { kind, pool } = spec;
  const { count, value } = effects
    ? applyItemEffects(kind, spec.count, spec.value, effects, pool.length)
    : spec;
  const targets = { skills: {}, bosses: {} };

  let chosen = Array.isArray(picks) ? [...new Set(picks)].filter((p) => pool.includes(p)).slice(0, count) : [];
  const need = count - chosen.length;

  if (kind === "boss") {
    for (const key of chosen) targets.bosses[key] = value; // hand-picked: base value, never safety-filtered
    if (need > 0) {
      const fillPool = pool.filter((p) => !chosen.includes(p));
      Object.assign(targets.bosses, pickBossTargets(fillPool, need, value, baseline ? [baseline] : null));
    }
    return targets;
  }

  if (need > 0) {
    const fillPool = pool.filter((p) => !chosen.includes(p));
    chosen = chosen.concat(
      kind === "skill" && baseline
        ? pickWeightedSkills(fillPool, need, [levelsFromSnapshot(baseline)])
        : pickRandom(fillPool, need)
    );
  }

  const bucket = kind === "skill" ? targets.skills : targets.bosses;
  for (const key of chosen) bucket[key] = value;
  return targets;
}

/**
 * Builds the shared target map for a team quest. `baselines` is the
 * `{userId: snapshot}` map already fetched for the roster — used both for
 * the weighted skill roll (weighted by the LOWEST level across the team per
 * skill) and the boss safety check (every member must qualify). `effects`
 * comes from `aggregateTeamEffects(roster, tree)`. Both optional, both
 * reproduce the exact old uniform-random, unmodified-requirement behaviour
 * when omitted.
 */
function buildPartyTargets(tree, size, difficulty, baselines = null, effects = null) {
  const kind = treeKind(tree);
  const req = PARTY_REQUIREMENTS[kind][size];
  const mult = PARTY_DIFFICULTY_MULT[difficulty] || 1;
  const targets = { skills: {}, bosses: {} };
  const snapshots = baselines ? Object.values(baselines) : null;

  const basePool = kind === "skill" ? (SKILLS_BY_TREE[tree] || [])
    : kind === "boss" ? BOSS_POOL
    : kind === "raid" ? SOLO_RAID_POOL
    : MINIGAME_BOSSES;

  const baseCount = req.count || 1;
  const baseValue = req.xp || req.kc;
  const { count, value } = effects
    ? applyItemEffects(kind, baseCount, baseValue, effects, basePool.length)
    : { count: baseCount, value: baseValue };
  const scaledValue = Math.round(value * mult);

  if (kind === "skill") {
    const levelsList = snapshots ? snapshots.map(levelsFromSnapshot) : null;
    const skills = levelsList ? pickWeightedSkills(basePool, count, levelsList) : pickRandom(basePool, count);
    for (const s of skills) targets.skills[s] = scaledValue;
  } else if (kind === "boss") {
    Object.assign(targets.bosses, pickBossTargets(basePool, count, scaledValue, snapshots));
  } else if (kind === "raid") {
    const picked = pickRandom(basePool, 1);
    for (const r of picked) targets.bosses[r] = scaledValue;
  } else {
    const picked = pickRandom(basePool, count);
    for (const m of picked) targets.bosses[m] = scaledValue;
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
// Reset boundaries run on the CLAN's local wall-clock time, not UTC and not an
// individual member's own timezone — "resets at midnight" means one midnight
// for everyone, the same moment regardless of where a member is playing from.
// This only governs how often someone can COMPLETE a daily/weekly/monthly
// quest; an already-started quest still runs its full rolling window
// (QUEST_DURATION_DAYS) from whenever it was created, untouched by this.
const RESET_TZ = "America/Chicago";
const localDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: RESET_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

/** The clan's local calendar date for an instant, as "YYYY-MM-DD" (DST-aware). */
function localDateStamp(d = new Date()) {
  return localDateFormat.format(d); // en-CA formats as YYYY-MM-DD directly.
}

function dayStamp(d = new Date()) {
  return localDateStamp(d);
}

function weekStamp(d = new Date()) {
  // ISO week start (Monday), computed on the clan's local calendar date.
  // Weekday only depends on the date itself, so once we have the correct
  // local YYYY-MM-DD there's no further timezone math needed.
  const [y, m, day] = localDateStamp(d).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, day));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (dow - 1));
  return date.toISOString().slice(0, 10);
}

function monthStamp(d = new Date()) {
  return localDateStamp(d).slice(0, 7) + "-01";
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

/** Moved here from src/shop.js: createPartyQuest/joinOpenTeam need to read a
 *  whole roster's perks/items without a circular import (shop.js already
 *  imports this file). shop.js now imports these back for its own display
 *  code instead of defining its own copies. */
async function getPerks(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("hm_perks").select("*").eq("user_id", userId);
  return data || [];
}

async function getPerkTier(userId, tree) {
  const perks = await getPerks(userId);
  return Number(perks.find((p) => p.tree === tree)?.tier) || 0;
}

async function getItems(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("hm_items").select("*").eq("user_id", userId);
  return data || [];
}

async function getItemTier(userId, tree, slot) {
  const items = await getItems(userId);
  return Number(items.find((i) => i.tree === tree && i.slot === slot)?.tier) || 0;
}

/**
 * Combines one member's (or a whole team's) Perk + Item ownership for one
 * category into the numbers quest generation actually needs.
 *
 *   perkPct        — summed across the roster, boosts HM (Perks, unchanged mechanic)
 *   reductionPct   — summed across the roster, lowers the XP/KC/clears/completions required
 *   clanChatPct    — summed across the roster, boosts RANK XP (the repurposed "HM Bonus" slot)
 *   expansionMaxTier — for skill/boss categories: the HIGHEST tier anyone on the
 *                      roster owns. Summing this additively (like the percentage
 *                      slots) would let a 4-person team demand 16 skills from a
 *                      single Tier-3-each purchase, so it uses the strongest
 *                      single member's tier instead of the total.
 *   expansionPct   — for raids/minigames: summed across the roster like the
 *                     other percentage slots, since it just raises the single
 *                     target's requirement rather than adding more targets.
 *
 * A solo quest calls this with a one-member roster, which collapses all of
 * the above to that member's own numbers — no special-casing needed.
 */
async function aggregateTeamEffects(roster, tree) {
  const kind = treeKind(tree);
  let perkPct = 0;
  let reductionPct = 0;
  let clanChatPct = 0;
  let expansionMaxTier = 0;
  let expansionPct = 0;

  for (const m of roster) {
    const uid = m.user_id;
    const [perkTier, reductionTier, clanChatTier, expansionTier] = await Promise.all([
      getPerkTier(uid, tree),
      getItemTier(uid, tree, ITEM_SLOT.REDUCTION),
      getItemTier(uid, tree, ITEM_SLOT.CLAN_CHAT_XP),
      getItemTier(uid, tree, ITEM_SLOT.EXPANSION),
    ]);
    perkPct += perkPercentForTier(perkTier);
    reductionPct += itemPercentForTier(reductionTier);
    clanChatPct += itemPercentForTier(clanChatTier);
    if (kind === "skill" || kind === "boss") {
      expansionMaxTier = Math.max(expansionMaxTier, expansionTier);
    } else {
      expansionPct += itemPercentForTier(expansionTier);
    }
  }

  return {
    kind,
    perkPct,
    reductionPct: Math.min(reductionPct, 90), // defensive floor so a requirement never hits 0 or negative
    clanChatPct,
    expansionMaxTier,
    expansionPct,
  };
}

/**
 * Turns a base requirement (count + per-target XP/KC) into the real one for
 * this quest, after Item effects:
 *   - Quest & Threshold Reduction always lowers the per-target value.
 *   - Quest Expansion adds extra full-value targets for skill/boss categories
 *     (clamped to however many actually exist in the pool), or raises the
 *     single target's requirement by a percentage for raids/minigames.
 * `rewardScale` is how much more the quest's HM/Rank XP should pay because of
 * Expansion — 1 when nothing is expanded.
 */
function applyItemEffects(kind, baseCount, baseValue, effects = {}, poolLength = Infinity) {
  const reductionPct = effects.reductionPct || 0;
  let value = Math.max(1, Math.round(baseValue * (1 - reductionPct / 100)));
  let count = baseCount;
  let rewardScale = 1;

  if (kind === "skill" || kind === "boss") {
    const wanted = baseCount + (effects.expansionMaxTier || 0);
    count = Number.isFinite(poolLength) ? Math.min(wanted, poolLength) : wanted;
    rewardScale = baseCount > 0 ? count / baseCount : 1;
  } else if (effects.expansionPct) {
    value = Math.round(value * (1 + effects.expansionPct / 100));
    rewardScale = 1 + effects.expansionPct / 100;
  }

  return { count, value, rewardScale };
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
async function createSoloQuest({ guildId, member, tree, questType, picks = null }) {
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

  // Perks (+HM%), the Clan Chat XP item (+Rank XP%), the Quest & Threshold
  // Reduction item (-requirement%), and the Quest Expansion item (more
  // targets/requirement, scaled reward) are all applied once, right here, at
  // creation time — baked into the stored targets/hm_reward/rank_xp_reward so
  // nothing downstream (progress.js, the boost multiplier, the completion
  // flow) needs to know any of this exists.
  const effects = await aggregateTeamEffects([member], tree);
  const targets = buildSoloTargets(tree, questType, picks, baseline, effects);
  const spec = soloTargetPool(tree, questType);
  const { rewardScale } = spec ? applyItemEffects(spec.kind, spec.count, spec.value, effects, spec.pool.length) : { rewardScale: 1 };

  const hmReward = Math.round(soloHmReward(questType) * rewardScale * (1 + effects.perkPct / 100));
  const rankXpReward = Math.round(
    (config.rankXp[`quest_solo_${questType}`] || 0) * rewardScale * (1 + effects.clanChatPct / 100)
  );

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
    hm_reward: hmReward,
    rank_xp_reward: rankXpReward,
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

/**
 * Cancels an active solo quest with no penalty: the row is deleted, nothing is
 * paid, and — because `bumpCounts` only ever runs on completion, never on
 * creation — the member's daily/weekly/monthly slot for that quest type is
 * free again immediately. This is what a Quest Skip Token actually spends.
 */
async function cancelSoloQuest(userId, questId) {
  const supabase = getSupabase();
  if (!supabase) return { error: "Database unavailable." };

  const { data: deleted, error } = await supabase
    .from("hm_quests")
    .delete()
    .eq("id", questId)
    .eq("user_id", userId)
    .select("id");

  if (error || !deleted || deleted.length === 0) {
    return { error: "That quest is already gone — maybe it finished or expired first." };
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

  // Same Perk/Item application as createSoloQuest, but aggregated across the
  // whole roster per `aggregateTeamEffects`'s stacking rules (percentage
  // effects sum across the team; Quest Expansion's extra-target-count effect
  // uses the strongest single member's tier, not the sum, or a 4-person team
  // could demand 16 targets from one Tier-3-each purchase).
  const effects = await aggregateTeamEffects(roster, tree);
  const targets = buildPartyTargets(tree, size, difficulty, baselines, effects);

  const kind = treeKind(tree);
  const baseReq = PARTY_REQUIREMENTS[kind][size];
  const baseCount = baseReq.count || 1;
  const basePool = kind === "skill" ? (SKILLS_BY_TREE[tree] || []) : kind === "boss" ? BOSS_POOL : null;
  const { rewardScale } = applyItemEffects(kind, baseCount, baseReq.xp || baseReq.kc, effects, basePool ? basePool.length : Infinity);

  const hmReward = Math.round(partyHmReward(size, difficulty) * rewardScale * (1 + effects.perkPct / 100));
  const rankXpReward = Math.round(
    (config.rankXp[`quest_party_${size}`] || 0) * rewardScale * (1 + effects.clanChatPct / 100)
  );

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
    hm_reward: hmReward,
    rank_xp_reward: rankXpReward,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
  });

  if (error) {
    console.error("[Quests] createPartyQuest:", error.message);
    return { error: "Couldn't create that team quest. Try again in a moment." };
  }
  return { ok: true };
}

// ── Looking For Group (open team listings) ─────────────────────────────────
/**
 * The closed-group team flow above needs everyone picked up front. This is
 * the alternative: post an open listing that anyone can join. It lives in
 * `hm_lfg_posts` — separate from `hm_party_quests` — because it isn't a real
 * quest yet, just a recruiting post with a partial member list. The moment a
 * join fills the last slot it's converted into a real party quest via
 * `createPartyQuest` and the listing row is deleted.
 */

/** All open listings for a guild, oldest first. Expired ones are swept out by
 *  `sweepExpiredOpenTeams`, but we also filter defensively here in case the
 *  sweep hasn't run yet. */
async function getOpenTeams(guildId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const cutoff = new Date(Date.now() - LFG_EXPIRY_HOURS * 3600000).toISOString();
  const { data } = await supabase
    .from("hm_lfg_posts")
    .select("*")
    .eq("guild_id", guildId)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: true });
  return data || [];
}

/** The open listing a user is posting or has already joined, if any — a
 *  member can only be part of one open listing at a time. */
async function getOpenTeamForUser(guildId, userId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from("hm_lfg_posts")
    .select("*")
    .eq("guild_id", guildId)
    .contains("members", [userId])
    .maybeSingle();
  return data || null;
}

async function createOpenTeam({ guildId, posterId, size, tree }) {
  const supabase = getSupabase();
  if (!supabase) return { error: "Database unavailable." };
  if (!PARTY_SIZES[size]) return { error: "Unknown team size." };
  if (!TREE_BY_KEY[tree]) return { error: "Unknown category." };

  const member = await getMember(posterId);
  if (!member?.rsn) return { error: "Register your RuneScape name first with `/register`." };

  const activeParty = await getActivePartyQuestForUser(posterId);
  if (activeParty) return { error: "You're already on a team quest." };

  const existingOpen = await getOpenTeamForUser(guildId, posterId);
  if (existingOpen) return { error: "You already have an open listing. Cancel it first if you want to post a new one." };

  const { error } = await supabase.from("hm_lfg_posts").insert({
    guild_id: guildId,
    poster_id: posterId,
    team_size: size,
    categories: [tree],
    members: [posterId],
  });

  if (error) {
    if (error.code === "23505") return { error: "You already have an open listing. Cancel it first if you want to post a new one." };
    console.error("[Quests] createOpenTeam:", error.message);
    return { error: "Couldn't post that listing. Try again in a moment." };
  }
  return { ok: true };
}

/** The poster cancels their own open listing early. Anyone who had already
 *  joined is simply released — no quest was ever created, so there's nothing
 *  to refund or penalize. */
async function cancelOpenTeam(guildId, posterId) {
  const supabase = getSupabase();
  if (!supabase) return { error: "Database unavailable." };
  const { data, error } = await supabase
    .from("hm_lfg_posts")
    .delete()
    .eq("guild_id", guildId)
    .eq("poster_id", posterId)
    .select("id");

  if (error || !data?.length) return { error: "You don't have an open listing to cancel." };
  return { ok: true };
}

/**
 * Joins an open listing. If this fills the last slot it immediately converts
 * into a real party quest with the same rules as the closed-group flow
 * (same rewards, same duration, `difficulty: "easy"`), and the listing is
 * deleted. If the conversion itself fails (e.g. someone grabbed an active
 * team quest slot in the meantime), the listing is left untouched so the
 * failed joiner can simply try again or someone else can fill it instead.
 */
async function joinOpenTeam({ guildId, postId, userId }) {
  const supabase = getSupabase();
  if (!supabase) return { error: "Database unavailable." };

  const member = await getMember(userId);
  if (!member?.rsn) return { error: "Register your RuneScape name first with `/register`." };

  const activeParty = await getActivePartyQuestForUser(userId);
  if (activeParty) return { error: "You're already on a team quest." };

  const { data: post } = await supabase
    .from("hm_lfg_posts")
    .select("*")
    .eq("id", postId)
    .eq("guild_id", guildId)
    .maybeSingle();
  if (!post) return { error: "That listing isn't open anymore — someone may have already filled or cancelled it." };

  if (post.members.includes(userId)) return { error: "You're already in that listing." };

  const existingOpen = await getOpenTeamForUser(guildId, userId);
  if (existingOpen) return { error: "You're already in another open listing. Cancel it first if you want to join a different one." };

  const tree = post.categories?.[0];
  const expected = PARTY_SIZES[post.team_size];
  const nextMembers = [...post.members, userId];

  if (nextMembers.length >= expected) {
    const result = await createPartyQuest({ guildId, members: nextMembers, tree, size: post.team_size, difficulty: "easy" });
    if (result.error) return result;

    await supabase.from("hm_lfg_posts").delete().eq("id", postId).eq("guild_id", guildId);
    return { ok: true, started: true, members: nextMembers, size: post.team_size, tree };
  }

  const { error } = await supabase
    .from("hm_lfg_posts")
    .update({ members: nextMembers })
    .eq("id", postId)
    .eq("guild_id", guildId);
  if (error) return { error: "Couldn't join that listing. Try again in a moment." };

  return { ok: true, started: false, members: nextMembers, size: post.team_size, tree, needed: expected - nextMembers.length };
}

/** Deletes open listings that never filled within LFG_EXPIRY_HOURS. Runs on
 *  the same timer as the quest expiry sweep. */
async function sweepExpiredOpenTeams() {
  const supabase = getSupabase();
  if (!supabase) return 0;
  const cutoff = new Date(Date.now() - LFG_EXPIRY_HOURS * 3600000).toISOString();
  const { data } = await supabase.from("hm_lfg_posts").delete().lt("created_at", cutoff).select("id");
  return data?.length || 0;
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
  SOLO_HM, PARTY_HM_BY_SIZE, PARTY_DIFFICULTY_MULT, PARTY_SIZES, LFG_EXPIRY_HOURS,
  QUEST_DURATION_DAYS, PARTY_DURATION_DAYS, RESET_PERIOD,
  buildSoloTargets, buildPartyTargets, soloTargetPool, soloHmReward, partyHmReward,
  dayStamp, weekStamp, monthStamp, resetStampFor,
  getMember, getMemberByRsn, getCounts,
  getActiveSoloQuests, getActiveSoloQuest, getActivePartyQuestForUser,
  createSoloQuest, cancelSoloQuest, createPartyQuest, creditHm, bumpCounts,
  getOpenTeams, getOpenTeamForUser, createOpenTeam, cancelOpenTeam, joinOpenTeam, sweepExpiredOpenTeams,
  awardRankXp,
  diffProgress, fetchHiscores, cleanRsn,
  // Perks/Items (moved/added here so a whole team roster can be read without
  // a circular import — see the comment above aggregateTeamEffects).
  getPerks, getPerkTier, getItems, getItemTier, ITEM_SLOT, ITEM_PCT_BY_TIER,
  itemPercentForTier, perkPercentForTier, aggregateTeamEffects, applyItemEffects,
  // Weighted skill rolls + the boss safety check's pool-filtering entry point.
  skillWeight, pickWeightedSkills, pickBossTargets,
};
