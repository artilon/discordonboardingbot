"use strict";
/**
 * Regression test for a real bug: applyItemEffects() used Math.round() to
 * apply a Reduction/Expansion item's percentage to a quest's requirement.
 * For every count-based category (Raids, Boss PvM, Minigames) the BASE
 * requirement is a small integer (e.g. a Daily Raid quest needs 3 KC), and
 * a 2%/5%/10% tier on a small integer rounds right back to the same number
 * -- e.g. 3 KC at -10% is 2.7, and Math.round(2.7) is 3. A member could buy
 * ANY tier of Quest & Threshold Reduction and see literally zero change on
 * a Daily Raid/Minigame quest, no matter how much HM they spent. The mirror
 * bug hit Quest Expansion's raids/minigames percentage mechanic too: paying
 * for it always raised the HM/Rank XP reward (rewardScale is a straight
 * percentage, unaffected by rounding) while sometimes leaving the actual
 * requirement completely unchanged -- a quiet "free reward" exploit in the
 * opposite direction.
 *
 * Fix: Reduction now floors (always rounds in the member's favour) and
 * Expansion's percentage mechanic now ceils (always rounds the requirement
 * up) -- both guarantee the item visibly does something whenever its
 * percentage is non-zero, on every category, not just ones with large base
 * values like skill XP.
 *
 * Run: node test/item-effects-rounding.test.js
 */
const assert = require("assert");
const { applyItemEffects, buildSoloTargets, SOLO_RAID_MIN_KC } = require("../src/quests");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// ---- Reduction must ALWAYS visibly lower a count-based requirement ----
// Every (category, quest-length, tier) combination that a member can
// actually buy and apply. None of these should ever equal the base value.
const COUNT_BASES = {
  raid: { daily: 3, weekly: 8, monthly: 20 },
  boss: { daily: 15, weekly: 40, monthly: 100 },
  minigame: { daily: 5, weekly: 15, monthly: 40 },
};
const TIERS_PCT = [2, 5, 10]; // ITEM_PCT_BY_TIER[1..3]

for (const [cat, lengths] of Object.entries(COUNT_BASES)) {
  for (const [qt, base] of Object.entries(lengths)) {
    for (const pct of TIERS_PCT) {
      const { value } = applyItemEffects(cat, 1, base, { reductionPct: pct });
      check(
        `${cat} ${qt} (base ${base}) tier -${pct}% Reduction visibly lowers the requirement (got ${value})`,
        value < base
      );
    }
  }
}

// ---- Expansion's raids/minigames percentage branch must ALWAYS visibly
// raise the requirement it claims to raise, matching the reward bump. ----
for (const [qt, base] of Object.entries(COUNT_BASES.raid)) {
  for (const pct of TIERS_PCT) {
    const { value, rewardScale } = applyItemEffects("raid", 1, base, { expansionPct: pct });
    check(
      `raid ${qt} (base ${base}) tier +${pct}% Expansion visibly raises the requirement (got ${value})`,
      value > base
    );
    check(`reward still scales by the full +${pct}%`, rewardScale === 1 + pct / 100);
  }
}

// ---- The exact real-world case from the bug report: a Daily Raid quest
// (base 3 KC) must change at every tier, not just the top one. ----
check("Daily Raid, Tier 1 (-2%) Reduction: 3 -> 2", applyItemEffects("raid", 1, 3, { reductionPct: 2 }).value === 2);
check("Daily Raid, Tier 2 (-5%) Reduction: 3 -> 2", applyItemEffects("raid", 1, 3, { reductionPct: 5 }).value === 2);
check("Daily Raid, Tier 3 (-10%) Reduction: 3 -> 2", applyItemEffects("raid", 1, 3, { reductionPct: 10 }).value === 2);

// ---- Large skill-XP values are unaffected by the fix (flooring a value
// that was already an exact integer product changes nothing). ----
check(
  "a large skill XP value still reduces the same way it always did",
  applyItemEffects("skill", 1, 12500, { reductionPct: 10 }).value === Math.round(12500 * 0.9)
);

// ---- No reduction/expansion owned (0%) is still a complete no-op. ----
check("0% reduction changes nothing", applyItemEffects("raid", 1, 3, { reductionPct: 0 }).value === 3);
check("no effects object at all changes nothing", applyItemEffects("raid", 1, 3, {}).value === 3);

// ---- The floor for `value` is still 1 even if a category could ever ask
// for a base requirement of 1 and still sell a Reduction item. ----
check("value never drops below 1", applyItemEffects("raid", 1, 1, { reductionPct: 10 }).value === 1);

// ---- Hard floors on a SOLO Raid quest's KC, requested explicitly: no
// amount of stacked Reduction can ever push a raid below 2 (daily), 4
// (weekly), or 8 (monthly) KC, even far beyond anything one member could
// realistically own (reductionPct is capped at 90% by aggregateTeamEffects,
// but buildSoloTargets enforces the floor regardless of what's passed in). ----
check("SOLO_RAID_MIN_KC is exactly {daily: 2, weekly: 4, monthly: 8}", JSON.stringify(SOLO_RAID_MIN_KC) === JSON.stringify({ daily: 2, weekly: 4, monthly: 8 }));

for (const [questType, floor] of Object.entries(SOLO_RAID_MIN_KC)) {
  for (const pct of [0, 2, 5, 10, 50, 90, 99]) {
    const targets = buildSoloTargets("raids", questType, null, null, { reductionPct: pct }, "easy");
    const kc = Object.values(targets.bosses)[0];
    check(`SOLO raid ${questType} never drops below its floor of ${floor} (reductionPct=${pct}% -> ${kc})`, kc >= floor);
  }
}

// No reduction at all must still return exactly the base KC (the floor must
// never raise a requirement that didn't need lowering in the first place).
check("daily raid with 0% reduction is still the base 3 KC, not floored up", Object.values(buildSoloTargets("raids", "daily", null, null, null, "easy").bosses)[0] === 3);
check("weekly raid with 0% reduction is still the base 8 KC", Object.values(buildSoloTargets("raids", "weekly", null, null, null, "easy").bosses)[0] === 8);
check("monthly raid with 0% reduction is still the base 20 KC", Object.values(buildSoloTargets("raids", "monthly", null, null, null, "easy").bosses)[0] === 20);

// A light reduction that wouldn't hit the floor anyway still reduces normally.
check("daily raid at a light -2% still reduces normally (3 -> 2), same as the floor here", Object.values(buildSoloTargets("raids", "daily", null, null, { reductionPct: 2 }, "easy").bosses)[0] === 2);
check("monthly raid at -10% reduces normally to 18, well above its floor of 8", Object.values(buildSoloTargets("raids", "monthly", null, null, { reductionPct: 10 }, "easy").bosses)[0] === 18);

console.log(`\n[item-effects-rounding] ${passed} checks passed.`);
