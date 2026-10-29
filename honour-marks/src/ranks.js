"use strict";

/**
 * Rank ladder. Mirrors Heimdall's RANK_TIERS exactly — this bot only READS the
 * ladder to display progress; Heimdall owns it and is the only writer of
 * clan_members.xp. Keep the two tables in sync if the ladder ever changes.
 */
const RANK_TIERS = [
  { name: "Bronze",      xpNeeded: 0 },
  { name: "Steel",       xpNeeded: 2500 },
  { name: "Black",       xpNeeded: 10000 },
  { name: "Mithril",     xpNeeded: 20000 },
  { name: "Adamant",     xpNeeded: 42500 },
  { name: "Rune",        xpNeeded: 65000 },
  { name: "Dragon",      xpNeeded: 105000 },
  { name: "Sapphire",    xpNeeded: 155000 },
  { name: "Emerald",     xpNeeded: 220000 },
  { name: "Ruby",        xpNeeded: 295000 },
  { name: "Diamond",     xpNeeded: 400000 },
  { name: "Dragonstone", xpNeeded: 500000 },
  { name: "Onyx",        xpNeeded: 655000 },
  { name: "Zenyte",      xpNeeded: 780000 },
  { name: "Legacy",      xpNeeded: 1045000 },
];

const PROGRESS_SEGMENTS = 10;

function getRankIndex(name) {
  if (!name) return 0;
  const idx = RANK_TIERS.findIndex((t) => t.name.toLowerCase() === String(name).toLowerCase());
  return idx === -1 ? 0 : idx;
}

function getRankForXp(xp) {
  const numeric = Number(xp) || 0;
  let current = RANK_TIERS[0];
  for (const tier of RANK_TIERS) {
    if (numeric >= tier.xpNeeded) current = tier;
    else break;
  }
  return current;
}

function getNextRankTier(rankName) {
  const idx = getRankIndex(rankName);
  return idx >= RANK_TIERS.length - 1 ? null : RANK_TIERS[idx + 1];
}

/** `▰▰▰▱▱▱▱▱▱▱ 26% → Onyx (39,950 XP)` — the same shape Heimdall renders. */
function formatRankProgress(xp) {
  const numeric = Number(xp) || 0;
  const tier = getRankForXp(numeric);
  const next = getNextRankTier(tier.name);

  if (!next) return "▰▰▰▰▰▰▰▰▰▰ **Max rank reached**";

  const span = next.xpNeeded - tier.xpNeeded;
  const into = Math.max(0, numeric - tier.xpNeeded);
  const ratio = span > 0 ? Math.min(1, into / span) : 1;
  const filled = Math.round(ratio * PROGRESS_SEGMENTS);
  const bar = "▰".repeat(filled) + "▱".repeat(PROGRESS_SEGMENTS - filled);
  const pct = span > 0 ? Math.min(100, Math.floor((into / span) * 100)) : 100;
  const remaining = Math.max(0, next.xpNeeded - numeric);

  return `${bar} ${pct}% → **${next.name}** (${remaining.toLocaleString()} XP)`;
}

module.exports = {
  RANK_TIERS,
  getRankIndex,
  getRankForXp,
  getNextRankTier,
  formatRankProgress,
};
