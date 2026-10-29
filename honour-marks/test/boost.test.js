"use strict";
/**
 * Boosts used to be display-only: getBoostMultiplier() was defined, exported,
 * and never called anywhere on the XP path. This suite proves the opposite —
 * that an active boost actually changes the Rank XP a finished quest queues
 * into pending_rank_xp — end to end through src/progress.js, src/xpqueue.js
 * and src/shop.js, against a fake Supabase client. No network required.
 *
 * Run: node test/boost.test.js
 */
const assert = require("assert");
const { createFakeSupabase } = require("./fake-supabase");

// ── Fake Supabase, installed before anything requires ./db ───────────────────
const fake = createFakeSupabase({
  hm_quests: [],
  hm_active_boosts: [],
  hm_balances: [],
  hm_transactions: [],
  hm_quest_completions: [],
  hm_quest_counts: [],
  hm_members: [],
  hm_party_quests: [],
  hm_party_quest_completions: [],
  pending_rank_xp: [],
});

const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { getSupabase: () => fake },
};

// ── Fake hiscores, installed before anything requires ./jagex ────────────────
// diffProgress, cleanRsn etc. stay real — only the network call is faked, so
// the real completion maths (diffProgress) is still exercised honestly.
const realJagex = require("../src/jagex");
let nextSnapshot = null;
const jagexPath = require.resolve("../src/jagex");
require.cache[jagexPath] = {
  id: jagexPath,
  filename: jagexPath,
  loaded: true,
  exports: { ...realJagex, fetchHiscores: async () => nextSnapshot },
};

const { getBoostMultiplier, BOOST_TIERS, consumeItem, grantConsumable } = require("../src/shop");
const { checkSoloQuests, completePartyQuest } = require("../src/progress");
const { awardRankXp } = require("../src/xpqueue");
const { cancelSoloQuest } = require("../src/quests");

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

(async () => {
  console.log("\n[boost pricing]");
  await check("boost prices are 3x the original tuning", () => {
    assert.deepStrictEqual(BOOST_TIERS.map((t) => t.cost), [750, 2250, 7500]);
    assert.deepStrictEqual(BOOST_TIERS.map((t) => t.multiplier), [1.5, 2.0, 2.5]);
  });

  console.log("\n[awardRankXp multiplier]");
  await check("no multiplier behaves exactly like flat XP", async () => {
    const r = await awardRankXp({
      guildId: "g1", userId: "u-flat", eventKey: "quest_solo_daily",
      discriminator: "flat-1",
    });
    assert.strictEqual(r.amount, 100);
  });

  await check("a 1.5x multiplier rounds the queued amount", async () => {
    const r = await awardRankXp({
      guildId: "g1", userId: "u-mult", eventKey: "quest_solo_daily",
      discriminator: "mult-1", multiplier: 1.5,
    });
    assert.strictEqual(r.base, 100);
    assert.strictEqual(r.multiplier, 1.5);
    assert.strictEqual(r.amount, 150, "100 base x1.5 must queue 150, not 100");
  });

  await check("an invalid multiplier (0, negative, NaN) falls back to 1x, not 0", async () => {
    for (const bad of [0, -2, NaN, undefined]) {
      const r = await awardRankXp({
        guildId: "g1", userId: `u-bad-${bad}`, eventKey: "quest_solo_daily",
        discriminator: `bad-${bad}`, multiplier: bad,
      });
      assert.strictEqual(r.amount, 100, `multiplier ${bad} should behave as 1x`);
    }
  });

  console.log("\n[getBoostMultiplier]");
  await check("no active boost is 1x", async () => {
    assert.strictEqual(await getBoostMultiplier("u-none", "combat"), 1);
  });

  await check("an active boost for the matching tree applies", async () => {
    // Seed the table directly rather than going through buyBoost + activateBoost
    // (the Shop purchase flow) — this suite is testing what getBoostMultiplier
    // does with an active row, not the purchase flow itself.
    fake.db.hm_active_boosts.push({
      id: 999, user_id: "u-boosted-direct", guild_id: "g1", tree: "combat",
      multiplier: 2.0, expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.strictEqual(await getBoostMultiplier("u-boosted-direct", "combat"), 2.0);
  });

  await check("a boost for a different tree does not apply", async () => {
    fake.db.hm_active_boosts.push({
      id: 1000, user_id: "u-wrong-tree", guild_id: "g1", tree: "gathering",
      multiplier: 2.5, expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.strictEqual(await getBoostMultiplier("u-wrong-tree", "combat"), 1);
  });

  await check("an expired boost does not apply", async () => {
    fake.db.hm_active_boosts.push({
      id: 1001, user_id: "u-expired", guild_id: "g1", tree: "combat",
      multiplier: 2.5, expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    assert.strictEqual(await getBoostMultiplier("u-expired", "combat"), 1);
  });

  console.log("\n[solo quest completion actually reads the boost]");
  await check("a finished solo quest with an active boost queues the boosted Rank XP", async () => {
    const userId = "u-solo-boosted";
    fake.db.hm_active_boosts.push({
      id: 2000, user_id: userId, guild_id: "g1", tree: "gathering",
      multiplier: 1.5, expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    fake.db.hm_quests.push({
      id: 5000, guild_id: "g1", user_id: userId, quest_type: "daily", tree: "gathering",
      difficulty: "normal", hm_reward: 50,
      targets: { skills: { mining: 20000 }, bosses: {} },
      baseline: { skills: { mining: { experience: 0 } }, bosses: {} },
    });
    nextSnapshot = { skills: { mining: { experience: 20000 } }, bosses: {} };

    const result = await checkSoloQuests({ guildId: "g1", userId, memberRsn: "TestRsn" });
    assert.strictEqual(result.completed, 1);
    assert.strictEqual(result.awardedXp, 150, "100 base × 1.5 boost = 150");

    const queued = fake.db.pending_rank_xp.filter((r) => r.user_id === userId);
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(queued[0].amount, 150, "the boosted amount is what actually reaches Heimdall");

    const row = fake.db.hm_quest_completions.find((r) => r.user_id === userId);
    assert.strictEqual(row.rank_xp_awarded, 150, "#hm-database must show the boosted amount, not the base");
  });

  await check("a finished solo quest with no boost queues the flat amount", async () => {
    const userId = "u-solo-flat";
    fake.db.hm_quests.push({
      id: 5001, guild_id: "g1", user_id: userId, quest_type: "daily", tree: "gathering",
      difficulty: "normal", hm_reward: 50,
      targets: { skills: { mining: 20000 }, bosses: {} },
      baseline: { skills: { mining: { experience: 0 } }, bosses: {} },
    });
    nextSnapshot = { skills: { mining: { experience: 20000 } }, bosses: {} };

    const result = await checkSoloQuests({ guildId: "g1", userId, memberRsn: "TestRsn2" });
    assert.strictEqual(result.awardedXp, 100, "no boost must still pay exactly the flat rate");
  });

  console.log("\n[party quest completion: per-member boosts, one row]");
  await check("each party member's own boost applies, and only one completion row is written", async () => {
    fake.db.hm_members.push({ user_id: "p-boosted", guild_id: "g1", rsn: "BoostedRsn" });
    fake.db.hm_members.push({ user_id: "p-plain", guild_id: "g1", rsn: "PlainRsn" });
    fake.db.hm_active_boosts.push({
      id: 3000, user_id: "p-boosted", guild_id: "g1", tree: "combat",
      multiplier: 2.0, expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    const quest = {
      id: 9000, guild_id: "g1", tree: "combat", size: "duo", difficulty: "easy",
      hm_reward: 250, members: ["p-boosted", "p-plain"],
    };
    // completePartyQuest deletes the live quest row first (idempotency guard,
    // same trick the solo path uses) — it needs to exist to be deleted.
    fake.db.hm_party_quests.push({ ...quest });

    const before = fake.db.hm_party_quest_completions.length;
    await completePartyQuest(quest, { totalPct: 100 });
    const rows = fake.db.hm_party_quest_completions.slice(before);

    assert.strictEqual(rows.length, 1, "exactly one row per completed party quest, not one per member");
    const [row] = rows;
    assert.strictEqual(row.rank_xp_breakdown["p-boosted"], 1500, "750 base x2.0 = 1500");
    assert.strictEqual(row.rank_xp_breakdown["p-plain"], 750, "no boost = flat 750");
    assert.strictEqual(row.rank_xp_awarded, 2250, "total pool = 1500 + 750");

    const queuedBoosted = fake.db.pending_rank_xp.find((r) => r.user_id === "p-boosted" && r.reason.includes(quest.tree));
    const queuedPlain = fake.db.pending_rank_xp.find((r) => r.user_id === "p-plain" && r.reason.includes(quest.tree));
    assert.strictEqual(queuedBoosted.amount, 1500);
    assert.strictEqual(queuedPlain.amount, 750);
  });

  console.log("\n[quest skip token — cancel actually works]");
  await check("cancelling deletes the quest with no reward and no record", async () => {
    const userId = "u-cancel";
    fake.db.hm_quests.push({
      id: 7000, guild_id: "g1", user_id: userId, quest_type: "weekly", tree: "boss",
      difficulty: "normal", hm_reward: 150,
      targets: { skills: {}, bosses: { zulrah: 40 } },
      baseline: { skills: {}, bosses: { zulrah: { kills: 0 } } },
    });
    const balanceBefore = fake.db.hm_balances.find((b) => b.user_id === userId)?.balance || 0;

    const result = await cancelSoloQuest(userId, 7000);
    assert.strictEqual(result.ok, true);
    assert.ok(!fake.db.hm_quests.some((q) => q.id === 7000), "the quest row is gone");
    const balanceAfter = fake.db.hm_balances.find((b) => b.user_id === userId)?.balance || 0;
    assert.strictEqual(balanceAfter, balanceBefore, "cancelling pays nothing — no HM, no XP");
  });

  await check("cancelling a quest that already finished/expired fails cleanly", async () => {
    const result = await cancelSoloQuest("u-cancel", 999999);
    assert.ok(result.error, "should report an error instead of pretending it worked");
  });

  await check("cancelling someone else's quest is refused", async () => {
    fake.db.hm_quests.push({
      id: 7001, guild_id: "g1", user_id: "owner-of-quest", quest_type: "daily", tree: "gathering",
      targets: {}, baseline: {}, hm_reward: 50,
    });
    const result = await cancelSoloQuest("someone-else", 7001);
    assert.ok(result.error);
    assert.ok(fake.db.hm_quests.some((q) => q.id === 7001), "the quest must still exist — it wasn't this user's to cancel");
  });

  console.log("\n[consumables — grant/consume are real inventory operations]");
  await check("granting then consuming a token round-trips through hm_inventory", async () => {
    const userId = "u-token";
    const granted = await grantConsumable(userId, "g1", "quest_skip_token");
    assert.strictEqual(granted, true);

    const used = await consumeItem(userId, "quest_skip_token");
    assert.strictEqual(used, true, "a granted token must be consumable");

    const usedAgain = await consumeItem(userId, "quest_skip_token");
    assert.strictEqual(usedAgain, false, "a single token can't be spent twice");
  });

  console.log(`\n${passed} checks passed.\n`);
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});
