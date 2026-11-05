"use strict";
/**
 * Regression test for a real bug: raid quest progress only ever read the
 * Normal-mode hiscores stat, so clearing a raid on Challenge/Hard/Expert
 * Mode did not progress a quest at all (e.g. 3 Expert Mode ToAs gave 0
 * progress toward a "Tombs of Amascut" quest). The fix groups each raid's
 * difficulty variants together the same way The Gauntlet / Nightmare /
 * Dagannoth Kings were already grouped.
 *
 * Run: node test/raid-difficulty-grouping.test.js
 */
const assert = require("assert");
const { bossKeys, diffProgress, BOSS_GROUPS } = require("../src/jagex");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// ---- bossKeys() groups each raid's difficulty variants ----
check(
  "chambers_of_xeric groups normal + challenge mode",
  JSON.stringify(bossKeys("chambers_of_xeric").sort()) ===
    JSON.stringify(["chambers_of_xeric", "chambers_of_xeric_challenge_mode"].sort())
);
check(
  "theatre_of_blood groups normal + hard mode",
  JSON.stringify(bossKeys("theatre_of_blood").sort()) ===
    JSON.stringify(["theatre_of_blood", "theatre_of_blood_hard_mode"].sort())
);
check(
  "tombs_of_amascut groups normal + expert mode",
  JSON.stringify(bossKeys("tombs_of_amascut").sort()) ===
    JSON.stringify(["tombs_of_amascut", "tombs_of_amascut_expert_mode"].sort())
);

// Pre-existing groups must still work (no regression from this change).
check(
  "the_gauntlet grouping is untouched",
  JSON.stringify(bossKeys("the_gauntlet").sort()) === JSON.stringify(["the_gauntlet", "the_corrupted_gauntlet"].sort())
);
check(
  "dagannoth_kings grouping is untouched",
  JSON.stringify(bossKeys("dagannoth_kings").sort()) ===
    JSON.stringify(["dagannoth_prime", "dagannoth_rex", "dagannoth_supreme"].sort())
);

// ---- The actual bug: diffProgress() must count Expert/Hard/Challenge Mode KC ----
const baseline = {
  bosses: {
    tombs_of_amascut: { kills: 10 },
    tombs_of_amascut_expert_mode: { kills: 2 },
  },
};

// Member did 0 regular-mode ToA, but 3 Expert Mode ToA, between baseline and now.
const current = {
  bosses: {
    tombs_of_amascut: { kills: 10 },
    tombs_of_amascut_expert_mode: { kills: 5 },
  },
};

const targets = { bosses: { tombs_of_amascut: 3 } };
const result = diffProgress(baseline, current, targets);
const toaPart = result.parts.find((p) => p.key === "tombs_of_amascut");

check("3 Expert Mode ToA clears are NOT ignored (this was the bug)", toaPart.gained === 3);
check("3/3 needed Expert Mode clears completes the quest (100%)", toaPart.pct === 100);

// Mixed normal + expert clears must add together, not double count or overwrite.
const current2 = {
  bosses: {
    tombs_of_amascut: { kills: 12 }, // +2 normal
    tombs_of_amascut_expert_mode: { kills: 4 }, // +2 expert
  },
};
const mixedResult = diffProgress(baseline, current2, targets);
const mixedPart = mixedResult.parts.find((p) => p.key === "tombs_of_amascut");
check("normal + expert clears are summed together (2 + 2 = 4)", mixedPart.gained === 4);

// Chambers of Xeric Challenge Mode and Theatre of Blood Hard Mode, same check.
const coxResult = diffProgress(
  { bosses: { chambers_of_xeric: { kills: 0 }, chambers_of_xeric_challenge_mode: { kills: 0 } } },
  { bosses: { chambers_of_xeric: { kills: 0 }, chambers_of_xeric_challenge_mode: { kills: 4 } } },
  { bosses: { chambers_of_xeric: 4 } }
);
check(
  "Chambers of Xeric Challenge Mode clears count toward a normal CoX quest",
  coxResult.parts.find((p) => p.key === "chambers_of_xeric").gained === 4
);

const tobResult = diffProgress(
  { bosses: { theatre_of_blood: { kills: 0 }, theatre_of_blood_hard_mode: { kills: 0 } } },
  { bosses: { theatre_of_blood: { kills: 0 }, theatre_of_blood_hard_mode: { kills: 2 } } },
  { bosses: { theatre_of_blood: 2 } }
);
check(
  "Theatre of Blood Hard Mode clears count toward a normal ToB quest",
  tobResult.parts.find((p) => p.key === "theatre_of_blood").gained === 2
);

// Sanity: every raid key referenced is actually present in BOSS_GROUPS.
check("BOSS_GROUPS has all three raid entries", ["chambers_of_xeric", "theatre_of_blood", "tombs_of_amascut"].every((k) => Array.isArray(BOSS_GROUPS[k])));

console.log(`\n[raid-difficulty-grouping] ${passed} checks passed.`);
