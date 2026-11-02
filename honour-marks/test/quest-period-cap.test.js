"use strict";
/**
 * Covers the per-period solo quest completion cap (SOLO_QUEST_PERIOD_CAP):
 * up to 5 Daily, 3 Weekly, and 2 Monthly solo quests can be COMPLETED within
 * one reset period before that type locks until the next reset. This is
 * separate from the "one active quest per type at a time" slot rule, which
 * is unaffected by this cap.
 *
 * Run: node test/quest-period-cap.test.js
 */
const assert = require("assert");
const { createFakeSupabase } = require("./fake-supabase");

const fake = createFakeSupabase({
  hm_quests: [],
  hm_party_quests: [],
  hm_quest_counts: [],
  hm_members: [],
});

const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { getSupabase: () => fake },
};

// fetchHiscores is swapped for a controllable fake; everything else in jagex
// stays real, matching the pattern used by test/items-and-safety.test.js.
const realJagex = require("../src/jagex");
const snapshots = {};
const jagexPath = require.resolve("../src/jagex");
require.cache[jagexPath] = {
  id: jagexPath, filename: jagexPath, loaded: true,
  exports: { ...realJagex, fetchHiscores: async (rsn) => snapshots[rsn] || null },
};

const q = require("../src/quests");

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

function snapshotWithLevels(levels) {
  const skills = {};
  for (const [k, lvl] of Object.entries(levels)) skills[k] = { level: lvl, experience: lvl * 1000 };
  return { skills, bosses: {} };
}

async function registerMember(userId, rsn) {
  fake.db.hm_members.push({ user_id: userId, guild_id: "g1", rsn });
  snapshots[rsn] = snapshotWithLevels({ mining: 50, fishing: 50, woodcutting: 50, farming: 50, hunter: 50 });
}

function pushCounts(userId, questType, used) {
  const resetKey = `${questType}_reset`;
  const usedKey = `${questType}_used`;
  fake.db.hm_quest_counts.push({
    user_id: userId,
    guild_id: "g1",
    [usedKey]: used,
    [resetKey]: q.resetStampFor(questType),
  });
}

(async () => {
  console.log("[SOLO_QUEST_PERIOD_CAP — raised limits: 5 Daily / 3 Weekly / 2 Monthly]");

  await check("the exported caps are exactly 5 Daily / 3 Weekly / 2 Monthly", () => {
    assert.deepStrictEqual(q.SOLO_QUEST_PERIOD_CAP, { daily: 5, weekly: 3, monthly: 2 });
  });

  for (const questType of ["daily", "weekly", "monthly"]) {
    const cap = q.SOLO_QUEST_PERIOD_CAP[questType];

    await check(`${questType}: allowed at ${cap - 1}/${cap} already completed this period`, async () => {
      const userId = `u-${questType}-under`;
      await registerMember(userId, `Rsn${questType}Under`);
      pushCounts(userId, questType, cap - 1);

      const member = await q.getMember(userId);
      const result = await q.createSoloQuest({ guildId: "g1", member, tree: "gathering", questType });
      assert.strictEqual(result.ok, true, result.error);
    });

    await check(`${questType}: blocked at ${cap}/${cap} already completed this period`, async () => {
      const userId = `u-${questType}-at-cap`;
      await registerMember(userId, `Rsn${questType}AtCap`);
      pushCounts(userId, questType, cap);

      const member = await q.getMember(userId);
      const result = await q.createSoloQuest({ guildId: "g1", member, tree: "gathering", questType });
      assert.ok(result.error, "expected the period cap to reject this quest");
      assert.ok(
        result.error.includes(String(cap)),
        `error message should mention the cap (${cap}): "${result.error}"`
      );
    });
  }

  await check("a stale reset stamp (previous period) doesn't carry the old count forward", async () => {
    const userId = "u-daily-stale";
    await registerMember(userId, "RsnDailyStale");
    // Used up last period's cap, but the reset stamp is NOT today's — this
    // must read as 0 used for the current period, same as getCounts()
    // already does for any other reset cycle.
    fake.db.hm_quest_counts.push({
      user_id: userId,
      guild_id: "g1",
      daily_used: q.SOLO_QUEST_PERIOD_CAP.daily,
      daily_reset: "2000-01-01",
    });

    const member = await q.getMember(userId);
    const result = await q.createSoloQuest({ guildId: "g1", member, tree: "gathering", questType: "daily" });
    assert.strictEqual(result.ok, true, result.error);
  });

  console.log(`\n${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
