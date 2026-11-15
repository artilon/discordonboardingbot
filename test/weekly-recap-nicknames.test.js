// Regression coverage for: "the weekly digest is using discord usernames
// instead of server nicknames."
//
// The Weekly Recap leaderboards must show each member's current Discord
// server nickname (member.displayName), not a stored RSN or a Discord
// username. The recap resolves names via the member's linked Discord
// user_id -> server nickname map, falling back to the stored name only when
// Discord can't resolve them. Also covers the extracted accumulateRecapGains
// diff helper shared by the live run and the repost path.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  // ---- accumulateRecapGains: shared diff math ----
  {
    const acc = bot.newRecapAccumulator();
    const prev = {
      skills: { Attack: 1000, Strength: 500 },
      activities: { Zulrah: 10 },
      rank_xp: 100,
    };
    const curr = {
      skills: { Attack: 3000, Strength: 500 },
      activities: { Zulrah: 14 },
      rank_xp: 250,
    };
    bot.accumulateRecapGains(acc, "Some RSN", prev, curr);
    check("XP gainer records the skill XP delta", acc.xpGainers.length === 1 && acc.xpGainers[0].amount === 2000);
    check("PvMer records the boss KC delta", acc.pvmers.length === 1 && acc.pvmers[0].amount === 4);
    check("Rank XP earner records the rank XP delta", acc.rankXpEarners.length === 1 && acc.rankXpEarners[0].amount === 150);
    check("no raiders when no raid KC changed", acc.raiders.length === 0);
  }
  {
    // No baseline -> nothing accumulates.
    const acc = bot.newRecapAccumulator();
    bot.accumulateRecapGains(acc, "New Member", null, { skills: { Attack: 9999 }, activities: {}, rank_xp: 9999 });
    check("a member with no baseline contributes nothing", acc.xpGainers.length === 0 && acc.pvmers.length === 0 && acc.rankXpEarners.length === 0);
  }
  {
    // Zero/negative gains are ignored.
    const acc = bot.newRecapAccumulator();
    bot.accumulateRecapGains(acc, "Idle", { skills: { Attack: 5000 }, activities: {}, rank_xp: 100 }, { skills: { Attack: 5000 }, activities: {}, rank_xp: 100 });
    check("zero gains produce no leaderboard entries", acc.xpGainers.length === 0 && acc.rankXpEarners.length === 0);
  }

  // ---- getServerNicknameMap: prefers server nickname over username ----
  {
    // No guilds cached (test env) -> empty map, never null/throws.
    const map = await bot.getServerNicknameMap();
    check("returns a Map even with no guilds", map instanceof Map);
    check("returns an empty Map with no guilds", map.size === 0);
  }

  // ---- computeHonourMarksLeaderboard: nickname map wins over display_name ----
  {
    // Fake supabase returning one HM transaction for user "u1".
    const fakeSupabase = {
      from(table) {
        if (table === "hm_transactions") {
          return {
            select: () => ({
              gte: () => ({ lt: () => ({ gt: () => Promise.resolve({ data: [{ user_id: "u1", delta: 500 }], error: null }) }) }),
            }),
          };
        }
        if (table === "hm_members") {
          return {
            select: () => ({
              in: () => Promise.resolve({ data: [{ user_id: "u1", rsn: "Stored RSN", display_name: "discordusername" }], error: null }),
            }),
          };
        }
        throw new Error("unexpected table " + table);
      },
    };
    const window = { startsAtIso: "2026-11-09T00:00:00Z", endsAtIso: "2026-11-16T00:00:00Z" };

    // With a nickname map, the server nickname is used (not the Discord username).
    const withNick = await bot.computeHonourMarksLeaderboard(fakeSupabase, window, new Map([["u1", "Server Nickname"]]));
    check("HM leaderboard uses the server nickname when provided", withNick.length === 1 && withNick[0].name === "Server Nickname");

    // Without a nickname map, it falls back to the stored display_name.
    const withoutNick = await bot.computeHonourMarksLeaderboard(fakeSupabase, window, null);
    check("HM leaderboard falls back to display_name without a nickname map", withoutNick.length === 1 && withoutNick[0].name === "discordusername");
  }

  console.log(`\n[weekly-recap-nicknames] ${passed} checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
