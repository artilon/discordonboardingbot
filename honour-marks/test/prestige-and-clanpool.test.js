"use strict";
/**
 * Covers everything added in this batch:
 *   - Skilling quest difficulty tiers (SOLO_SKILL_DIFFICULTY / SOLO_SKILL_XP)
 *   - Prestige (one-time, permanent, account-wide +10% HM / +25% Rank XP)
 *   - Clan Pool (one shared monthly quest + its 2 possible clan-wide boosts)
 *
 * Run: node test/prestige-and-clanpool.test.js
 */
const assert = require("assert");
const { createFakeSupabase } = require("./fake-supabase");

const fake = createFakeSupabase({
  hm_members: [],
  hm_balances: [],
  hm_transactions: [],
  hm_prestige: [],
  hm_inventory: [],
  hm_clan_quest: [],
  hm_clan_boost: [],
  hm_clan_quest_completions: [],
  hm_quest_completions: [],
  hm_party_quest_completions: [],
});

const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { getSupabase: () => fake },
};

// fetchHiscores is swapped for a controllable fake keyed by RSN; everything
// else in jagex (bossKeys, diffProgress, ...) stays real.
const realJagex = require("../src/jagex");
const snapshots = {}; // rsn -> snapshot
const jagexPath = require.resolve("../src/jagex");
require.cache[jagexPath] = {
  id: jagexPath, filename: jagexPath, loaded: true,
  exports: { ...realJagex, fetchHiscores: async (rsn) => snapshots[rsn] || null },
};

const q = require("../src/quests");
const shop = require("../src/shop");
const clanpool = require("../src/clanpool");
const { renderGuide } = require("../src/panels");

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

async function registerMember(userId, rsn, guildId = "g1") {
  fake.db.hm_members.push({ user_id: userId, guild_id: guildId, rsn, active: true });
}

(async () => {
  console.log("\n[skilling quest difficulty tiers]");
  await check("count/mult doubles 1/2/3/4 across easy/medium/hard/extreme", () => {
    assert.deepStrictEqual(q.SOLO_SKILL_DIFFICULTIES, ["easy", "medium", "hard", "extreme"]);
    assert.strictEqual(q.SOLO_SKILL_DIFFICULTY.easy.count, 1);
    assert.strictEqual(q.SOLO_SKILL_DIFFICULTY.medium.count, 2);
    assert.strictEqual(q.SOLO_SKILL_DIFFICULTY.hard.count, 3);
    assert.strictEqual(q.SOLO_SKILL_DIFFICULTY.extreme.count, 4);
    for (const key of q.SOLO_SKILL_DIFFICULTIES) {
      assert.strictEqual(q.SOLO_SKILL_DIFFICULTY[key].mult, q.SOLO_SKILL_DIFFICULTY[key].count, `${key}: mult should equal count`);
    }
  });

  await check("each tier is +25% XP over the last, for every quest length", () => {
    for (const period of ["daily", "weekly", "monthly"]) {
      const table = q.SOLO_SKILL_XP[period];
      assert.strictEqual(Math.round(table.medium / table.easy * 100) / 100, 1.25, `${period} medium/easy`);
      assert.strictEqual(Math.round(table.hard / table.easy * 100) / 100, 1.5, `${period} hard/easy`);
      assert.strictEqual(Math.round(table.extreme / table.easy * 100) / 100, 1.75, `${period} extreme/easy`);
    }
  });

  await check("Weekly's Hard tier reproduces the old flat Weekly per-skill XP (75,000) exactly", () => {
    assert.strictEqual(q.SOLO_SKILL_XP.weekly.hard, 75000);
  });

  await check("stated Easy values match the spec exactly: 50k/week, quartered for daily, doubled for monthly", () => {
    assert.strictEqual(q.SOLO_SKILL_XP.weekly.easy, 50000);
    assert.strictEqual(q.SOLO_SKILL_XP.daily.easy, 12500);
    assert.strictEqual(q.SOLO_SKILL_XP.monthly.easy, 100000);
  });

  console.log("\n[Prestige — one-time, permanent, account-wide]");
  await check("buying Prestige debits 100,000 HM and marks the member Prestiged", async () => {
    await registerMember("u-prestige", "PrestigeRsn");
    fake.db.hm_balances.push({ user_id: "u-prestige", balance: 150000, total_spent: 0 });

    assert.strictEqual(await shop.isPrestiged("u-prestige"), false);
    const result = await shop.buyPrestige({ guildId: "g1", userId: "u-prestige" });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(result.balance, 50000);
    assert.strictEqual(await shop.isPrestiged("u-prestige"), true);
  });

  await check("can't afford it: no debit, not Prestiged", async () => {
    await registerMember("u-poor", "PoorRsn");
    fake.db.hm_balances.push({ user_id: "u-poor", balance: 10, total_spent: 0 });
    const result = await shop.buyPrestige({ guildId: "g1", userId: "u-poor" });
    assert.ok(result.error);
    assert.strictEqual(await shop.isPrestiged("u-poor"), false);
  });

  await check("buying it twice fails and doesn't double-debit", async () => {
    const before = fake.db.hm_balances.find((b) => b.user_id === "u-prestige").balance;
    const result = await shop.buyPrestige({ guildId: "g1", userId: "u-prestige" });
    assert.ok(result.error);
    const after = fake.db.hm_balances.find((b) => b.user_id === "u-prestige").balance;
    assert.strictEqual(after, before);
  });

  await check("getPrestigedSet returns exactly the Prestiged members from a batch", async () => {
    const set = await shop.getPrestigedSet(["u-prestige", "u-poor", "u-nobody"]);
    assert.ok(set.has("u-prestige"));
    assert.ok(!set.has("u-poor"));
    assert.ok(!set.has("u-nobody"));
  });

  await check("prestige multipliers are exactly +10% HM and +25% Rank XP, 1x when not Prestiged", () => {
    assert.strictEqual(shop.prestigeHmMultiplier(true), 1.1);
    assert.strictEqual(shop.prestigeRankXpMultiplier(true), 1.25);
    assert.strictEqual(shop.prestigeHmMultiplier(false), 1);
    assert.strictEqual(shop.prestigeRankXpMultiplier(false), 1);
  });

  console.log("\n[Clan Pool — one shared monthly quest]");
  await check("ensureClanQuest creates exactly one quest and snapshots every registered member's baseline", async () => {
    await registerMember("u-clan1", "ClanOne", "g-clan");
    await registerMember("u-clan2", "ClanTwo", "g-clan");
    snapshots["ClanOne"] = { skills: {}, bosses: { vorkath: { kills: 5 } } };
    snapshots["ClanTwo"] = { skills: {}, bosses: { vorkath: { kills: 3 } } };

    const quest = await clanpool.ensureClanQuest("g-clan");
    assert.ok(quest);
    assert.ok(clanpool.CLAN_QUEST_TYPES.includes(quest.quest_type));
    // Only 2 members registered — well under the first 30-member threshold —
    // so this should be the plain base target for whichever type was rolled.
    assert.strictEqual(quest.target, clanpool.CLAN_QUEST_BASE_TARGETS[quest.quest_type]);
    assert.strictEqual(quest.target, clanpool.computeClanQuestTarget(quest.quest_type, 2));

    const again = await clanpool.ensureClanQuest("g-clan");
    assert.strictEqual(again.quest_type, quest.quest_type, "a second call must not create a 2nd quest");
  });

  await check("Clan Pool targets scale up by a fixed step every 10 members starting at 30", () => {
    // Below the first threshold, every category is just its base number.
    for (const n of [0, 10, 20, 29]) {
      assert.strictEqual(clanpool.clanMemberTier(n), 0, `${n} members should still be tier 0`);
    }
    assert.strictEqual(clanpool.computeClanQuestTarget("skill_xp", 0), 1_000_000);
    assert.strictEqual(clanpool.computeClanQuestTarget("boss_kc", 0), 500);
    assert.strictEqual(clanpool.computeClanQuestTarget("minigame", 0), 300);
    assert.strictEqual(clanpool.computeClanQuestTarget("quest_completions", 0), 30);

    // The bump lands exactly AT 30/40/50/60, not one before or one after.
    assert.strictEqual(clanpool.clanMemberTier(29), 0);
    assert.strictEqual(clanpool.clanMemberTier(30), 1);
    assert.strictEqual(clanpool.clanMemberTier(39), 1);
    assert.strictEqual(clanpool.clanMemberTier(40), 2);
    assert.strictEqual(clanpool.clanMemberTier(49), 2);
    assert.strictEqual(clanpool.clanMemberTier(50), 3);

    // At 50 members (3 steps past the base) every category has stepped up 3 times.
    assert.strictEqual(clanpool.computeClanQuestTarget("skill_xp", 50), 1_000_000 + 3 * 250_000);
    assert.strictEqual(clanpool.computeClanQuestTarget("boss_kc", 50), 500 + 3 * 25);
    assert.strictEqual(clanpool.computeClanQuestTarget("minigame", 50), 300 + 3 * 25);
    assert.strictEqual(clanpool.computeClanQuestTarget("quest_completions", 50), 30 + 3 * 5);
  });

  await check("a quest started with more registered members locks in the scaled-up target", async () => {
    for (let i = 0; i < 30; i++) {
      await registerMember(`u-scale${i}`, `ScaleRsn${i}`, "g-scale");
      snapshots[`ScaleRsn${i}`] = { skills: {}, bosses: {} };
    }
    fake.db.hm_clan_quest = fake.db.hm_clan_quest.filter((r) => r.guild_id !== "g-scale");
    const quest = await clanpool.ensureClanQuest("g-scale");
    assert.strictEqual(quest.target, clanpool.computeClanQuestTarget(quest.quest_type, 30));
    assert.strictEqual(clanpool.clanMemberTier(30), 1, "30 registered members should already be tier 1");
  });

  await check("progress sums every member's delta vs their own baseline; a lazy-joined member starts at 0", async () => {
    fake.db.hm_clan_quest = [{ guild_id: "g-boss", quest_type: "boss_kc", target: 10, baselines: { "u-b1": 5, "u-b2": 3 } }];
    await registerMember("u-b1", "BossOne", "g-boss");
    await registerMember("u-b2", "BossTwo", "g-boss");
    snapshots["BossOne"] = { skills: {}, bosses: { vorkath: { kills: 8 } } }; // +3
    snapshots["BossTwo"] = { skills: {}, bosses: { vorkath: { kills: 6 } } }; // +3

    const result = await clanpool.checkClanQuestProgress("g-boss");
    assert.strictEqual(result.completed, false);
    assert.strictEqual(result.progress, 6);

    // A brand new member joins mid-quest — lazily tracked at their CURRENT
    // total, so nothing they did before counts and nothing is credited yet.
    await registerMember("u-b3", "BossThree", "g-boss");
    snapshots["BossThree"] = { skills: {}, bosses: { vorkath: { kills: 99 } } };
    const result2 = await clanpool.checkClanQuestProgress("g-boss");
    assert.strictEqual(result2.progress, 6, "the new member contributes nothing on the tick they're first tracked");
    const stored = fake.db.hm_clan_quest.find((r) => r.guild_id === "g-boss");
    assert.strictEqual(stored.baselines["u-b3"], 99);
  });

  await check("hitting the target completes the quest, picks a boost, and immediately starts the next one", async () => {
    fake.db.hm_clan_quest = [{ guild_id: "g-done", quest_type: "boss_kc", target: 10, baselines: { "u-d1": 0 } }];
    await registerMember("u-d1", "DoneOne", "g-done");
    snapshots["DoneOne"] = { skills: {}, bosses: { vorkath: { kills: 10 } } }; // exactly hits the target

    const result = await clanpool.checkClanQuestProgress("g-done");
    assert.strictEqual(result.completed, true);
    assert.ok(["hm_gain", "rank_xp"].includes(result.boost.kind));
    assert.ok(result.next, "a new quest must start immediately, no gap");

    const boost = await clanpool.getActiveClanBoost("g-done");
    assert.strictEqual(boost.kind, result.boost.kind);
    assert.strictEqual(boost.bonus_pct, clanpool.CLAN_BOOST_PCT);

    const expiresIn = new Date(boost.expires_at).getTime() - new Date(boost.started_at).getTime();
    assert.strictEqual(expiresIn, clanpool.CLAN_BOOST_DURATION_MS, "a clan boost always lasts exactly 1 week");
  });

  await check("a new clan boost replaces rather than stacks with a still-active one", async () => {
    const first = await clanpool.getActiveClanBoost("g-done");
    fake.db.hm_clan_quest = [{ guild_id: "g-done", quest_type: "quest_completions", target: 1, baselines: {} }];
    const result = await clanpool.checkClanQuestProgress("g-done"); // no members -> 0 progress, won't complete
    assert.strictEqual(result.completed, false);

    // Force another completion to prove replacement, not accumulation.
    await clanpool.completeClanQuest("g-done", { quest_type: "quest_completions", target: 1 });
    const rows = fake.db.hm_clan_boost.filter((b) => b.guild_id === "g-done");
    assert.strictEqual(rows.length, 1, "exactly one boost row per guild — never more");
  });

  await check("clanBoostMultiplier only applies to its own kind, and is 1x with no active boost", () => {
    const hmBoost = { kind: "hm_gain", bonus_pct: 5 };
    assert.strictEqual(clanpool.clanBoostMultiplier(hmBoost, "hm_gain"), 1.05);
    assert.strictEqual(clanpool.clanBoostMultiplier(hmBoost, "rank_xp"), 1, "wrong kind must not apply");
    assert.strictEqual(clanpool.clanBoostMultiplier(null, "hm_gain"), 1);
  });

  console.log("\n[Guide documents all 4 new features]");
  await check("the guide has a dedicated Prestige page with the right numbers", () => {
    const pages = renderGuide({ channels: { claim: "1", quests: "2", shop: "3", database: "4" } });
    const prestigePage = pages.find((p) => p.embed.data.title.includes("Prestige"));
    assert.ok(prestigePage, "a Prestige page should exist");
    const desc = prestigePage.embed.data.description;
    assert.ok(desc.includes("100,000"), "should state the 100,000 HM cost");
    assert.ok(/10%/.test(desc) && /25%/.test(desc), "should state +10% HM and +25% Rank XP");
  });

  await check("the Consumables page documents the daily free Skip Token grant", () => {
    const pages = renderGuide({ channels: { claim: "1", quests: "2", shop: "3", database: "4" } });
    const consumablesPage = pages.find((p) => p.embed.data.title.includes("Consumables"));
    assert.ok(consumablesPage, "a Consumables page should exist");
    assert.ok(/daily/i.test(consumablesPage.embed.data.description) && /midnight/i.test(consumablesPage.embed.data.description));
  });

  await check("the Solo Quests page documents the skilling difficulty tiers and exact XP table", () => {
    const pages = renderGuide({ channels: { claim: "1", quests: "2", shop: "3", database: "4" } });
    const soloPage = pages.find((p) => p.embed.data.title.includes("Solo Quests"));
    assert.ok(soloPage, "a Solo Quests page should exist");
    const desc = soloPage.embed.data.description;
    for (const needle of ["Easy", "Medium", "Hard", "Extreme", "50,000", "62,500", "75,000", "87,500"]) {
      assert.ok(desc.includes(needle), `Solo Quests page should mention "${needle}"`);
    }
  });

  await check("the guide has a dedicated Clan Pool page naming all 4 quest types and both boosts", () => {
    const pages = renderGuide({ channels: { claim: "1", quests: "2", shop: "3", database: "4" } });
    const clanPoolPage = pages.find((p) => p.embed.data.title.includes("Clan Pool"));
    assert.ok(clanPoolPage, "a Clan Pool page should exist");
    const desc = clanPoolPage.embed.data.description;
    for (const needle of ["Skilling XP", "Boss PvM KC", "Minigame Completions", "HM Quests Completed", "coin flip", "1 week"]) {
      assert.ok(desc.includes(needle), `Clan Pool page should mention "${needle}"`);
    }
  });

  console.log(`\n${passed} checks passed.`);
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
