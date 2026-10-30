"use strict";
const https = require("https");

/**
 * Live OSRS hiscores. No third-party API, no key, no account — the previous
 * bot migrated off WOM to Jagex for exactly this reason.
 *
 * Global concurrency is capped and responses are cached, because a clan of 200
 * all pressing "Check Quest" at once would otherwise open 200 sockets at the
 * same instant. Jagex publishes no documented limit; treat it politely anyway.
 */

const REQUEST_DELAY_MS = 300;
const CACHE_TTL_MS = 60 * 1000; // a repeat check within a minute is free
const MAX_CONCURRENT = 2;

const SKILL_MAP = {
  Attack: "attack", Defence: "defence", Strength: "strength", Hitpoints: "hitpoints",
  Ranged: "ranged", Prayer: "prayer", Magic: "magic", Cooking: "cooking",
  Woodcutting: "woodcutting", Fletching: "fletching", Fishing: "fishing",
  Firemaking: "firemaking", Crafting: "crafting", Smithing: "smithing", Mining: "mining",
  Herblore: "herblore", Agility: "agility", Thieving: "thieving", Slayer: "slayer",
  Farming: "farming", Runecraft: "runecrafting", Hunter: "hunter",
  Construction: "construction", Sailing: "sailing",
};

const ACTIVITY_MAP = {
  Wintertodt: "wintertodt", Tempoross: "tempoross", "Rifts closed": "guardians_of_the_rift",
  "Soul Wars Zeal": "soul_wars", "LMS - Rank": "last_man_standing",
  "Chambers of Xeric": "chambers_of_xeric",
  "Chambers of Xeric: Challenge Mode": "chambers_of_xeric_challenge_mode",
  "Theatre of Blood": "theatre_of_blood",
  "Theatre of Blood: Hard Mode": "theatre_of_blood_hard_mode",
  "Tombs of Amascut": "tombs_of_amascut",
  "Tombs of Amascut: Expert Mode": "tombs_of_amascut_expert_mode",
  "Abyssal Sire": "abyssal_sire", "Alchemical Hydra": "alchemical_hydra", Amoxliatl: "amoxliatl",
  Araxxor: "araxxor", Artio: "artio", "Barrows Chests": "barrows_chests",
  Bryophyta: "bryophyta", Callisto: "callisto", "Calvar'ion": "calvarion",
  Cerberus: "cerberus", "Chaos Elemental": "chaos_elemental", "Chaos Fanatic": "chaos_fanatic",
  "Commander Zilyana": "commander_zilyana", "Corporeal Beast": "corporeal_beast",
  "Crazy Archaeologist": "crazy_archaeologist", "Dagannoth Prime": "dagannoth_prime",
  "Dagannoth Rex": "dagannoth_rex", "Dagannoth Supreme": "dagannoth_supreme",
  "Deranged Archaeologist": "deranged_archaeologist", "Doom of Mokhaiotl": "doom_of_mokhaiotl",
  "Duke Sucellus": "duke_sucellus", "General Graardor": "general_graardor",
  "Giant Mole": "giant_mole", "Grotesque Guardians": "grotesque_guardians",
  Kalphite: "kalphite_queen", "Kalphite Queen": "kalphite_queen",
  "King Black Dragon": "king_black_dragon", Kraken: "kraken", "Kree'Arra": "kreearra",
  "K'ril Tsutsaroth": "kril_tsutsaroth", "Lunar Chests": "lunar_chests",
  "Mad Angel": "mad_angel", Mimic: "mimic", "Maggot King": "maggot_king", Nex: "nex",
  Nightmare: "nightmare", "Phosani's Nightmare": "phosanis_nightmare", Obor: "obor",
  "Phantom Muspah": "phantom_muspah", Sarachnis: "sarachnis", Scorpia: "scorpia",
  Scurrius: "scurrius", "Shellbane Gryphon": "shellbane_gryphon", Skotizo: "skotizo",
  "Sol Heredit": "sol_heredit", Spindel: "spindel", "The Gauntlet": "the_gauntlet",
  "The Corrupted Gauntlet": "the_corrupted_gauntlet", "The Hueycoatl": "the_hueycoatl",
  "The Leviathan": "the_leviathan", "The Royal Titans": "the_royal_titans",
  "The Whisperer": "the_whisperer",
  "Thermonuclear Smoke Devil": "thermonuclear_smoke_devil",
  "TzKal-Zuk": "tzkal_zuk", "TzTok-Jad": "tztok_jad", Vardorvis: "vardorvis",
  Venenatis: "venenatis", "Vet'ion": "vetion", Vorkath: "vorkath", Yama: "yama",
  Zalcano: "zalcano", Zulrah: "zulrah",
};

/**
 * Jagex tracks some content as separate hiscores entries that players think of
 * as one thing. A quest assigned the GROUP KEY counts every member of the
 * group, so a member can do whichever variant they like.
 *
 * Dagannoth Kings is special: there is no "dagannoth_kings" hiscores row, so
 * the group key exists only as a virtual target and MUST be resolved here at
 * read time rather than looked up directly.
 */
const BOSS_GROUPS = {
  the_gauntlet: ["the_gauntlet", "the_corrupted_gauntlet"],
  nightmare: ["nightmare", "phosanis_nightmare"],
  dagannoth_kings: ["dagannoth_prime", "dagannoth_rex", "dagannoth_supreme"],
};

const BOSS_GROUP_MEMBERS = new Set(
  Object.entries(BOSS_GROUPS).flatMap(([primary, keys]) => keys.filter((k) => k !== primary))
);

/** Keys whose KC counts toward {@code key} (just itself if ungrouped). */
function bossKeys(key) {
  return BOSS_GROUPS[key] || [key];
}

const ACTIVITY_LABELS = Object.fromEntries(
  Object.entries(ACTIVITY_MAP).map(([label, key]) => [key, label])
);

const SKILL_LABELS = Object.fromEntries(
  Object.entries(SKILL_MAP).map(([label, key]) => [key, label])
);

// Display names for virtual (grouped) targets that have no hiscores row.
const GROUP_LABELS = {
  the_gauntlet: "The Gauntlet (normal or Corrupted)",
  nightmare: "The Nightmare / Phosani's Nightmare",
  dagannoth_kings: "Dagannoth Kings (Prime, Rex or Supreme)",
};

function bossLabel(key) {
  return GROUP_LABELS[key] || ACTIVITY_LABELS[key] || key;
}

const cache = new Map(); // rsn(lower) -> { at, snap }
let activeRequests = 0;
const waiters = [];

function acquireSlot() {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  activeRequests -= 1;
  const next = waiters.shift();
  if (next) {
    activeRequests += 1;
    next();
  }
}

function httpsGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { "User-Agent": "OdinheimHonourMarks/1.0" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

/** Normalises a typed RSN the way Jagex expects (no non-ASCII, trimmed). */
function cleanRsn(rsn) {
  return String(rsn || "").replace(/[^\x00-\x7F]/g, "").trim();
}

/**
 * @returns {Promise<null | {skills: Object, bosses: Object, fetchedAt: number}>}
 * Shape matches what quest progress diffs against:
 *   skills[key]  = { experience }
 *   bosses[key]  = { kills }
 */
async function fetchHiscores(rsn, { useCache = true } = {}) {
  const name = cleanRsn(rsn);
  if (!name) return null;

  const key = name.toLowerCase();
  if (useCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.snap;
  }

  await acquireSlot();
  try {
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    const data = await httpsGetJson(
      `https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=${encodeURIComponent(name)}`
    );

    // A private or newly-created profile returns no skills array. That is a
    // real answer ("no data"), not an error — cache it briefly so we don't
    // hammer Jagex re-checking a profile that won't resolve.
    if (!data || !Array.isArray(data.skills)) {
      cache.set(key, { at: Date.now(), snap: null });
      return null;
    }

    const skills = {};
    for (const s of data.skills) {
      const mapped = SKILL_MAP[s.name];
      if (mapped) {
        // `level` is captured alongside XP for the boss safety check and the
        // weighted-skill-roll system — both need the player's actual current
        // level, not an XP->level estimate. A negative/missing level (an
        // unranked skill reports -1) floors to 1, same as a fresh account.
        skills[mapped] = {
          experience: Math.max(0, Number(s.xp) || 0),
          level: Math.max(1, Number(s.level) || 1),
        };
      }
    }
    const bosses = {};
    for (const a of data.activities || []) {
      const mapped = ACTIVITY_MAP[a.name];
      if (mapped) bosses[mapped] = { kills: Math.max(0, Number(a.score) || 0) };
    }

    const snap = { skills, bosses, fetchedAt: Date.now() };
    cache.set(key, { at: Date.now(), snap });
    return snap;
  } finally {
    releaseSlot();
  }
}

/**
 * Progress between two snapshots for a target map.
 * targets = { skills: {mining: 20000}, bosses: {vorkath: 50} }
 */
function diffProgress(baseline, current, targets = {}) {
  const out = { totalPct: 0, parts: [] };
  if (!current) return out;

  for (const [skill, needed] of Object.entries(targets.skills || {})) {
    const got = Math.max(0, (current.skills?.[skill]?.experience || 0) - (baseline?.skills?.[skill]?.experience || 0));
    const need = Math.max(1, Number(needed) || 1);
    out.parts.push({
      kind: "skill", key: skill, label: SKILL_LABELS[skill] || skill,
      gained: got, needed: need, pct: Math.min(100, (got / need) * 100),
    });
  }

  for (const [boss, needed] of Object.entries(targets.bosses || {})) {
    // Sum across a group so "The Gauntlet" counts Corrupted KC and "Dagannoth
    // Kings" counts all three.
    const got = bossKeys(boss).reduce((total, k) => {
      const now = current.bosses?.[k]?.kills || 0;
      const was = baseline?.bosses?.[k]?.kills || 0;
      return total + Math.max(0, now - was);
    }, 0);
    const need = Math.max(1, Number(needed) || 1);
    out.parts.push({
      kind: "boss", key: boss, label: bossLabel(boss),
      gained: got, needed: need, pct: Math.min(100, (got / need) * 100),
    });
  }

  // Average the per-target percentages rather than summing raw values.
  // Summing is wrong the moment a quest mixes units: 20,000 XP swamps 50 KC,
  // so a member who finished every kill target would still read as 0%.
  // Averaging is unit-agnostic and weights each target equally.
  if (out.parts.length) {
    const mean = out.parts.reduce((sum, p) => sum + p.pct, 0) / out.parts.length;
    out.totalPct = Math.min(100, Math.floor(mean));
    out.finished = out.parts.every((p) => p.pct >= 100);
    // A quest is only "done" when EVERY target is met. Averaging alone would
    // let a 100% + 90% pair read as 95% and never complete, and would also let
    // 100% + 120%-capped pairs complete early — this makes it explicit.
    if (out.finished) out.totalPct = 100;
  }

  return out;
}

module.exports = {
  fetchHiscores,
  diffProgress,
  cleanRsn,
  SKILL_MAP,
  ACTIVITY_MAP,
  SKILL_LABELS,
  ACTIVITY_LABELS,
  GROUP_LABELS,
  BOSS_GROUPS,
  BOSS_GROUP_MEMBERS,
  bossKeys,
  bossLabel,
};
