// Regression coverage for: "isn't Heimdall supposed to post a weekly digest
// of XP gains/boss kills/raid completions/etc? I haven't seen it posted a
// single time."
//
// The Weekly Recap's very first run for a clan (or the first run after any
// gap with no prior snapshot) has nothing to diff against, so it can only
// capture a baseline — it used to return completely silently in that case,
// with nothing posted anywhere a member could see. From the clan's
// perspective that's indistinguishable from the feature being broken: the
// very first scheduled run (the week most likely to draw "did this even
// work?" questions) posted nothing at all.
//
// This tests that:
//   1. The first-ever run posts a visible "tracking started" announcement
//      instead of staying silent, and does NOT post a real leaderboard embed
//      (there's nothing to compare yet).
//   2. The NEXT week's run — now that a baseline snapshot exists — posts the
//      real Weekly Recap leaderboard embed as normal.
//
// No real Discord connection or Supabase project is used: config.supabase
// and client.channels.fetch are swapped for lightweight fakes, and
// config.hiscoreFetcher (an existing test hook in fetchPlayerHiscores) is
// used instead of a real network call.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// ---- A tiny in-memory fake of just the Supabase surface runWeeklyRecap uses ----
function makeFakeSupabase({ members, snapshotRows }) {
  const state = { snapshotRows: [...snapshotRows] };

  function from(table) {
    if (table === "clan_members") {
      return {
        select: () => ({
          eq: async () => ({ data: members, error: null }),
        }),
      };
    }
    if (table === "weekly_recap_snapshots") {
      return {
        // Idempotency check: .select("rsn").eq("week_key", k).limit(1)
        // Previous-snapshot load: .select("*").lt("week_key", k).order(...).limit(...)
        select: (cols) => ({
          eq: (_col, weekKey) => ({
            limit: async () => ({
              data: state.snapshotRows.filter((r) => r.week_key === weekKey).map((r) => (cols === "rsn" ? { rsn: r.rsn } : r)),
              error: null,
            }),
          }),
          lt: (_col, weekKey) => ({
            order: () => ({
              limit: async () => ({
                data: state.snapshotRows.filter((r) => r.week_key < weekKey),
                error: null,
              }),
            }),
          }),
        }),
        upsert: async (rows) => {
          for (const row of rows) {
            const i = state.snapshotRows.findIndex((r) => r.week_key === row.week_key && r.rsn === row.rsn);
            if (i >= 0) state.snapshotRows[i] = row;
            else state.snapshotRows.push(row);
          }
          return { data: rows, error: null };
        },
      };
    }
    // Honour Marks leaderboard / anything else this test doesn't exercise.
    // A Proxy that answers any chained call (.eq/.gte/.lt/.gt/.order/...)
    // with itself, and resolves to an empty result when finally awaited —
    // so it doesn't matter exactly which query-builder methods a given
    // lookup happens to chain.
    const emptyChain = new Proxy(() => emptyChain, {
      get(_target, prop) {
        if (prop === "then") return (resolve) => resolve({ data: [], error: null });
        return () => emptyChain;
      },
      apply() { return emptyChain; },
    });
    return { select: () => emptyChain };
  }

  return { from, _state: state };
}

function makeFakeChannel() {
  const sent = [];
  return {
    isTextBased: () => true,
    send: async (payload) => {
      sent.push(payload);
      return { id: "fake-message" };
    },
    _sent: sent,
  };
}

(async () => {
  const members = [
    { active: true, rsn: "Baselinus", xp: 1000 },
    { active: true, rsn: "Secondmember", xp: 500 },
  ];

  const fakeSupabase = makeFakeSupabase({ members, snapshotRows: [] });
  bot.config.supabase = fakeSupabase;
  bot.config.hiscoreFetcher = async () => ({
    skills: [{ name: "Attack", xp: 100000 }],
    activities: [{ name: "Zulrah", score: 10 }],
  });

  const fakeChannel = makeFakeChannel();
  bot.client.channels.fetch = async () => fakeChannel;

  // ---- 1. First-ever run: baseline only, visible announcement, no leaderboard ----
  const week0 = bot.getRecapWindowByIndex(0);
  const result0 = await bot.runWeeklyRecap(week0, new Date(week0.endsAtMs));

  check("the first-ever run returns null (nothing to report yet)", result0 === null);
  check("the first-ever run posts exactly one message to the recap channel", fakeChannel._sent.length === 1);

  const announcement = fakeChannel._sent[0];
  const announcementEmbed = announcement.embeds[0].data;
  check(
    "the baseline announcement's title says tracking started, not a real recap",
    announcementEmbed.title === "📊 Weekly Clan Recap — Tracking Started"
  );
  check(
    "the baseline announcement mentions how many members were captured",
    announcementEmbed.description.includes("**2**")
  );
  check(
    "the baseline announcement tells members when the real recap is coming",
    announcementEmbed.description.includes("next **Sunday at") && announcementEmbed.description.includes("5:00 PM Central")
  );
  check(
    "the baseline announcement does NOT contain leaderboard fields (nothing to compare yet)",
    !announcementEmbed.fields || announcementEmbed.fields.length === 0
  );
  check(
    "buildBaselineAnnouncementEmbed is itself exported and produces the same shape runWeeklyRecap posted",
    bot.buildBaselineAnnouncementEmbed(week0, 2).embeds[0].data.title === announcementEmbed.title
  );

  // A second member with higher XP next time, to produce a real, non-empty gain next week.
  fakeChannel._sent.length = 0;
  bot.config.hiscoreFetcher = async (rsn) => ({
    skills: [{ name: "Attack", xp: rsn === "Baselinus" ? 150000 : 100000 }],
    activities: [{ name: "Zulrah", score: rsn === "Baselinus" ? 15 : 10 }],
  });

  // ---- 2. Next week's run: a baseline now exists, so the REAL recap posts ----
  const week1 = bot.getRecapWindowByIndex(1);
  const result1 = await bot.runWeeklyRecap(week1, new Date(week1.endsAtMs));

  check("the second week's run returns real recap data, not null", result1 !== null);
  check("the second week's run posts exactly one message", fakeChannel._sent.length === 1);

  const recap = fakeChannel._sent[0];
  const recapEmbed = recap.embeds[0].data;
  check("the second week's post is the real Weekly Recap, not another baseline announcement", recapEmbed.title === "📊 Weekly Clan Recap");
  check("the real recap has its leaderboard fields populated", Array.isArray(recapEmbed.fields) && recapEmbed.fields.length > 0);
  check(
    "the member who gained XP actually shows up as a top XP gainer",
    recapEmbed.fields.find((f) => f.name.includes("XP Gainers"))?.value.includes("Baselinus")
  );

  console.log(`\n[weekly-recap-baseline-announcement] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
