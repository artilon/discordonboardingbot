"use strict";
/**
 * Regression test for a real bug: TEAM (party) raid quest progress only ever
 * read a teammate's NORMAL-mode hiscores stat for a raid, completely
 * ignoring Challenge/Hard/Expert Mode clears — e.g. a teammate who did
 * nothing but Expert Mode Tombs of Amascut contributed ZERO toward a team
 * "Tombs of Amascut" quest's shared total, even though the exact same bug
 * was already fixed for SOLO quests (see raid-difficulty-grouping.test.js)
 * and the Clan Pool (clanpool.js already calls bossKeys() for boss_kc).
 *
 * checkPartyQuest() in src/progress.js summed each member's own gain with
 * its own hand-rolled loop instead of going through diffProgress()/
 * bossKeys() like every other progress path — so the earlier raid-grouping
 * fix never actually reached team quests. This covers the fix: it now
 * expands each target through bossKeys() too, same as everywhere else.
 *
 * Run: node test/party-quest-raid-difficulty.test.js
 */
const assert = require("assert");
const { createFakeSupabase } = require("./fake-supabase");

const fake = createFakeSupabase({
  hm_members: [],
});

const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { getSupabase: () => fake },
};

const realJagex = require("../src/jagex");
const snapshots = {};
const jagexPath = require.resolve("../src/jagex");
require.cache[jagexPath] = {
  id: jagexPath, filename: jagexPath, loaded: true,
  exports: { ...realJagex, fetchHiscores: async (rsn) => snapshots[rsn] || null },
};

const { checkPartyQuest } = require("../src/progress");

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

function registerMember(userId, rsn) {
  fake.db.hm_members.push({ user_id: userId, guild_id: "g1", rsn, active: true });
}

(async () => {
  console.log("\n[Team quest raid progress now counts every difficulty variant, not just Normal mode]");

  await check("a teammate who ONLY did Expert Mode ToA still contributes to a team 'Tombs of Amascut' quest", async () => {
    registerMember("mate-1", "ExpertOnly");
    registerMember("mate-2", "NormalOnly");
    snapshots["ExpertOnly"] = { skills: {}, bosses: { tombs_of_amascut: { kills: 0 }, tombs_of_amascut_expert_mode: { kills: 3 } } };
    snapshots["NormalOnly"] = { skills: {}, bosses: { tombs_of_amascut: { kills: 2 }, tombs_of_amascut_expert_mode: { kills: 0 } } };

    const quest = {
      id: 1, guild_id: "g1", size: "duo", tree: "raids",
      members: ["mate-1", "mate-2"],
      targets: { skills: {}, bosses: { tombs_of_amascut: 5 } },
      baseline: {
        "mate-1": { skills: {}, bosses: { tombs_of_amascut: { kills: 0 }, tombs_of_amascut_expert_mode: { kills: 0 } } },
        "mate-2": { skills: {}, bosses: { tombs_of_amascut: { kills: 0 }, tombs_of_amascut_expert_mode: { kills: 0 } } },
      },
    };

    const result = await checkPartyQuest(quest);
    assert.ok(!result.error, result.error);
    const part = result.progress.parts.find((p) => p.key === "tombs_of_amascut");
    // 3 (Expert, mate-1) + 2 (Normal, mate-2) = 5/5 -> complete.
    assert.strictEqual(part.gained, 5, "Expert Mode clears must be summed in, not silently dropped");
    assert.ok(result.finished, "5/5 combined (3 expert + 2 normal) should finish the quest");
  });

  await check("Theatre of Blood Hard Mode clears also count toward a team ToB quest", async () => {
    registerMember("tob-1", "TobHardOnly");
    snapshots["TobHardOnly"] = { skills: {}, bosses: { theatre_of_blood: { kills: 0 }, theatre_of_blood_hard_mode: { kills: 2 } } };

    const quest = {
      id: 2, guild_id: "g1", size: "duo", tree: "raids",
      members: ["tob-1"],
      targets: { skills: {}, bosses: { theatre_of_blood: 2 } },
      baseline: { "tob-1": { skills: {}, bosses: { theatre_of_blood: { kills: 0 }, theatre_of_blood_hard_mode: { kills: 0 } } } },
    };

    const result = await checkPartyQuest(quest);
    const part = result.progress.parts.find((p) => p.key === "theatre_of_blood");
    assert.strictEqual(part.gained, 2);
    assert.ok(result.finished);
  });

  await check("Chambers of Xeric Challenge Mode clears also count toward a team CoX quest", async () => {
    registerMember("cox-1", "CoxChallengeOnly");
    snapshots["CoxChallengeOnly"] = { skills: {}, bosses: { chambers_of_xeric: { kills: 1 }, chambers_of_xeric_challenge_mode: { kills: 3 } } };

    const quest = {
      id: 3, guild_id: "g1", size: "duo", tree: "raids",
      members: ["cox-1"],
      targets: { skills: {}, bosses: { chambers_of_xeric: 3 } },
      baseline: { "cox-1": { skills: {}, bosses: { chambers_of_xeric: { kills: 1 }, chambers_of_xeric_challenge_mode: { kills: 0 } } } },
    };

    const result = await checkPartyQuest(quest);
    const part = result.progress.parts.find((p) => p.key === "chambers_of_xeric");
    assert.strictEqual(part.gained, 3, "+0 normal, +3 challenge mode = 3");
    assert.ok(result.finished);
  });

  await check("a non-raid boss target (no grouping) is unaffected — still just itself", async () => {
    registerMember("zul-1", "ZulrahOnly");
    snapshots["ZulrahOnly"] = { skills: {}, bosses: { zulrah: { kills: 10 } } };

    const quest = {
      id: 4, guild_id: "g1", size: "duo", tree: "boss",
      members: ["zul-1"],
      targets: { skills: {}, bosses: { zulrah: 10 } },
      baseline: { "zul-1": { skills: {}, bosses: { zulrah: { kills: 0 } } } },
    };

    const result = await checkPartyQuest(quest);
    const part = result.progress.parts.find((p) => p.key === "zulrah");
    assert.strictEqual(part.gained, 10);
    assert.ok(result.finished);
  });

  console.log(`\n${passed} checks passed.\n`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
