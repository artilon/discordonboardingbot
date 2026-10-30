"use strict";

/**
 * Boss PvM safety check.
 *
 * The random roll for a Boss PvM quest used to pick from the entire 45-boss
 * pool with zero regard for whether the member could actually survive the
 * fight. This file is the safeguard: a boss is only eligible for the RANDOM
 * roll if the member's current combat stats clear the OSRS Wiki's commonly
 * cited "recommended stats" for it, OR the member already has prior kill
 * count on it (grouped variants count together, same as everywhere else) —
 * proof they've already done it regardless of what the wiki recommends.
 *
 * These numbers are approximate, conservative community benchmarks, not
 * strict in-game minimums — OSRS doesn't enforce stat requirements on most
 * bosses, so the point is to stop the dice from assigning something wildly
 * out of reach, not to gatekeep every viable strategy. Tune freely.
 *
 * Deliberately NOT applied to a member hand-picking their own target with a
 * Quest Choice Token — that's an informed, intentional choice, not a roll of
 * the dice, so it stays unrestricted.
 *
 * Shape per boss:
 *   hitpoints / defence / prayer — baseline survivability. ALL of the ones
 *     listed must be met (missing/omitted means "not checked").
 *   styles — alternative offensive loadouts; the member needs to fully meet
 *     at least ONE of them. Melee needs BOTH attack and strength; ranged and
 *     magic are each a single skill. Omitted/empty = no offensive gate.
 */
const BOSS_REQUIREMENTS = {
  amoxliatl:              { hitpoints: 70, defence: 60, prayer: 43, styles: [{ ranged: 70 }, { magic: 70 }, { attack: 70, strength: 70 }] },
  artio:                  { hitpoints: 70, defence: 65, prayer: 43, styles: [{ attack: 70, strength: 70 }] },
  barrows_chests:         { hitpoints: 50, defence: 50, prayer: 25, styles: [{ attack: 50, strength: 50 }, { ranged: 50 }, { magic: 50 }] },
  bryophyta:              { hitpoints: 30, defence: 20, styles: [{ attack: 30, strength: 30 }] },
  callisto:               { hitpoints: 70, defence: 65, prayer: 43, styles: [{ attack: 70, strength: 70 }] },
  calvarion:              { hitpoints: 70, defence: 65, prayer: 43, styles: [{ attack: 70, strength: 70 }] },
  chaos_elemental:        { hitpoints: 60, defence: 50, prayer: 31, styles: [{ attack: 60, strength: 60 }, { ranged: 60 }] },
  chaos_fanatic:          { hitpoints: 50, defence: 40, styles: [{ ranged: 60 }, { magic: 60 }] },
  commander_zilyana:      { hitpoints: 70, defence: 60, prayer: 43, styles: [{ ranged: 70 }, { magic: 70 }, { attack: 70, strength: 70 }] },
  corporeal_beast:        { hitpoints: 80, defence: 70, prayer: 52, styles: [{ attack: 85, strength: 85 }, { ranged: 85 }] },
  crazy_archaeologist:    { hitpoints: 50, defence: 45, prayer: 31, styles: [{ ranged: 50 }, { magic: 50 }, { attack: 50, strength: 50 }] },
  dagannoth_kings:        { hitpoints: 70, defence: 60, prayer: 43, styles: [{ attack: 70, strength: 70 }, { ranged: 70 }, { magic: 70 }] },
  deranged_archaeologist: { hitpoints: 40, defence: 35, styles: [{ ranged: 50 }, { magic: 50 }] },
  doom_of_mokhaiotl:      { hitpoints: 75, defence: 70, prayer: 43, styles: [{ attack: 80, strength: 80 }] },
  duke_sucellus:          { hitpoints: 75, defence: 70, prayer: 43, styles: [{ attack: 75, strength: 75 }, { magic: 75 }] },
  general_graardor:       { hitpoints: 70, defence: 60, prayer: 43, styles: [{ attack: 70, strength: 70 }, { ranged: 70 }] },
  giant_mole:             { hitpoints: 50, defence: 40, styles: [{ attack: 50, strength: 50 }] },
  kalphite_queen:         { hitpoints: 70, defence: 60, prayer: 43, styles: [{ attack: 70, strength: 70 }, { ranged: 70 }] },
  king_black_dragon:      { hitpoints: 50, defence: 40, styles: [{ attack: 50, strength: 50 }, { ranged: 50 }, { magic: 50 }] },
  kreearra:               { hitpoints: 70, defence: 60, prayer: 43, styles: [{ ranged: 70 }, { magic: 70 }, { attack: 70, strength: 70 }] },
  kril_tsutsaroth:        { hitpoints: 70, defence: 60, prayer: 43, styles: [{ attack: 70, strength: 70 }, { ranged: 70 }] },
  lunar_chests:           { hitpoints: 75, defence: 65, prayer: 43, styles: [{ attack: 75, strength: 75 }, { ranged: 75 }, { magic: 75 }] },
  mad_angel:              { hitpoints: 60, defence: 50, styles: [{ attack: 60, strength: 60 }, { ranged: 60 }] },
  maggot_king:            { hitpoints: 50, defence: 40, styles: [{ attack: 50, strength: 50 }] },
  nex:                    { hitpoints: 90, defence: 80, prayer: 70, styles: [{ attack: 90, strength: 90 }, { ranged: 90 }, { magic: 90 }] },
  nightmare:              { hitpoints: 80, defence: 70, prayer: 52, styles: [{ attack: 85, strength: 85 }, { ranged: 85 }, { magic: 85 }] },
  obor:                   { hitpoints: 40, defence: 30, styles: [{ attack: 40, strength: 40 }] },
  phantom_muspah:         { hitpoints: 75, defence: 65, prayer: 43, styles: [{ ranged: 70 }, { magic: 70 }] },
  sarachnis:              { hitpoints: 45, defence: 35, styles: [{ attack: 45, strength: 45 }] },
  scorpia:                { hitpoints: 40, defence: 30, styles: [{ attack: 40, strength: 40 }, { ranged: 40 }] },
  scurrius:               { hitpoints: 40, defence: 30, styles: [{ attack: 40, strength: 40 }, { ranged: 40 }] },
  spindel:                { hitpoints: 70, defence: 65, prayer: 43, styles: [{ attack: 70, strength: 70 }] },
  the_gauntlet:           { hitpoints: 70, defence: 60, prayer: 43, styles: [{ ranged: 70 }, { magic: 70 }] },
  the_hueycoatl:          { hitpoints: 75, defence: 65, prayer: 43, styles: [{ attack: 75, strength: 75 }, { ranged: 75 }] },
  the_leviathan:          { hitpoints: 75, defence: 70, prayer: 43, styles: [{ attack: 75, strength: 75 }] },
  the_royal_titans:       { hitpoints: 75, defence: 65, prayer: 43, styles: [{ attack: 75, strength: 75 }, { ranged: 75 }] },
  the_whisperer:          { hitpoints: 75, defence: 70, prayer: 43, styles: [{ magic: 75 }] },
  tztok_jad:              { hitpoints: 70, defence: 60, prayer: 43, styles: [{ attack: 70, strength: 70 }, { ranged: 70 }, { magic: 70 }] },
  vardorvis:              { hitpoints: 75, defence: 70, prayer: 43, styles: [{ attack: 75, strength: 75 }] },
  venenatis:              { hitpoints: 70, defence: 65, prayer: 43, styles: [{ attack: 70, strength: 70 }] },
  vetion:                 { hitpoints: 70, defence: 65, prayer: 43, styles: [{ attack: 70, strength: 70 }] },
  vorkath:                { hitpoints: 75, defence: 65, prayer: 43, styles: [{ ranged: 70 }, { magic: 70 }] },
  yama:                   { hitpoints: 80, defence: 70, prayer: 52, styles: [{ attack: 80, strength: 80 }, { ranged: 80 }, { magic: 80 }] },
  zalcano:                { hitpoints: 40, defence: 30, styles: [{ attack: 40, strength: 40 }, { ranged: 40 }, { magic: 40 }] },
  zulrah:                 { hitpoints: 75, defence: 65, prayer: 43, styles: [{ ranged: 70 }, { magic: 70 }] },
};

/** `{ skillKey: level }` from a hiscores snapshot. Missing skills floor to 1
 *  (a brand-new account), same convention as `fetchHiscores`. */
function levelsFromSnapshot(snapshot) {
  const levels = {};
  for (const [key, data] of Object.entries(snapshot?.skills || {})) {
    levels[key] = Number(data?.level) || 1;
  }
  return levels;
}

function meetsStyle(levels, style) {
  return Object.entries(style).every(([skill, need]) => (levels[skill] || 1) >= need);
}

/** True if a snapshot's current levels clear a boss's recommended stats.
 *  No entry on file at all fails OPEN (eligible) rather than silently
 *  blocking a boss nobody got around to researching yet. */
function meetsStatRequirements(snapshot, bossKey) {
  const req = BOSS_REQUIREMENTS[bossKey];
  if (!req) return true;

  const levels = levelsFromSnapshot(snapshot);
  for (const stat of ["hitpoints", "defence", "prayer"]) {
    if (req[stat] && (levels[stat] || 1) < req[stat]) return false;
  }
  if (req.styles && req.styles.length) {
    return req.styles.some((style) => meetsStyle(levels, style));
  }
  return true;
}

/** Prior KC on a boss (grouped variants combined via `bossKeysFn`) proves the
 *  member has already killed it, regardless of current stats. */
function hasPriorKc(snapshot, bossKey, bossKeysFn) {
  const keys = bossKeysFn ? bossKeysFn(bossKey) : [bossKey];
  return keys.some((k) => (snapshot?.bosses?.[k]?.kills || 0) > 0);
}

/** Whether ONE player qualifies for a boss target. */
function qualifiesForBoss(snapshot, bossKey, bossKeysFn) {
  if (!snapshot) return true; // no data to check against — fail open, never block on a lookup failure
  if (hasPriorKc(snapshot, bossKey, bossKeysFn)) return true;
  return meetsStatRequirements(snapshot, bossKey);
}

/** Filters a boss pool down to bosses EVERY given snapshot qualifies for —
 *  one snapshot for a solo roll, one per member for a team roll, so a boss
 *  is never assigned unless the whole team can safely fight it. */
function safeBossPool(pool, snapshots, bossKeysFn) {
  const snaps = (Array.isArray(snapshots) ? snapshots : [snapshots]).filter(Boolean);
  if (!snaps.length) return [...pool];
  return pool.filter((boss) => snaps.every((s) => qualifiesForBoss(s, boss, bossKeysFn)));
}

/** A rough, deliberately crude "how hard is this boss to even attempt" score —
 *  summed stat gate plus whichever offensive style is cheapest to meet. Not
 *  meant to be a real difficulty ranking, only to pick a sane "easiest"
 *  fallback when literally nothing in the pool is safe for someone (e.g. a
 *  level-3 account's Boss PvM quest) — scaling that one boss's required KC up
 *  (see pickBossTargets in src/quests.js) is still better than assigning an
 *  endgame boss nobody there can touch. */
function bossDifficultyScore(bossKey) {
  const req = BOSS_REQUIREMENTS[bossKey];
  if (!req) return 0; // nothing on file — treated as trivially easy, never blocks a pick
  let score = (req.hitpoints || 0) + (req.defence || 0) + (req.prayer || 0);
  if (req.styles && req.styles.length) {
    const cheapest = Math.min(...req.styles.map((s) => Object.values(s).reduce((a, b) => a + b, 0)));
    score += cheapest;
  }
  return score;
}

/** The single lowest-difficulty-score boss in `pool`, used as the fallback
 *  target when `safeBossPool` comes back empty (nobody qualifies for
 *  anything on file). Ties break on pool order, which is fine — any of them
 *  is an equally reasonable pick. */
function pickEasiestBoss(pool) {
  return pool.reduce((best, b) => (bossDifficultyScore(b) < bossDifficultyScore(best) ? b : best), pool[0]);
}

module.exports = {
  BOSS_REQUIREMENTS,
  levelsFromSnapshot,
  meetsStatRequirements,
  hasPriorKc,
  qualifiesForBoss,
  safeBossPool,
  bossDifficultyScore,
  pickEasiestBoss,
};
