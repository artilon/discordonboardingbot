"use strict";
/**
 * Covers the admin "/hm force-complete" feature: a single hardcoded Discord
 * user (not a role) can force any of THEIR OWN active quests — solo or
 * team — straight to completion, bypassing every progress/target check, and
 * always gets paid the FULL reward (every teammate too, for a team quest).
 *
 * index.js itself can't be required from a test (it calls client.login() at
 * module scope), so this suite exercises the exact payout primitives the
 * admin flow calls directly — `completeSoloQuest` and `completePartyQuest`
 * from src/progress.js — the same functions the real "Check Quests" flow
 * uses, just invoked without a passing hiscores diff. That's the whole
 * point of force-complete: identical payout math, skipped gate.
 *
 * A couple of lightweight static checks on index.js's source also guard the
 * single-user-ID gate itself, since that authorization logic has nothing
 * else to unit-test against (no Discord connection in this suite).
 *
 * Run: node test/force-complete-quest.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createFakeSupabase } = require("./fake-supabase");

const fake = createFakeSupabase({
  hm_quests: [],
  hm_party_quests: [],
  hm_party_quest_completions: [],
  hm_quest_completions: [],
  hm_quest_counts: [],
  hm_balances: [],
  hm_transactions: [],
  hm_members: [],
  hm_active_boosts: [],
  pending_rank_xp: [],
});

const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { getSupabase: () => fake },
};

const { completeSoloQuest, completePartyQuest } = require("../src/progress");
const { getActiveSoloQuests, getActivePartyQuestsForUser } = require("../src/quests");
const { config } = require("../src/config");

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

(async () => {

console.log("\n[force-complete: solo quest — full reward, no progress required]");

await check("completeSoloQuest pays the full reward with zero real progress and deletes the quest", async () => {
  const userId = "admin-solo";
  fake.db.hm_members.push({ user_id: userId, guild_id: "g1", rsn: "AdminRsn" });
  fake.db.hm_quests.push({
    id: 9101, guild_id: "g1", user_id: userId, quest_type: "weekly", tree: "gathering",
    difficulty: "normal", hm_reward: 90,
    targets: { skills: { mining: 100000 }, bosses: {} },
    // Baseline == a snapshot with zero gained — i.e. no progress was ever made.
    baseline: { skills: { mining: { experience: 500000 } }, bosses: {} },
  });

  const result = await completeSoloQuest(fake.db.hm_quests.find((q) => q.id === 9101), {
    guildId: "g1", userId, memberRsn: "AdminRsn",
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.hm, 90, "full hm_reward, unscaled by any progress percentage");
  assert.strictEqual(result.xp, config.rankXp.quest_solo_weekly, "flat base Rank XP for a finished weekly quest");

  assert.ok(!fake.db.hm_quests.some((q) => q.id === 9101), "the quest row is gone once force-completed");
  const bal = fake.db.hm_balances.find((b) => b.user_id === userId);
  assert.strictEqual(bal.balance, 90, "the admin alone was paid for a solo quest");
  const queued = fake.db.pending_rank_xp.find((r) => r.user_id === userId);
  assert.strictEqual(queued.amount, config.rankXp.quest_solo_weekly);
  const row = fake.db.hm_quest_completions.find((r) => r.user_id === userId && r.tree === "gathering");
  assert.strictEqual(row.progress_pct, 100, "recorded as a full completion, same as a real one");
});

await check("force-completing the same quest twice only pays once (idempotent, like a double-click)", async () => {
  const userId = "admin-double";
  fake.db.hm_members.push({ user_id: userId, guild_id: "g1", rsn: "AdminRsn2" });
  const quest = {
    id: 9102, guild_id: "g1", user_id: userId, quest_type: "daily", tree: "combat",
    difficulty: "normal", hm_reward: 40,
    targets: { skills: {}, bosses: { zulrah: 10 } },
    baseline: { skills: {}, bosses: { zulrah: { kills: 0 } } },
  };
  fake.db.hm_quests.push({ ...quest });

  const first = await completeSoloQuest(quest, { guildId: "g1", userId, memberRsn: "AdminRsn2" });
  const second = await completeSoloQuest(quest, { guildId: "g1", userId, memberRsn: "AdminRsn2" });

  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, false, "row is already gone — the second force-complete is a safe no-op");
  const bal = fake.db.hm_balances.find((b) => b.user_id === userId);
  assert.strictEqual(bal.balance, 40, "only paid once despite two calls");
});

console.log("\n[force-complete: team quest — full reward to EVERY teammate, not split]");

await check("completePartyQuest pays the full reward to every member, regardless of real progress", async () => {
  fake.db.hm_members.push({ user_id: "t-admin", guild_id: "g1", rsn: "TAdmin" });
  fake.db.hm_members.push({ user_id: "t-mate", guild_id: "g1", rsn: "TMate" });

  const quest = {
    id: 9200, guild_id: "g1", tree: "boss", size: "duo", difficulty: "hard",
    hm_reward: 300, members: ["t-admin", "t-mate"],
    targets: { skills: {}, bosses: { zulrah: 90 } },
    baseline: { "t-admin": { skills: {}, bosses: { zulrah: { kills: 0 } } }, "t-mate": { skills: {}, bosses: { zulrah: { kills: 0 } } } },
  };
  fake.db.hm_party_quests.push({ ...quest });

  // No progress evaluation happens at all — force-complete calls this
  // directly with no real `progress` argument, same as the admin flow does.
  const result = await completePartyQuest(quest, null);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.hm, 600, "both members got the FULL 300, not 300 split between them");

  const adminBal = fake.db.hm_balances.find((b) => b.user_id === "t-admin");
  const mateBal = fake.db.hm_balances.find((b) => b.user_id === "t-mate");
  assert.strictEqual(adminBal.balance, 300, "admin gets the full reward");
  assert.strictEqual(mateBal.balance, 300, "every other teammate gets the full reward too, not just the admin");

  assert.ok(!fake.db.hm_party_quests.some((q) => q.id === 9200), "the team quest row is gone once force-completed");
  const row = fake.db.hm_party_quest_completions.find((r) => r.quest_id === 9200);
  assert.strictEqual(row.hm_awarded, 600);
  assert.deepStrictEqual(row.members, ["t-admin", "t-mate"]);
});

console.log("\n[force-complete: listing every active quest — solo AND team — for one user]");

await check("the admin's own active quests (solo + team) can be found by user id, combined", async () => {
  const userId = "lister";
  fake.db.hm_quests.push({
    id: 9300, guild_id: "g1", user_id: userId, quest_type: "monthly", tree: "skilling",
    difficulty: "normal", hm_reward: 400, targets: { skills: { farming: 500000 }, bosses: {} },
    baseline: { skills: { farming: { experience: 0 } }, bosses: {} },
  });
  fake.db.hm_party_quests.push({
    id: 9301, guild_id: "g1", tree: "combat", size: "trio", difficulty: "medium",
    hm_reward: 300, members: ["someone-else", userId, "another-member"],
    targets: { skills: {}, bosses: { zulrah: 60 } },
    baseline: {},
  });
  // A team quest this user is NOT on must never show up in their list.
  fake.db.hm_party_quests.push({
    id: 9302, guild_id: "g1", tree: "gathering", size: "duo", difficulty: "easy",
    hm_reward: 100, members: ["not-this-user", "also-not-this-user"],
    targets: { skills: {}, bosses: {} }, baseline: {},
  });

  const solo = await getActiveSoloQuests(userId);
  const party = await getActivePartyQuestsForUser(userId);

  assert.strictEqual(solo.length, 1);
  assert.strictEqual(solo[0].id, 9300);
  assert.strictEqual(party.length, 1, "only the team quest this user is actually a member of");
  assert.strictEqual(party[0].id, 9301);
});

console.log("\n[force-complete: the single-user-ID gate]");

const indexSrc = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

await check("the force-complete command is gated to exactly one hardcoded Discord user ID", () => {
  assert.ok(
    indexSrc.includes('const FORCE_COMPLETE_USER_ID = "351190870416031744";'),
    "the admin override must be the exact, single, hardcoded user id from the spec"
  );
});

await check("the force-complete handler checks that id before doing anything else, not the staff role", () => {
  const fnStart = indexSrc.indexOf("async function handleForceCompleteQuest");
  assert.ok(fnStart !== -1, "handleForceCompleteQuest should exist");
  const fnBody = indexSrc.slice(fnStart, fnStart + 400);
  assert.ok(
    /if \(interaction\.user\.id !== FORCE_COMPLETE_USER_ID\)/.test(fnBody),
    "the very first check in the handler must be the hardcoded user id, not isStaff()"
  );
});

await check("/hm force-complete is dispatched before the isStaff() gate in handleHm", () => {
  const hmStart = indexSrc.indexOf("async function handleHm");
  const forceIdx = indexSrc.indexOf('sub === "force-complete"', hmStart);
  const staffIdx = indexSrc.indexOf("await isStaff(interaction)", hmStart);
  assert.ok(forceIdx !== -1 && staffIdx !== -1, "both checks should exist inside handleHm");
  assert.ok(
    forceIdx < staffIdx,
    "force-complete must be handled (and gated by its own user-id check) BEFORE the staff-role gate, " +
    "so a non-staff holder of that one user id can still use it, and so a staff member who ISN'T that " +
    "user id is correctly rejected rather than slipping through on their staff role"
  );
});

console.log(`\n${passed} checks passed.\n`);

})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
