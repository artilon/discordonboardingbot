"use strict";
/**
 * The Quest Board used to list every solo quest from every member sorted
 * only by whichever expires soonest — a member holding a Daily, a Weekly,
 * and a Monthly at once had those three entries scattered across the whole
 * board instead of kept together. This covers the fix: each member's own
 * quests are now grouped under one mention, always ordered Daily -> Weekly
 * -> Monthly, and different members' blocks never interleave.
 *
 * Run: node test/quest-board-grouping.test.js
 */
const assert = require("assert");
const { createFakeSupabase } = require("./fake-supabase");

const fake = createFakeSupabase({
  hm_quests: [],
  hm_party_quests: [],
  hm_members: [],
  hm_prestige: [],
  hm_active_boosts: [],
});

const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    getSupabase: () => fake,
    getConfigValue: async () => null,
    setConfigValue: async () => true,
  },
};

// fetchHiscores is swapped for a controllable fake; diffProgress, labels etc.
// stay real, matching the pattern used by other quest-flow test suites.
const realJagex = require("../src/jagex");
const snapshots = {};
const jagexPath = require.resolve("../src/jagex");
require.cache[jagexPath] = {
  id: jagexPath, filename: jagexPath, loaded: true,
  exports: { ...realJagex, fetchHiscores: async (rsn) => snapshots[rsn] || null },
};

const { renderQuestBoard } = require("../src/panels");

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

function registerMember(userId, rsn) {
  fake.db.hm_members.push({ user_id: userId, guild_id: "g1", rsn });
  snapshots[rsn] = { skills: { mining: { experience: 0 }, farming: { experience: 0 } }, bosses: { zulrah: { kills: 0 } } };
}

function addSoloQuest({ id, userId, questType, tree, expiresInMs, targets }) {
  fake.db.hm_quests.push({
    id, guild_id: "g1", user_id: userId, quest_type: questType, tree,
    difficulty: "normal", hm_reward: 50,
    targets,
    baseline: { skills: { mining: { experience: 0 }, farming: { experience: 0 } }, bosses: { zulrah: { kills: 0 } } },
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  });
}

(async () => {

console.log("[quest board — solo quests grouped per member, in order]");

await check("a member's Daily/Weekly/Monthly all appear together, in that order, not scattered", async () => {
  registerMember("member-a", "MemberA");
  registerMember("member-b", "MemberB");

  // Interleaved on purpose: member-a's Monthly expires soonest, member-b's
  // quest sits in between member-a's Daily and Weekly by expiry — exactly
  // the scattering the old expires_at-only sort used to produce.
  addSoloQuest({ id: 1, userId: "member-a", questType: "daily", tree: "gathering", expiresInMs: 3 * 86400000, targets: { skills: { mining: 1000 }, bosses: {} } });
  addSoloQuest({ id: 2, userId: "member-b", questType: "weekly", tree: "boss", expiresInMs: 2 * 86400000, targets: { skills: {}, bosses: { zulrah: 10 } } });
  addSoloQuest({ id: 3, userId: "member-a", questType: "weekly", tree: "skilling", expiresInMs: 5 * 86400000, targets: { skills: { farming: 2000 }, bosses: {} } });
  addSoloQuest({ id: 4, userId: "member-a", questType: "monthly", tree: "gathering", expiresInMs: 1 * 86400000, targets: { skills: { mining: 5000 }, bosses: {} } });

  const pages = await renderQuestBoard("g1", { channels: {} });
  const fullText = pages.map((p) => p.embed.data.description || "").join("\n");

  // member-a's mention must appear exactly once, even though they hold 3
  // quests — the old format repeated it once per quest.
  const mentionCount = (fullText.match(/<@member-a>/g) || []).length;
  assert.strictEqual(mentionCount, 1, "member-a's name should only be shown once, with their quests listed below it");

  // Within member-a's block, Daily comes before Weekly comes before Monthly,
  // regardless of which one actually expires soonest.
  const dailyIdx = fullText.indexOf("Daily");
  const weeklyIdx = fullText.indexOf("Weekly", dailyIdx);
  const monthlyIdx = fullText.indexOf("Monthly", weeklyIdx);
  assert.ok(dailyIdx !== -1 && weeklyIdx !== -1 && monthlyIdx !== -1, "all three quest types should be present");
  assert.ok(dailyIdx < weeklyIdx && weeklyIdx < monthlyIdx, "a member's own quests must read Daily, then Weekly, then Monthly");

  // And member-b's single quest must not land in between member-a's own
  // entries — the whole member-a block must be contiguous.
  const memberAStart = fullText.indexOf("<@member-a>");
  const memberBMention = fullText.indexOf("<@member-b>");
  const memberABlockEnd = monthlyIdx; // last of member-a's own quest-type labels
  assert.ok(
    memberBMention < memberAStart || memberBMention > memberABlockEnd,
    "member-b's quest must not be interleaved inside member-a's own block of quests"
  );
});

await check("a member with only one active quest still renders fine (no regression for the common case)", async () => {
  registerMember("member-solo", "MemberSolo");
  addSoloQuest({ id: 5, userId: "member-solo", questType: "daily", tree: "gathering", expiresInMs: 86400000, targets: { skills: { mining: 1000 }, bosses: {} } });

  const pages = await renderQuestBoard("g1", { channels: {} });
  const fullText = pages.map((p) => p.embed.data.description || "").join("\n");
  assert.ok(fullText.includes("<@member-solo>"));
  assert.ok(fullText.includes("Daily"));
});

console.log(`\n${passed} checks passed.\n`);

})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
