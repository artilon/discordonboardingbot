"use strict";
/**
 * Covers everything added in this batch:
 *   - the boss PvM safety check (src/bossSafety.js) and its fair-% fallback
 *     when fewer safe bosses exist than a quest needs
 *   - weighted skill selection (lower level = more likely, never zero)
 *   - the Items shop tier (purchase flow + stacking across a team)
 *   - the Perk-bonus fix: Perks/Items now actually change hm_reward /
 *     rank_xp_reward at quest-creation time, where they previously did
 *     nothing at all
 *
 * Run: node test/items-and-safety.test.js
 */
const assert = require("assert");
const { createFakeSupabase } = require("./fake-supabase");

const fake = createFakeSupabase({
  hm_quests: [],
  hm_party_quests: [],
  hm_quest_counts: [],
  hm_members: [],
  hm_balances: [],
  hm_transactions: [],
  hm_perks: [],
  hm_items: [],
});

const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { getSupabase: () => fake },
};

// fetchHiscores is swapped for a controllable fake; everything else in jagex
// (diffProgress, cleanRsn, SKILL_LABELS, ...) stays real.
const realJagex = require("../src/jagex");
const snapshots = {}; // rsn -> snapshot, so multiple members can differ in one test
const jagexPath = require.resolve("../src/jagex");
require.cache[jagexPath] = {
  id: jagexPath, filename: jagexPath, loaded: true,
  exports: { ...realJagex, fetchHiscores: async (rsn) => snapshots[rsn] || null },
};

const bossSafety = require("../src/bossSafety");
const q = require("../src/quests");
const shop = require("../src/shop");

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

function snapshotWithLevels(levels, bosses = {}) {
  const skills = {};
  for (const [k, lvl] of Object.entries(levels)) skills[k] = { level: lvl, experience: lvl * 1000 };
  return { skills, bosses };
}

async function registerMember(userId, rsn) {
  fake.db.hm_members.push({ user_id: userId, guild_id: "g1", rsn });
}

(async () => {
  console.log("\n[boss safety — eligibility]");
  await check("a maxed-combat snapshot qualifies for a demanding boss", () => {
    const snap = snapshotWithLevels({ hitpoints: 99, defence: 99, prayer: 99, attack: 99, strength: 99, ranged: 99, magic: 99 });
    assert.strictEqual(bossSafety.qualifiesForBoss(snap, "nex", q.bossKeys), true);
  });

  await check("a fresh low-level snapshot does not qualify for a demanding boss", () => {
    const snap = snapshotWithLevels({ hitpoints: 10, defence: 1, prayer: 1, attack: 5, strength: 5, ranged: 1, magic: 1 });
    assert.strictEqual(bossSafety.qualifiesForBoss(snap, "nex", q.bossKeys), false);
  });

  await check("prior KC overrides a failing stat check", () => {
    const snap = snapshotWithLevels(
      { hitpoints: 10, defence: 1, prayer: 1, attack: 5, strength: 5, ranged: 1, magic: 1 },
      { nex: { kills: 3 } }
    );
    assert.strictEqual(bossSafety.qualifiesForBoss(snap, "nex", q.bossKeys), true);
  });

  await check("a boss missing from BOSS_REQUIREMENTS fails open (eligible)", () => {
    const snap = snapshotWithLevels({ hitpoints: 1 });
    assert.strictEqual(bossSafety.qualifiesForBoss(snap, "not_a_real_boss_key", q.bossKeys), true);
  });

  await check("a missing/null snapshot fails open rather than blocking", () => {
    assert.strictEqual(bossSafety.qualifiesForBoss(null, "nex", q.bossKeys), true);
  });

  await check("only one OR-gated style needs to be met, not all of them", () => {
    // vorkath wants hp75/def65/prayer43 + (ranged70 OR magic70) — a pure
    // ranger with no magic should still qualify.
    const snap = snapshotWithLevels({ hitpoints: 75, defence: 65, prayer: 43, ranged: 70, magic: 1, attack: 1, strength: 1 });
    assert.strictEqual(bossSafety.qualifiesForBoss(snap, "vorkath", q.bossKeys), true);
  });

  await check("safeBossPool requires EVERY given snapshot to qualify (team gate)", () => {
    const strong = snapshotWithLevels({ hitpoints: 99, defence: 99, prayer: 99, attack: 99, strength: 99, ranged: 99, magic: 99 });
    const weak = snapshotWithLevels({ hitpoints: 35, defence: 25, prayer: 1, attack: 35, strength: 35, ranged: 1, magic: 1 });
    const pool = ["nex", "bryophyta"]; // bryophyta only needs hp30/def20/attack+strength30 — weak account should still clear it
    assert.deepStrictEqual(bossSafety.safeBossPool(pool, [strong, weak], q.bossKeys), ["bryophyta"]);
    assert.deepStrictEqual(bossSafety.safeBossPool(pool, [strong], q.bossKeys), ["nex", "bryophyta"]);
  });

  await check("pickEasiestBoss picks the lowest-requirement boss in a pool", () => {
    // obor (hp40/def30/style40) is comfortably easier on paper than nex (hp90/def80/prayer70/style90).
    assert.strictEqual(bossSafety.pickEasiestBoss(["nex", "obor"]), "obor");
  });

  console.log("\n[boss safety — fair-% fallback scaling]");
  await check("plenty of safe bosses: full count, base KC, no scaling", () => {
    const strong = snapshotWithLevels({ hitpoints: 99, defence: 99, prayer: 99, attack: 99, strength: 99, ranged: 99, magic: 99 });
    const out = q.pickBossTargets(["nex", "zalcano", "obor", "vorkath"], 2, 40, [strong]);
    assert.strictEqual(Object.keys(out).length, 2);
    for (const kc of Object.values(out)) assert.strictEqual(kc, 40, "no scaling needed when enough bosses are safe");
  });

  await check("fewer safe bosses than needed: fewer targets, KC scaled up proportionally", () => {
    // Only zalcano and obor are safe for this weak account among the 4 given
    // (nex needs hp90, vorkath needs hp75/def65/prayer43 — both out of reach).
    const weak = snapshotWithLevels({ hitpoints: 45, defence: 35, prayer: 1, attack: 45, strength: 45, ranged: 1, magic: 1 });
    const out = q.pickBossTargets(["nex", "vorkath", "zalcano", "obor"], 4, 40, [weak]);
    const keys = Object.keys(out);
    assert.strictEqual(keys.length, 2, "only the 2 actually-safe bosses are used");
    for (const kc of Object.values(out)) assert.strictEqual(kc, 80, "needed 4, only 2 safe -> 2x KC each (4/2)");
  });

  await check("zero safe bosses: falls back to exactly one, the easiest, scaled by the full target count", () => {
    const veryWeak = snapshotWithLevels({ hitpoints: 1, defence: 1, prayer: 1, attack: 1, strength: 1, ranged: 1, magic: 1 });
    const out = q.pickBossTargets(["nex", "vorkath"], 3, 40, [veryWeak]);
    assert.strictEqual(Object.keys(out).length, 1, "literally nothing qualifies -> exactly one fallback boss");
    assert.strictEqual(out.vorkath || out.nex, 120, "needed 3, only 1 used -> 3x KC (3/1)");
  });

  await check("no snapshot passed at all skips the safety filter entirely (back-compat)", () => {
    const out = q.pickBossTargets(["nex", "vorkath", "zalcano"], 2, 40, null);
    assert.strictEqual(Object.keys(out).length, 2);
    for (const kc of Object.values(out)) assert.strictEqual(kc, 40);
  });

  console.log("\n[weighted skill selection]");
  await check("weight falls as level rises, and a level-99 skill is never literally zero", () => {
    assert.strictEqual(q.skillWeight(1), 99);
    assert.strictEqual(q.skillWeight(50), 50);
    assert.strictEqual(q.skillWeight(99), 1);
    assert.ok(q.skillWeight(99) > 0, "a maxed skill must still have a nonzero chance");
  });

  await check("weighted sampling favours the lower level under a controlled roll", () => {
    const realRandom = Math.random;
    try {
      // levels: mining=1 (weight 99), fishing=50 (weight 50), woodcutting=99 (weight 1); total=150
      const levels = [{ mining: 1, fishing: 50, woodcutting: 99 }];
      Math.random = () => 0; // roll=0 -> first bucket (mining, the lowest level) is picked first
      let picks = q.pickWeightedSkills(["mining", "fishing", "woodcutting"], 1, levels);
      assert.deepStrictEqual(picks, ["mining"]);

      Math.random = () => 0.999999; // roll near max -> falls into the last, smallest-weight bucket
      picks = q.pickWeightedSkills(["mining", "fishing", "woodcutting"], 1, levels);
      assert.deepStrictEqual(picks, ["woodcutting"], "a near-maxed skill can still be rolled, just rarely");
    } finally {
      Math.random = realRandom;
    }
  });

  await check("team weighting uses the LOWEST level across members per skill", () => {
    const realRandom = Math.random;
    try {
      // Member A is maxed mining (99) but fresh fishing (1); Member B is the reverse.
      // Per-skill lowest: mining -> 1 (from B), fishing -> 1 (from A) -> both weight 99, tied at 50/50 split.
      const levels = [{ mining: 99, fishing: 1 }, { mining: 1, fishing: 99 }];
      Math.random = () => 0;
      const picks = q.pickWeightedSkills(["mining", "fishing"], 1, levels);
      assert.deepStrictEqual(picks, ["mining"], "both reduce to weight 99 via the lowest-across-team rule, first bucket wins at roll 0");
    } finally {
      Math.random = realRandom;
    }
  });

  await check("falls back to a plain uniform pick when no level data is given (back-compat)", () => {
    const picks = q.pickWeightedSkills(["mining", "fishing"], 2, null);
    assert.deepStrictEqual(picks.sort(), ["fishing", "mining"]);
  });

  console.log("\n[Items shop — catalog]");
  await check("every category has all 3 slots x 3 tiers, 63 items total", () => {
    let total = 0;
    for (const t of q.TREES) {
      for (const slot of Object.values(q.ITEM_SLOT)) {
        const tiers = shop.ITEM_CATALOG[t.key][slot];
        assert.strictEqual(tiers.length, 3);
        total += tiers.length;
      }
    }
    assert.strictEqual(total, 63);
  });

  await check("Slot 1/2 keep the original mimir.js names for combat", () => {
    const reduction = shop.ITEM_CATALOG.combat[q.ITEM_SLOT.REDUCTION].map((i) => i.name);
    assert.deepStrictEqual(reduction, ["Rusty Whetstone", "New Whetstone", "Gilded Whetstone"]);
    const clanChat = shop.ITEM_CATALOG.combat[q.ITEM_SLOT.CLAN_CHAT_XP].map((i) => i.name);
    assert.deepStrictEqual(clanChat, ["Dented Shield", "Reinforced Shield", "Gilded Shield"]);
  });

  console.log("\n[Items shop — purchase flow]");
  await check("buying an item debits HM and stores the tier (explicit select-then-write, no upsert)", async () => {
    fake.db.hm_balances.push({ user_id: "u-buyer", balance: 10000, total_spent: 0 });
    const r1 = await shop.buyItem({ guildId: "g1", userId: "u-buyer", tree: "combat", slot: q.ITEM_SLOT.REDUCTION });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.tier, 1);
    assert.strictEqual(r1.cost, 600);

    const r2 = await shop.buyItem({ guildId: "g1", userId: "u-buyer", tree: "combat", slot: q.ITEM_SLOT.REDUCTION });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.tier, 2, "second purchase upgrades the SAME row to tier 2, not a duplicate row");

    const rows = fake.db.hm_items.filter((i) => i.user_id === "u-buyer" && i.tree === "combat" && i.slot === q.ITEM_SLOT.REDUCTION);
    assert.strictEqual(rows.length, 1, "one row per (user, tree, slot), updated in place");
    assert.strictEqual(rows[0].tier, 2);
  });

  await check("can't buy past tier 3", async () => {
    fake.db.hm_balances.push({ user_id: "u-maxed", balance: 1000000, total_spent: 0 });
    await shop.buyItem({ guildId: "g1", userId: "u-maxed", tree: "utility", slot: q.ITEM_SLOT.EXPANSION });
    await shop.buyItem({ guildId: "g1", userId: "u-maxed", tree: "utility", slot: q.ITEM_SLOT.EXPANSION });
    await shop.buyItem({ guildId: "g1", userId: "u-maxed", tree: "utility", slot: q.ITEM_SLOT.EXPANSION });
    const r4 = await shop.buyItem({ guildId: "g1", userId: "u-maxed", tree: "utility", slot: q.ITEM_SLOT.EXPANSION });
    assert.ok(r4.error, "a 4th purchase of a 3-tier slot must fail");
  });

  await check("can't afford it: no debit, no row written", async () => {
    fake.db.hm_balances.push({ user_id: "u-poor", balance: 10, total_spent: 0 });
    const r = await shop.buyItem({ guildId: "g1", userId: "u-poor", tree: "combat", slot: q.ITEM_SLOT.REDUCTION });
    assert.ok(r.error);
    assert.ok(!fake.db.hm_items.some((i) => i.user_id === "u-poor"));
  });

  console.log("\n[the Perk/Item reward fix — Perks previously did nothing, now they do]");
  await check("a Perk actually raises hm_reward on the stored quest row", async () => {
    await registerMember("u-perk", "PerkRsn");
    snapshots["PerkRsn"] = snapshotWithLevels({ mining: 50 });
    fake.db.hm_perks.push({ user_id: "u-perk", guild_id: "g1", tree: "gathering", tier: 2 }); // +10% HM

    const member = await q.getMember("u-perk");
    const result = await q.createSoloQuest({ guildId: "g1", member, tree: "gathering", questType: "daily" });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_quests.find((r) => r.user_id === "u-perk");
    assert.strictEqual(row.hm_reward, Math.round(50 * 1.1), "base 50 HM x 1.10 (tier-2 perk) = 55");
  });

  await check("a Clan Chat XP item raises rank_xp_reward, not hm_reward", async () => {
    await registerMember("u-clanxp", "ClanXpRsn");
    snapshots["ClanXpRsn"] = snapshotWithLevels({ mining: 50 });
    fake.db.hm_items.push({ user_id: "u-clanxp", guild_id: "g1", tree: "gathering", slot: q.ITEM_SLOT.CLAN_CHAT_XP, tier: 3 }); // +10% Rank XP

    const member = await q.getMember("u-clanxp");
    const result = await q.createSoloQuest({ guildId: "g1", member, tree: "gathering", questType: "daily" });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_quests.find((r) => r.user_id === "u-clanxp");
    assert.strictEqual(row.hm_reward, 50, "Clan Chat XP item must not touch HM");
    assert.strictEqual(row.rank_xp_reward, Math.round(100 * 1.1), "base 100 Rank XP x 1.10 = 110");
  });

  await check("a Quest & Threshold Reduction item lowers the stored target value", async () => {
    await registerMember("u-reduce", "ReduceRsn");
    snapshots["ReduceRsn"] = snapshotWithLevels({ mining: 50, fishing: 50, woodcutting: 50, farming: 50, hunter: 50 });
    fake.db.hm_items.push({ user_id: "u-reduce", guild_id: "g1", tree: "gathering", slot: q.ITEM_SLOT.REDUCTION, tier: 3 }); // -10%

    const member = await q.getMember("u-reduce");
    const result = await q.createSoloQuest({ guildId: "g1", member, tree: "gathering", questType: "daily" });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_quests.find((r) => r.user_id === "u-reduce");
    const [value] = Object.values(row.targets.skills);
    assert.strictEqual(value, Math.round(20000 * 0.9), "base 20000 xp -10% = 18000");
  });

  await check("a Quest Expansion item on a skill quest adds extra full targets and scales the reward proportionally", async () => {
    await registerMember("u-expand", "ExpandRsn");
    snapshots["ExpandRsn"] = snapshotWithLevels({ mining: 50, fishing: 50, woodcutting: 50, farming: 50, hunter: 50 });
    fake.db.hm_items.push({ user_id: "u-expand", guild_id: "g1", tree: "gathering", slot: q.ITEM_SLOT.EXPANSION, tier: 3 }); // +3 targets

    const member = await q.getMember("u-expand");
    const result = await q.createSoloQuest({ guildId: "g1", member, tree: "gathering", questType: "daily" });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_quests.find((r) => r.user_id === "u-expand");
    assert.strictEqual(Object.keys(row.targets.skills).length, 4, "daily base count 1 + tier-3 expansion = 4 total targets");
    assert.strictEqual(row.hm_reward, 50 * 4, "4 full targets must pay exactly 4x the single-target HM, not a diminished rate");
    assert.strictEqual(row.rank_xp_reward, 100 * 4, "...and 4x the Rank XP too");
  });

  await check("a Quest Expansion item on Raids/Minigames instead adds a % requirement and matching % reward", async () => {
    await registerMember("u-expand-pct", "ExpandPctRsn");
    snapshots["ExpandPctRsn"] = snapshotWithLevels({});
    fake.db.hm_items.push({ user_id: "u-expand-pct", guild_id: "g1", tree: "raids", slot: q.ITEM_SLOT.EXPANSION, tier: 3 }); // +10%

    const member = await q.getMember("u-expand-pct");
    const result = await q.createSoloQuest({ guildId: "g1", member, tree: "raids", questType: "daily" });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_quests.find((r) => r.user_id === "u-expand-pct");
    const [kc] = Object.values(row.targets.bosses);
    assert.strictEqual(kc, Math.round(3 * 1.1), "base 3 kc +10% = 3.3 -> rounds to 3");
    assert.strictEqual(row.hm_reward, Math.round(50 * 1.1));
    assert.strictEqual(row.rank_xp_reward, Math.round(100 * 1.1));
  });

  console.log("\n[Items/Perks stack across a whole team, Quest Expansion count uses the HIGHEST tier not a sum]");
  await check("Quest & Threshold Reduction and Clan Chat XP stack additively across every team member", async () => {
    await registerMember("p1-stack", "Stack1");
    await registerMember("p2-stack", "Stack2");
    // Maxed-out stats so every boss in the pool is safe — this test is about
    // the reduction/clan-chat-xp STACKING math, not the safety filter, so the
    // KC picked should land on the single requested target at full count.
    const maxed = snapshotWithLevels({ hitpoints: 99, defence: 99, prayer: 99, attack: 99, strength: 99, ranged: 99, magic: 99 });
    snapshots["Stack1"] = maxed;
    snapshots["Stack2"] = maxed;
    fake.db.hm_items.push({ user_id: "p1-stack", guild_id: "g1", tree: "boss", slot: q.ITEM_SLOT.REDUCTION, tier: 1 }); // -2%
    fake.db.hm_items.push({ user_id: "p2-stack", guild_id: "g1", tree: "boss", slot: q.ITEM_SLOT.REDUCTION, tier: 2 }); // -5%
    fake.db.hm_items.push({ user_id: "p1-stack", guild_id: "g1", tree: "boss", slot: q.ITEM_SLOT.CLAN_CHAT_XP, tier: 1 }); // +2%

    const result = await q.createPartyQuest({
      guildId: "g1", members: ["p1-stack", "p2-stack"], tree: "boss", size: "duo", difficulty: "easy",
    });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_party_quests.find((r) => r.members.includes("p1-stack"));
    assert.strictEqual(Object.keys(row.targets.bosses).length, 1, "duo boss base count is 1 and nothing expanded it");
    const [kc] = Object.values(row.targets.bosses);
    // duo boss base kc = 150, team reduction = 2+5 = 7% off
    assert.strictEqual(kc, Math.round(150 * 0.93));
    assert.strictEqual(row.rank_xp_reward, Math.round(750 * 1.02), "team clan-chat-xp sum = 2%, only p1 owns it");
  });

  await check("Quest Expansion's extra-target-COUNT effect uses the team's highest tier, not a sum", async () => {
    await registerMember("p1-exp", "Exp1");
    await registerMember("p2-exp", "Exp2");
    snapshots["Exp1"] = snapshotWithLevels({ mining: 50, fishing: 50, woodcutting: 50, farming: 50, hunter: 50 });
    snapshots["Exp2"] = snapshotWithLevels({ mining: 50, fishing: 50, woodcutting: 50, farming: 50, hunter: 50 });
    fake.db.hm_items.push({ user_id: "p1-exp", guild_id: "g1", tree: "gathering", slot: q.ITEM_SLOT.EXPANSION, tier: 2 });
    fake.db.hm_items.push({ user_id: "p2-exp", guild_id: "g1", tree: "gathering", slot: q.ITEM_SLOT.EXPANSION, tier: 3 });

    const result = await q.createPartyQuest({
      guildId: "g1", members: ["p1-exp", "p2-exp"], tree: "gathering", size: "duo", difficulty: "medium",
    });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_party_quests.find((r) => r.members.includes("p1-exp"));
    // Medium's base count = 2; highest tier on the team = 3 (not 2+3=5) -> 2+3=5 total targets
    assert.strictEqual(Object.keys(row.targets.skills).length, 5, "base 2 + highest-owned tier 3 = 5, NOT summed across the team");
  });

  console.log("\n[team hand-pick — a Quest Choice Token's pick locks the team's target before the roster/Items are known]");
  await check("partyTargetPool's count comes from difficulty, not size; value still comes from size", () => {
    assert.deepStrictEqual(
      q.partyTargetPool("gathering", "duo", "medium"),
      { kind: "skill", count: 2, value: 135000, pool: q.SKILLS_BY_TREE.gathering }
    );
    assert.strictEqual(q.partyTargetPool("boss", "trio", "easy").count, 1);
    assert.strictEqual(q.partyTargetPool("raids", "quad", "easy").count, 1);
    assert.strictEqual(q.partyTargetPool("raids", "quad", "hard").count, 3);
    assert.strictEqual(q.partyTargetPool("minigames", "quad", "hard").count, 3);
    // No difficulty passed at all falls back to Easy's count of 1, same
    // fallback createPartyQuest/createOpenTeam use for an unknown value.
    assert.strictEqual(q.partyTargetPool("gathering", "duo").count, 1);
  });

  await check("a hand-picked team skill target is honoured even when a member owns Quest Expansion", async () => {
    await registerMember("p1-pick", "Pick1");
    await registerMember("p2-pick", "Pick2");
    const snap = snapshotWithLevels({ mining: 50, fishing: 50, woodcutting: 50, farming: 50, hunter: 50 });
    snapshots["Pick1"] = snap;
    snapshots["Pick2"] = snap;
    // Tier 3 Expansion would normally add +3 targets (2 -> 5) if this were a
    // random roll — the hand-pick must lock the count back to the base 2.
    fake.db.hm_items.push({ user_id: "p1-pick", guild_id: "g1", tree: "gathering", slot: q.ITEM_SLOT.EXPANSION, tier: 3 });

    const result = await q.createPartyQuest({
      guildId: "g1", members: ["p1-pick", "p2-pick"], tree: "gathering", size: "duo", difficulty: "medium",
      picks: ["mining", "fishing"],
    });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_party_quests.find((r) => r.members.includes("p1-pick"));
    assert.deepStrictEqual(
      Object.keys(row.targets.skills).sort(), ["fishing", "mining"],
      "exactly the 2 hand-picked skills, Expansion's extra targets must not apply on top of a hand-pick"
    );
    assert.strictEqual(row.hm_reward, q.partyHmReward("duo", "medium"), "reward must not be scaled up as if 5 targets existed");
  });

  await check("a hand-picked team boss target skips the safety-check filter entirely", async () => {
    await registerMember("p1-safe", "Safe1");
    await registerMember("p2-safe", "Safe2");
    // Fresh, low-level snapshots that would fail the safety check for almost
    // every demanding boss — proving the hand-pick bypasses it completely.
    const weak = snapshotWithLevels({ hitpoints: 10, defence: 1, prayer: 1, attack: 1, strength: 1, ranged: 1, magic: 1 });
    snapshots["Safe1"] = weak;
    snapshots["Safe2"] = weak;

    const result = await q.createPartyQuest({
      guildId: "g1", members: ["p1-safe", "p2-safe"], tree: "boss", size: "duo", difficulty: "easy",
      picks: ["zulrah"],
    });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_party_quests.find((r) => r.members.includes("p1-safe"));
    assert.deepStrictEqual(Object.keys(row.targets.bosses), ["zulrah"], "hand-picked boss used as-is, never safety-filtered away");
    assert.strictEqual(row.targets.bosses.zulrah, 150, "base duo boss kc (150), untouched by the safety fallback's KC scaling");
  });

  await check("an invalid/missing pick is topped up at random from the same pool, never left empty", async () => {
    await registerMember("p1-topup", "Topup1");
    await registerMember("p2-topup", "Topup2");
    const snap = snapshotWithLevels({ mining: 50, fishing: 50, woodcutting: 50, farming: 50, hunter: 50 });
    snapshots["Topup1"] = snap;
    snapshots["Topup2"] = snap;

    const result = await q.createPartyQuest({
      guildId: "g1", members: ["p1-topup", "p2-topup"], tree: "gathering", size: "duo", difficulty: "medium",
      picks: ["mining", "not-a-real-skill"],
    });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_party_quests.find((r) => r.members.includes("p1-topup"));
    const skills = Object.keys(row.targets.skills);
    assert.strictEqual(skills.length, 2, "still exactly 2 targets total");
    assert.ok(skills.includes("mining"), "the one valid pick is kept");
    assert.ok(!skills.includes("not-a-real-skill"), "the invalid pick never makes it into the targets");
  });

  console.log("\n[Raids are always picked, never rolled at random]");
  await check("a solo Raids quest honours an explicit pick instead of ever rolling randomly", async () => {
    await registerMember("u-raid-pick", "RaidPick1");
    snapshots["RaidPick1"] = snapshotWithLevels({});

    const member = await q.getMember("u-raid-pick");
    // Run it enough times that a real random roll would almost certainly
    // have produced a different raid at least once if picks were ignored.
    for (let i = 0; i < 10; i++) {
      const result = await q.createSoloQuest({
        guildId: "g1", member, tree: "raids", questType: "daily", picks: ["theatre_of_blood"],
      });
      assert.strictEqual(result.ok, true, result.error);
      const row = fake.db.hm_quests.find((r) => r.user_id === "u-raid-pick" && r.quest_type === "daily");
      assert.deepStrictEqual(Object.keys(row.targets.bosses), ["theatre_of_blood"], "the picked raid, never a different one");
      await q.cancelSoloQuest("u-raid-pick", row.id);
    }
  });

  await check("a team Raids quest honours the creator's pick, including under Quest Expansion's % mechanic", async () => {
    await registerMember("p1-raid", "Raid1");
    await registerMember("p2-raid", "Raid2");
    snapshots["Raid1"] = snapshotWithLevels({});
    snapshots["Raid2"] = snapshotWithLevels({});
    // Raids expand via a % requirement bump, never by changing WHICH raid is
    // targeted — owning this must not disturb the hand-picked identity.
    fake.db.hm_items.push({ user_id: "p1-raid", guild_id: "g1", tree: "raids", slot: q.ITEM_SLOT.EXPANSION, tier: 3 });

    const result = await q.createPartyQuest({
      guildId: "g1", members: ["p1-raid", "p2-raid"], tree: "raids", size: "duo", difficulty: "easy",
      picks: ["tombs_of_amascut"],
    });
    assert.strictEqual(result.ok, true, result.error);

    const row = fake.db.hm_party_quests.find((r) => r.members.includes("p1-raid"));
    assert.deepStrictEqual(Object.keys(row.targets.bosses), ["tombs_of_amascut"]);
    const [kc] = Object.values(row.targets.bosses);
    assert.strictEqual(kc, Math.round(15 * 1.1), "the base duo raid KC (15) still gets the owned +10% Expansion bump");
  });

  console.log(`\n${passed} checks passed.`);
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
