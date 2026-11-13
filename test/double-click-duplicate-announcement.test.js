// Regression coverage for: a staff member double-clicked the "Yes, Confirm"
// button on a Rank-Up staff alert (or clicked it twice in quick succession
// before the alert message visibly disappeared) and got TWO identical
// "Congratulations to X on ranking up to Y!" posts in the clan announcements
// channel for the same promotion (also observed for a Member-Left alert's
// analogous confirm step). Root cause: onRankUpConfirm2/onMemberLeftConfirm2
// had no guard against being invoked twice for the same alert message, so
// each click independently promoted the member and posted its own
// announcement. Fixed via claimAlertConfirmation(), a synchronous
// (await-free) in-memory claim keyed by the alert message id.
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
            eq: async () => {
              updates.push(patch);
              Object.assign(member, patch); // mimic the DB actually persisting the patch
              return { data: null, error: null };
            },
          }),
        };
      }
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

function makeFakeInteraction(messageId, userId = "staff-1") {
  const deleted = { called: false };
  return {
    deferUpdate: async () => {},
    user: { id: userId, tag: "Staffer#0001", username: "Staffer" },
    message: {
      id: messageId,
      deletable: true,
      delete: async () => { deleted.called = true; },
    },
    _deleted: deleted,
  };
}

(async () => {
  // ================= Rank-Up: double click on the same alert message =================
  const member = {
    id: "member-row-1",
    rsn: "DukeDHunter9",
    confirmed_rank: "Silver",
    eligible_rank: "Black",
    xp: 100000,
    pending_alert_message_id: "alert-msg-123",
    pending_alert_type: "rank_up",
  };

  bot.config.supabase = makeFakeSupabase(member);

  const announcementsChannel = makeFakeChannel();
  const rankLogChannel = makeFakeChannel();
  const otherChannel = makeFakeChannel();

  bot.client.channels.fetch = async (id) => {
    if (id === bot.WEEKLY_RECAP_CHANNEL_ID) return announcementsChannel;
    if (id === bot.RANK_LOG_CHANNEL_ID) return rankLogChannel;
    return otherChannel;
  };

  const encodedRsn = bot.encodeName ? bot.encodeName(member.rsn) : member.rsn;

  // Two interactions firing for the SAME alert message (same message id) —
  // simulating a double-click or a retried interaction delivery.
  const click1 = makeFakeInteraction("alert-msg-123");
  const click2 = makeFakeInteraction("alert-msg-123");

  await Promise.all([
    bot.onRankUpConfirm2(click1, encodedRsn, "Black"),
    bot.onRankUpConfirm2(click2, encodedRsn, "Black"),
  ]);

  check(
    "only ONE congrats announcement was posted even though the confirm handler ran twice for the same alert",
    announcementsChannel._sent.length === 1
  );
  check(
    "only ONE internal rank-log entry was posted too",
    rankLogChannel._sent.length === 1
  );
  check("the member's confirmed_rank still ends up correctly promoted", member.confirmed_rank === "Black");

  // A THIRD click, on the SAME message id, after everything already
  // resolved — still must not double-post.
  const click3 = makeFakeInteraction("alert-msg-123");
  await bot.onRankUpConfirm2(click3, encodedRsn, "Black");
  check("a third late click on the same alert still doesn't post again", announcementsChannel._sent.length === 1);

  // ---- A DIFFERENT alert message (different promotion) is NOT blocked by the guard ----
  const member2 = {
    id: "member-row-2",
    rsn: "Moist Divide",
    confirmed_rank: "Silver",
    eligible_rank: "Black",
    xp: 100000,
    pending_alert_message_id: "alert-msg-456",
    pending_alert_type: "rank_up",
  };
  bot.config.supabase = makeFakeSupabase(member2);
  const announcementsChannel2 = makeFakeChannel();
  bot.client.channels.fetch = async (id) => {
    if (id === bot.WEEKLY_RECAP_CHANNEL_ID) return announcementsChannel2;
    if (id === bot.RANK_LOG_CHANNEL_ID) return rankLogChannel;
    return otherChannel;
  };
  const encodedRsn2 = bot.encodeName ? bot.encodeName(member2.rsn) : member2.rsn;
  await bot.onRankUpConfirm2(makeFakeInteraction("alert-msg-456"), encodedRsn2, "Black");
  check("a different member's alert (different message id) still posts normally", announcementsChannel2._sent.length === 1);

  // ================= claimAlertConfirmation: direct unit coverage =================
  check("claiming a fresh message id succeeds", bot.claimAlertConfirmation("unit-test-msg-1") === true);
  check("claiming the SAME message id again fails", bot.claimAlertConfirmation("unit-test-msg-1") === false);
  check("a missing/undefined message id is never blocked (e.g. test doubles without a real message)", bot.claimAlertConfirmation(undefined) === true);
  check("...and calling it again with undefined still doesn't block", bot.claimAlertConfirmation(undefined) === true);

  // ================= Member-Left: same double-click guard =================
  const leftMember = {
    id: "member-row-3",
    rsn: "Departing Guy",
    confirmed_rank: "Gold",
    eligible_rank: "Gold",
    xp: 50000,
    pending_alert_message_id: "left-alert-789",
    pending_alert_type: "member_left",
  };
  bot.config.supabase = makeFakeSupabase(leftMember);
  const logChannel = makeFakeChannel();
  bot.client.channels.fetch = async () => logChannel;

  const encodedLeftRsn = bot.encodeName ? bot.encodeName(leftMember.rsn) : leftMember.rsn;
  const leftClick1 = makeFakeInteraction("left-alert-789");
  const leftClick2 = makeFakeInteraction("left-alert-789");
  await Promise.all([
    bot.onMemberLeftConfirm2(leftClick1, encodedLeftRsn),
    bot.onMemberLeftConfirm2(leftClick2, encodedLeftRsn),
  ]);
  check(
    "a double-clicked Member-Left confirmation only logs the departure once",
    logChannel._sent.length === 1
  );

  // ---- cleanup ----
  bot.config.supabase = null;

  console.log(`\n[double-click-duplicate-announcement] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
