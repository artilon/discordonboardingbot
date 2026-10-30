"use strict";
/**
 * Looking For Group — open team listings.
 *
 * The old board was a placeholder button that just said "not live yet".
 * This is the real thing: a listing posted to `hm_lfg_posts` that other
 * members can join, which converts into a real `hm_party_quests` row the
 * moment it fills, and which expires on its own after LFG_EXPIRY_HOURS if it
 * never does. Tested end to end against a fake Supabase client — no network.
 *
 * Run: node test/lfg.test.js
 */
const assert = require("assert");
const { createFakeSupabase } = require("./fake-supabase");

const fake = createFakeSupabase({
  hm_members: [],
  hm_lfg_posts: [],
  hm_party_quests: [],
  hm_quests: [],
});

const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { getSupabase: () => fake },
};

// Every member who matters below gets a working snapshot so createPartyQuest
// can read a baseline for them.
const realJagex = require("../src/jagex");
const jagexPath = require.resolve("../src/jagex");
require.cache[jagexPath] = {
  id: jagexPath,
  filename: jagexPath,
  loaded: true,
  exports: { ...realJagex, fetchHiscores: async () => ({ skills: {}, bosses: {} }) },
};

const {
  createOpenTeam, cancelOpenTeam, joinOpenTeam, getOpenTeams, getOpenTeamForUser,
  sweepExpiredOpenTeams, PARTY_SIZES,
} = require("../src/quests");

function registerMember(userId, guildId = "g1") {
  fake.db.hm_members.push({ user_id: userId, guild_id: guildId, rsn: userId, active: true });
}

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

(async () => {
  console.log("\n[LFG — posting and cancelling an open listing]");

  await check("posting requires a registered RSN", async () => {
    const result = await createOpenTeam({ guildId: "g1", posterId: "unregistered", size: "duo", tree: "gathering" });
    assert.ok(result.error);
  });

  await check("a registered member can post an open duo listing", async () => {
    registerMember("poster-1");
    const result = await createOpenTeam({ guildId: "g1", posterId: "poster-1", size: "duo", tree: "gathering" });
    assert.strictEqual(result.ok, true);
    const posts = await getOpenTeams("g1");
    assert.strictEqual(posts.length, 1);
    assert.deepStrictEqual(posts[0].members, ["poster-1"]);
    assert.strictEqual(posts[0].team_size, "duo");
  });

  await check("the poster can't post a second listing while one is already open", async () => {
    const result = await createOpenTeam({ guildId: "g1", posterId: "poster-1", size: "trio", tree: "combat" });
    assert.ok(result.error);
    assert.strictEqual((await getOpenTeams("g1")).length, 1);
  });

  await check("cancelling removes the listing", async () => {
    const result = await cancelOpenTeam("g1", "poster-1");
    assert.strictEqual(result.ok, true);
    assert.strictEqual((await getOpenTeams("g1")).length, 0);
  });

  await check("cancelling with nothing open fails cleanly", async () => {
    const result = await cancelOpenTeam("g1", "poster-1");
    assert.ok(result.error);
  });

  console.log("\n[LFG — joining fills a slot, and completes the team when full]");

  await check("joining a duo listing immediately converts it into a real party quest", async () => {
    registerMember("poster-2");
    registerMember("joiner-2");
    const posted = await createOpenTeam({ guildId: "g1", posterId: "poster-2", size: "duo", tree: "boss" });
    assert.strictEqual(posted.ok, true);
    const [post] = await getOpenTeams("g1");

    const result = await joinOpenTeam({ guildId: "g1", postId: post.id, userId: "joiner-2" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.started, true, "a duo fills on the very first join");

    assert.strictEqual((await getOpenTeams("g1")).length, 0, "the listing is consumed once it converts");
    const party = fake.db.hm_party_quests.find((p) =>
      p.members.includes("poster-2") && p.members.includes("joiner-2")
    );
    assert.ok(party, "a real party quest now exists for both members");
    assert.strictEqual(party.tree, "boss");
    assert.strictEqual(party.size, "duo");
  });

  await check("joining a trio listing only fills a slot until the third member arrives", async () => {
    registerMember("poster-3");
    registerMember("joiner-3a");
    registerMember("joiner-3b");
    await createOpenTeam({ guildId: "g1", posterId: "poster-3", size: "trio", tree: "raids" });
    const [onlyPost] = await getOpenTeams("g1");

    const firstJoin = await joinOpenTeam({ guildId: "g1", postId: onlyPost.id, userId: "joiner-3a" });
    assert.strictEqual(firstJoin.ok, true);
    assert.strictEqual(firstJoin.started, false, "a trio needs one more after the first join");
    assert.strictEqual(firstJoin.needed, 1);

    const stillOpen = await getOpenTeams("g1");
    assert.strictEqual(stillOpen.length, 1, "the listing is still open, not yet converted");
    assert.deepStrictEqual(stillOpen[0].members.sort(), ["joiner-3a", "poster-3"].sort());

    const secondJoin = await joinOpenTeam({ guildId: "g1", postId: onlyPost.id, userId: "joiner-3b" });
    assert.strictEqual(secondJoin.ok, true);
    assert.strictEqual(secondJoin.started, true);
    assert.strictEqual((await getOpenTeams("g1")).length, 0);
  });

  await check("a member can't join the same listing twice", async () => {
    registerMember("poster-4");
    registerMember("joiner-4");
    await createOpenTeam({ guildId: "g1", posterId: "poster-4", size: "quad", tree: "utility" });
    const [post] = await getOpenTeams("g1");
    await joinOpenTeam({ guildId: "g1", postId: post.id, userId: "joiner-4" });

    const result = await joinOpenTeam({ guildId: "g1", postId: post.id, userId: "joiner-4" });
    assert.ok(result.error);
    await cancelOpenTeam("g1", "poster-4");
  });

  await check("a member already on an open listing can't join a different one", async () => {
    registerMember("poster-5");
    registerMember("poster-6");
    registerMember("floater");
    await createOpenTeam({ guildId: "g1", posterId: "poster-5", size: "quad", tree: "minigames" });
    await createOpenTeam({ guildId: "g1", posterId: "poster-6", size: "quad", tree: "production" });
    const posts = await getOpenTeams("g1");
    const post5 = posts.find((p) => p.poster_id === "poster-5");
    const post6 = posts.find((p) => p.poster_id === "poster-6");

    const joined = await joinOpenTeam({ guildId: "g1", postId: post5.id, userId: "floater" });
    assert.strictEqual(joined.ok, true);

    const blocked = await joinOpenTeam({ guildId: "g1", postId: post6.id, userId: "floater" });
    assert.ok(blocked.error);

    assert.ok(await getOpenTeamForUser("g1", "floater"));
    await cancelOpenTeam("g1", "poster-5");
    await cancelOpenTeam("g1", "poster-6");
  });

  console.log("\n[LFG — a hand-picked target is stored on the listing and honoured when it fills]");

  await check("a hand-picked target is stored on the listing so a browser can see it before joining", async () => {
    registerMember("poster-pick");
    const posted = await createOpenTeam({ guildId: "g1", posterId: "poster-pick", size: "duo", tree: "boss", picks: ["zulrah"] });
    assert.strictEqual(posted.ok, true, posted.error);

    const [post] = await getOpenTeams("g1");
    assert.deepStrictEqual(post.picks, ["zulrah"], "visible on the listing row itself, before anyone has joined");
    await cancelOpenTeam("g1", "poster-pick");
  });

  await check("a listing posted with no pick stores no picks (rolls at random when it fills)", async () => {
    registerMember("poster-nopick");
    await createOpenTeam({ guildId: "g1", posterId: "poster-nopick", size: "duo", tree: "boss" });
    const [post] = await getOpenTeams("g1");
    assert.ok(post.picks == null);
    await cancelOpenTeam("g1", "poster-nopick");
  });

  await check("a hand-picked target survives into the real quest once the listing fills", async () => {
    registerMember("poster-pick2");
    registerMember("joiner-pick2");
    await createOpenTeam({ guildId: "g1", posterId: "poster-pick2", size: "duo", tree: "boss", picks: ["zulrah"] });
    const [post] = await getOpenTeams("g1");

    const result = await joinOpenTeam({ guildId: "g1", postId: post.id, userId: "joiner-pick2" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.started, true);

    const party = fake.db.hm_party_quests.find((p) =>
      p.members.includes("poster-pick2") && p.members.includes("joiner-pick2")
    );
    assert.ok(party);
    assert.deepStrictEqual(Object.keys(party.targets.bosses), ["zulrah"], "the pick made at post-time is what the real quest actually targets");
  });

  await check("a hand-picked Raids listing survives into the real quest — raids are never rolled at random", async () => {
    registerMember("poster-raid");
    registerMember("joiner-raid");
    await createOpenTeam({ guildId: "g1", posterId: "poster-raid", size: "duo", tree: "raids", picks: ["theatre_of_blood"] });
    const [post] = await getOpenTeams("g1");
    assert.deepStrictEqual(post.picks, ["theatre_of_blood"]);

    const result = await joinOpenTeam({ guildId: "g1", postId: post.id, userId: "joiner-raid" });
    assert.strictEqual(result.ok, true);

    const party = fake.db.hm_party_quests.find((p) =>
      p.members.includes("poster-raid") && p.members.includes("joiner-raid")
    );
    assert.ok(party);
    assert.deepStrictEqual(Object.keys(party.targets.bosses), ["theatre_of_blood"]);
  });

  console.log("\n[LFG — unfilled listings expire]");

  await check("a listing older than the expiry window is swept away", async () => {
    registerMember("poster-stale");
    await createOpenTeam({ guildId: "g1", posterId: "poster-stale", size: "duo", tree: "gathering" });
    // getOpenTeams() returns copies, so backdate the real stored row directly.
    const stored = fake.db.hm_lfg_posts.find((p) => p.poster_id === "poster-stale");
    stored.created_at = new Date(Date.now() - 25 * 3600000).toISOString(); // 25h old

    assert.strictEqual((await getOpenTeams("g1")).length, 0, "already filtered out of the read even before the sweep");

    const removed = await sweepExpiredOpenTeams();
    assert.strictEqual(removed, 1);
    assert.strictEqual(fake.db.hm_lfg_posts.length, 0, "actually deleted, so the poster can post again");
  });

  await check("team sizes map to the expected member counts", () => {
    assert.deepStrictEqual(PARTY_SIZES, { duo: 2, trio: 3, quad: 4 });
  });

  console.log(`\n${passed} checks passed.\n`);
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
