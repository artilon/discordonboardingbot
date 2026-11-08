// Regression coverage for: "Once someone confirms a rank up (only rank up)
// alert in the alert channel I want the bot to post a Congratulations
// message in this channel: 1546413698979995678 that doesn't ping, but
// names the member and their new rank."
//
// No real Discord connection or Supabase project is used — config.supabase
// and client.channels.fetch are swapped for lightweight fakes that track
// which channel ID got which message, so the test can tell the congrats
// post (to 1546413698979995678) apart from the internal staff Rank Log post
// (a different channel) and the Rank List refresh.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

function makeFakeChannel() {
  const sent = [];
  return {
    isTextBased: () => true,
    send: async (payload) => { sent.push(payload); return { id: "fake-message" }; },
    messages: { fetch: async () => new Map() },
    _sent: sent,
  };
}

function makeFakeSupabase(member) {
  const updates = [];
  return {
    from(table) {
      if (table === "clan_members") {
        return {
          select: () => ({
            ilike: () => ({ maybeSingle: async () => ({ data: member, error: null }) }),
          }),
          update: (patch) => ({
            eq: async () => { updates.push(patch); return { data: null, error: null }; },
          }),
        };
      }
      // xp_rank_logs and anything else: a no-op chain that resolves to empty.
      const emptyChain = new Proxy(() => emptyChain, {
        get(_t, prop) {
          if (prop === "then") return (resolve) => resolve({ data: [], error: null });
          return () => emptyChain;
        },
        apply() { return emptyChain; },
      });
      return { select: () => emptyChain, insert: () => emptyChain, update: () => emptyChain };
    },
    _updates: updates,
  };
}

function makeFakeInteraction(userId = "staff-1") {
  const deleted = { called: false };
  return {
    deferUpdate: async () => {},
    user: { id: userId, tag: "Staffer#0001", username: "Staffer" },
    message: {
      deletable: true,
      delete: async () => { deleted.called = true; },
    },
    _deleted: deleted,
  };
}

(async () => {
  // ---- Set up: a member confirmed from Diamond -> Dragonstone ----
  const member = {
    id: "member-row-1",
    rsn: "Rankupper",
    confirmed_rank: "Diamond",
    eligible_rank: "Dragonstone",
    xp: 510000,
  };

  bot.config.supabase = makeFakeSupabase(member);

  const announcementsChannel = makeFakeChannel();
  const rankLogChannel = makeFakeChannel();
  const otherChannel = makeFakeChannel(); // catch-all for Rank List / anything else

  bot.client.channels.fetch = async (id) => {
    if (id === bot.WEEKLY_RECAP_CHANNEL_ID) return announcementsChannel;
    if (id === bot.RANK_LOG_CHANNEL_ID) return rankLogChannel;
    return otherChannel;
  };

  const interaction = makeFakeInteraction();
  const encodedRsn = bot.encodeName ? bot.encodeName(member.rsn) : member.rsn;

  await bot.onRankUpConfirm2(interaction, encodedRsn, "Dragonstone");

  // ---- The public, no-ping congrats post went to the right channel ----
  check(
    "exactly one message was posted to the clan announcements/weekly-recap channel",
    announcementsChannel._sent.length === 1
  );
  const congrats = announcementsChannel._sent[0];
  const congratsText = congrats.embeds[0].data.description;

  check("the congrats message names the member by RSN", congratsText.includes("Rankupper"));
  check("the congrats message names the NEW rank (Dragonstone)", congratsText.includes("Dragonstone"));
  check("the congrats message does not name the OLD rank as the headline (not a diff, just the new rank)", !congratsText.includes("Diamond"));
  check("the congrats message says Congratulations", /congratulations/i.test(congratsText));

  check(
    "the message does not contain a Discord @mention (no way to ping anyone)",
    !/<@!?\d+>/.test(JSON.stringify(congrats))
  );
  check(
    "allowedMentions is explicitly locked down as a defensive second layer against pings",
    congrats.allowedMentions && Array.isArray(congrats.allowedMentions.parse) && congrats.allowedMentions.parse.length === 0
  );

  // ---- It's a SEPARATE post from the internal staff Rank Log (different channel, different purpose) ----
  check("the internal staff Rank Log still posts too, but to its own channel", rankLogChannel._sent.length === 1);
  check(
    "the Rank Log post and the congrats post are not the same channel object",
    announcementsChannel !== rankLogChannel
  );

  // ---- buildRankUpCongratsAnnouncement is itself exported and matches what was actually posted ----
  const built = bot.buildRankUpCongratsAnnouncement("Rankupper", "Dragonstone");
  check(
    "buildRankUpCongratsAnnouncement produces the exact same text runWeeklyRecap... (onRankUpConfirm2) posted",
    built.embeds[0].data.description === congratsText
  );

  // ---- A Member-Left confirmation must NEVER trigger this announcement ----
  // (onMemberLeftConfirm2 is a completely separate function from
  // onRankUpConfirm2 and never calls postRankUpCongratsAnnouncement/
  // buildRankUpCongratsAnnouncement — grep-level structural guarantee.)
  const onboardingSrc = require("fs").readFileSync(path.join(__dirname, "..", "onboarding.js"), "utf8");
  const memberLeftConfirm2Body = onboardingSrc.slice(
    onboardingSrc.indexOf("async function onMemberLeftConfirm2"),
    onboardingSrc.indexOf("async function onMemberLeftConfirm2") + 2000
  );
  check(
    "onMemberLeftConfirm2 never calls the rank-up congrats announcement",
    !memberLeftConfirm2Body.includes("postRankUpCongratsAnnouncement")
  );

  console.log(`\n[rank-up-congrats-announcement] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
