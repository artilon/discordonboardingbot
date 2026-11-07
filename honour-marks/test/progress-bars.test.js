"use strict";
/**
 * Progress bars — the same ▰▰▰▱▱▱▱▱▱▱ style already used for Clan Rank
 * progress — now also appear on every active quest on the Quest Board
 * (solo and team) and on the Clan Pool's shared quest. Before this, those
 * three only ever showed raw numbers/percentages with no visual bar at all.
 *
 * Also covers that the Clan Pool's new progress display is READ-ONLY: it
 * must never write to `hm_clan_quest.baselines` or trigger quest completion
 * itself — that stays the exclusive job of the periodic checkClanQuestProgress
 * tick, so rendering the panel (which happens far more often) can never race
 * it into double-completing or double-crediting a newly tracked member.
 *
 * Run: node test/progress-bars.test.js
 */
const assert = require("assert");
const { createFakeSupabase } = require("./fake-supabase");

const fake = createFakeSupabase({
  hm_quests: [],
  hm_party_quests: [],
  hm_members: [],
  hm_prestige: [],
  hm_clan_quest: [],
  hm_clan_boost: [],
  hm_quest_completions: [],
  hm_party_quest_completions: [],
});

const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { getSupabase: () => fake, getConfigValue: async () => null, setConfigValue: async () => true },
};

const realJagex = require("../src/jagex");
const snapshots = {};
const jagexPath = require.resolve("../src/jagex");
require.cache[jagexPath] = {
  id: jagexPath, filename: jagexPath, loaded: true,
  exports: { ...realJagex, fetchHiscores: async (rsn) => snapshots[rsn] || null },
};

const { renderQuestBoard, renderClanPool } = require("../src/panels");
const { buildProgressBar } = require("../src/ranks");
const clanpool = require("../src/clanpool");

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

function registerMember(userId, rsn, guildId = "g1") {
  fake.db.hm_members.push({ user_id: userId, guild_id: guildId, rsn, active: true });
}

(async () => {
  console.log("\n[buildProgressBar — the shared 10-segment bar primitive]");

  await check("0% is all empty segments", () => {
    assert.strictEqual(buildProgressBar(0), "▱▱▱▱▱▱▱▱▱▱");
  });
  await check("100% is all filled segments", () => {
    assert.strictEqual(buildProgressBar(1), "▰▰▰▰▰▰▰▰▰▰");
  });
  await check("50% is half and half", () => {
    assert.strictEqual(buildProgressBar(0.5), "▰▰▰▰▰▱▱▱▱▱");
  });
  await check("ratios are clamped to 0..1 (never over/under-fill)", () => {
    assert.strictEqual(buildProgressBar(5), "▰▰▰▰▰▰▰▰▰▰");
    assert.strictEqual(buildProgressBar(-5), "▱▱▱▱▱▱▱▱▱▱");
  });

  console.log("\n[Quest Board — solo and team quest lines now show a progress bar]");

  await check("a solo quest's line includes a progress bar matching its % progress", async () => {
    registerMember("solo-1", "SoloOne");
    fake.db.hm_quests.push({
      id: 101, guild_id: "g1", user_id: "solo-1", quest_type: "daily", tree: "gathering",
      difficulty: "normal", hm_reward: 50,
      targets: { skills: { mining: 1000 }, bosses: {} },
      baseline: { skills: { mining: { experience: 0 } }, bosses: {} },
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    snapshots["SoloOne"] = { skills: { mining: { experience: 300 } }, bosses: {} }; // 30%

    const pages = await renderQuestBoard("g1", { channels: {} });
    const text = pages.map((p) => p.embed.data.description || "").join("\n");

    assert.ok(text.includes("30%"), "the percentage must still be shown");
    assert.ok(/[▰▱]{10}/.test(text), "a 10-segment bar must be present somewhere in the solo quest line");
    // 30% of 10 segments rounds to 3 filled.
    assert.ok(text.includes(buildProgressBar(0.3)), "the bar must actually reflect 30%, not just any bar");
  });

  await check("a team quest's line includes a progress bar matching its % progress", async () => {
    registerMember("team-1", "TeamOne");
    registerMember("team-2", "TeamTwo");
    fake.db.hm_party_quests.push({
      id: 201, guild_id: "g1", size: "duo", tree: "boss",
      members: ["team-1", "team-2"],
      targets: { skills: {}, bosses: { zulrah: 20 } },
      baseline: {
        "team-1": { skills: {}, bosses: { zulrah: { kills: 0 } } },
        "team-2": { skills: {}, bosses: { zulrah: { kills: 0 } } },
      },
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    snapshots["TeamOne"] = { skills: {}, bosses: { zulrah: { kills: 6 } } };
    snapshots["TeamTwo"] = { skills: {}, bosses: { zulrah: { kills: 4 } } }; // combined 10/20 = 50%

    const pages = await renderQuestBoard("g1", { channels: {} });
    const text = pages.map((p) => p.embed.data.description || "").join("\n");

    assert.ok(text.includes("Team progress:"));
    assert.ok(text.includes("50%"));
    assert.ok(text.includes(buildProgressBar(0.5)), "the team bar must reflect the combined 50%, not per-member");
  });

  console.log("\n[Clan Pool — the shared quest now shows a progress bar too, and it's read-only]");

  await check("the Clan Pool panel shows a bar and the raw progress/target numbers", async () => {
    fake.db.hm_clan_quest = [{ guild_id: "g-cp", quest_type: "boss_kc", target: 100, baselines: { "cp-1": 5 } }];
    registerMember("cp-1", "ClanPoolOne", "g-cp");
    snapshots["ClanPoolOne"] = { skills: {}, bosses: { vorkath: { kills: 45 } } }; // +40 -> 40/100 = 40%

    const pages = await renderClanPool("g-cp");
    const text = pages.map((p) => p.embed.data.description || "").join("\n");

    assert.ok(text.includes("40%"));
    assert.ok(text.includes("40 / 100"));
    assert.ok(text.includes(buildProgressBar(0.4)));
  });

  await check("rendering the Clan Pool panel never mutates baselines (read-only, no race with the real tick)", async () => {
    fake.db.hm_clan_quest = [{ guild_id: "g-ro", quest_type: "boss_kc", target: 100, baselines: { "ro-1": 0 } }];
    registerMember("ro-1", "ReadOnlyOne", "g-ro");
    registerMember("ro-2", "ReadOnlyTwo", "g-ro"); // not yet in baselines -> should stay untouched by render
    snapshots["ReadOnlyOne"] = { skills: {}, bosses: { vorkath: { kills: 10 } } };
    snapshots["ReadOnlyTwo"] = { skills: {}, bosses: { vorkath: { kills: 999 } } };

    await renderClanPool("g-ro");
    const stored = fake.db.hm_clan_quest.find((r) => r.guild_id === "g-ro");
    assert.deepStrictEqual(stored.baselines, { "ro-1": 0 }, "render must never lazily add a new member's baseline");
  });

  await check("rendering the Clan Pool panel never completes the quest, even if progress would exceed target", async () => {
    fake.db.hm_clan_quest = [{ guild_id: "g-over", quest_type: "boss_kc", target: 10, baselines: { "ov-1": 0 } }];
    registerMember("ov-1", "OverOne", "g-over");
    snapshots["OverOne"] = { skills: {}, bosses: { vorkath: { kills: 999 } } }; // way over target

    const pages = await renderClanPool("g-over");
    const text = pages.map((p) => p.embed.data.description || "").join("\n");
    assert.ok(text.includes("100%"), "display caps at 100% rather than overflowing past the bar");

    // The quest row must still be exactly what it was — render must not have
    // deleted/replaced it via completeClanQuest.
    const stillThere = fake.db.hm_clan_quest.find((r) => r.guild_id === "g-over");
    assert.ok(stillThere, "the quest must still exist — only the real periodic tick is allowed to complete it");
    assert.strictEqual(fake.db.hm_clan_boost.filter((b) => b.guild_id === "g-over").length, 0, "no boost should have been awarded by a render");
  });

  console.log(`\n${passed} checks passed.\n`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
