// Regression coverage for: "is there a way for the bot to know if im live on
// both and just merge both into the same embed? only when im live on both?"
//
// No real Twitch/Kick APIs or Discord connection are used —
// config.twitchStreamFetcher / config.kickStreamFetcher stand in for the real
// calls, and client.channels.fetch is swapped for a lightweight fake that
// records what got posted/edited/deleted where.
//
// TWITCH_USERNAME / KICK_USERNAME must be set BEFORE requiring onboarding.js
// (they're read from process.env at module load) so the combined alert's
// channel markers are real, findable strings.
process.env.TWITCH_USERNAME = "testtwitch";
process.env.KICK_USERNAME = "testkick";

const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));
bot.client.user = { id: "fake-bot-user", tag: "Heimdall#0001" };

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

const BOT_USER_ID = "fake-bot-user";

function makeFakeChannel(channelId = "fake-channel") {
  const sent = [];
  const edited = [];
  const deleted = [];
  const messagesById = new Map();
  const toEmbedData = (embed) => ({
    description: embed.data.description,
    footer: embed.data.footer || null,
    image: embed.data.image || null,
    fields: embed.data.fields || [],
    color: embed.data.color,
  });
  return {
    isTextBased: () => true,
    send: async (payload) => {
      const id = `fake-message-${sent.length + 1}`;
      sent.push(payload);
      const msg = {
        id,
        channelId,
        author: { id: BOT_USER_ID },
        embeds: (payload.embeds || []).map(toEmbedData),
        edit: async (p) => {
          edited.push({ id, payload: p });
          msg.lastPayload = p;
          msg.embeds = (p.embeds || []).map(toEmbedData);
          return msg;
        },
        delete: async () => {
          deleted.push(id);
          messagesById.delete(id);
          return msg;
        },
        lastPayload: payload,
      };
      messagesById.set(id, msg);
      return msg;
    },
    messages: {
      fetch: async (arg) => {
        if (arg && typeof arg === "object" && !Array.isArray(arg)) {
          return new Map([...messagesById.entries()].reverse());
        }
        return messagesById.get(arg) || null;
      },
    },
    _sent: sent,
    _edited: edited,
    _deleted: deleted,
  };
}

const TWITCH_LIVE = {
  live: true,
  id: "twitch-stream-1",
  title: "Twitch title one",
  gameName: "Old School RuneScape",
  userName: "TestTwitch",
  startedAt: "2026-11-14T12:00:00Z",
  thumbnailUrl: "https://static-cdn.jtvnw.net/previews-ttv/live_user_testtwitch-{width}x{height}.jpg",
  viewerCount: 123,
};
const KICK_LIVE = {
  live: true,
  id: "2026-11-14T12:05:00Z",
  title: "Kick title one",
  gameName: "Old School RuneScape",
  userName: "TestKick",
  startedAt: "2026-11-14T12:05:00Z",
  thumbnailUrl: "https://images.kick.com/video/live/testkick-thumb.jpg",
  viewerCount: 45,
};
const OFFLINE = { live: false };

function blankState() {
  return { wasLive: false, lastAlertedStreamId: null, lastAlertMessage: null, lastTitle: null, lastGameName: null, lastViewerCount: null, lastThumbnailUrl: null, lastUserName: null, lastImageRefreshAt: 0 };
}
function blankCombined() {
  return { message: null, imagePlatform: null, dead: false, lastEditAt: 0, lastTwitchTitle: null, lastTwitchGame: null, lastTwitchStreamId: null, lastKickTitle: null, lastKickGame: null, lastKickStreamId: null };
}
function resetAll() {
  bot.config.twitchLiveState = blankState();
  bot.config.kickLiveState = blankState();
  bot.config.combinedLiveAlert = blankCombined();
  bot.config.twitchImageRefreshIntervalMs = 5 * 60 * 1000;
  bot.config.kickImageRefreshIntervalMs = 5 * 60 * 1000;
}

(async () => {
  // ================= buildCombinedLiveAlert (embed shape) =================

  resetAll();
  bot.config.twitchLiveState = { ...blankState(), wasLive: true, lastAlertedStreamId: TWITCH_LIVE.id, lastTitle: TWITCH_LIVE.title, lastGameName: TWITCH_LIVE.gameName, lastViewerCount: TWITCH_LIVE.viewerCount, lastThumbnailUrl: TWITCH_LIVE.thumbnailUrl, lastUserName: TWITCH_LIVE.userName };
  bot.config.kickLiveState = { ...blankState(), wasLive: true, lastAlertedStreamId: KICK_LIVE.id, lastTitle: KICK_LIVE.title, lastGameName: KICK_LIVE.gameName, lastViewerCount: KICK_LIVE.viewerCount, lastThumbnailUrl: KICK_LIVE.thumbnailUrl, lastUserName: KICK_LIVE.userName };

  const twitchFirst = bot.buildCombinedLiveAlert("twitch");
  const twitchFirstDesc = twitchFirst.embeds[0].data.description;
  check("the combined alert says the streamer is live on Twitch", /is now live on twitch/i.test(twitchFirstDesc));
  check("the combined alert says the streamer is live on Kick", /is now live on kick/i.test(twitchFirstDesc));
  check("the combined alert links to the Twitch channel", twitchFirstDesc.includes("https://twitch.tv/testtwitch"));
  check("the combined alert links to the Kick channel", twitchFirstDesc.includes("https://kick.com/testkick"));
  check("the Twitch link is preceded by the custom Twitch emoji", twitchFirstDesc.includes("<:twitch:1571618429168001146> https://twitch.tv/testtwitch"));
  check("the Kick link is preceded by the custom Kick emoji", twitchFirstDesc.includes("<:kick:1571618398532534382> https://kick.com/testkick"));
  check("the combined alert shows the Twitch title", twitchFirstDesc.includes("Twitch title one"));
  check("the combined alert shows the Kick title", twitchFirstDesc.includes("Kick title one"));
  check("the Twitch title is marked with a purple circle", twitchFirstDesc.includes("🟣 **Twitch:** Twitch title one"));
  check("the Kick title is marked with a green circle", twitchFirstDesc.includes("🟢 **Kick:** Kick title one"));
  check("the combined alert shows the Twitch viewer count", twitchFirstDesc.includes("123 watching"));
  check("the combined alert shows the Kick viewer count", twitchFirstDesc.includes("45 watching"));
  check("the combined alert shows both games as fields", twitchFirst.embeds[0].data.fields?.some((f) => f.value === "Old School RuneScape") && twitchFirst.embeds[0].data.fields.length === 2);
  check("Twitch-first uses Twitch's brand color", twitchFirst.embeds[0].data.color === 0x9146ff);
  check("Twitch-first shows the Twitch preview image (placeholders resolved)", twitchFirst.embeds[0].data.image?.url.includes("previews-ttv") && !twitchFirst.embeds[0].data.image.url.includes("{width}"));
  check("Twitch-first footer lists Twitch first (encodes go-live order for restart recovery)", twitchFirst.embeds[0].data.footer?.text === "Streaming on Twitch and Kick");
  check("the combined alert does not contain a Discord @mention", !/<@!?\d+>/.test(JSON.stringify(twitchFirst)));
  check("the combined alert's allowedMentions is locked down", twitchFirst.allowedMentions && Array.isArray(twitchFirst.allowedMentions.parse) && twitchFirst.allowedMentions.parse.length === 0);

  const kickFirst = bot.buildCombinedLiveAlert("kick");
  check("Kick-first uses Kick's brand color", kickFirst.embeds[0].data.color === 0x53fc18);
  check("Kick-first shows the Kick preview image instead", kickFirst.embeds[0].data.image?.url.includes("images.kick.com"));
  check("Kick-first footer lists Kick first", kickFirst.embeds[0].data.footer?.text === "Streaming on Kick and Twitch");

  // Same display name on both platforms -> the header says it once.
  bot.config.kickLiveState = { ...bot.config.kickLiveState, lastUserName: "TestTwitch" };
  const sameNameDesc = bot.buildCombinedLiveAlert("twitch").embeds[0].data.description;
  check("when the name is the same on both platforms, the header says it once", sameNameDesc.includes("**TestTwitch** is now live on Twitch and Kick!") && !sameNameDesc.includes("is now live on Kick!"));
  check("the single-name header still matches the Twitch recovery search", /is now live on twitch/i.test(sameNameDesc));
  check("the single-name header still matches the Kick recovery search", /is now live on (kick|twitch and kick)/i.test(sameNameDesc));

  // ================= single -> combined transition (Twitch live first) =================

  const channel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
  bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? channel : makeFakeChannel());

  resetAll();
  bot.config.twitchStreamFetcher = async () => TWITCH_LIVE;
  bot.config.kickStreamFetcher = async () => OFFLINE;

  await bot.checkTwitchLiveStatus();
  check("Twitch going live alone posts its single-platform alert", channel._sent.length === 1 && !bot.config.combinedLiveAlert.message);
  check("the single alert is Twitch-only", /is now live on twitch/i.test(channel._sent[0].embeds[0].data.description) && !/is now live on kick/i.test(channel._sent[0].embeds[0].data.description));

  // Kick goes live too -> the single is deleted and one combined alert posted.
  bot.config.kickStreamFetcher = async () => KICK_LIVE;
  await bot.checkKickLiveStatus();
  check("going live on the second platform posts exactly one more message (the combined alert)", channel._sent.length === 2);
  check("the single-platform alert was deleted when the combined one took over", channel._deleted.length === 1 && channel._deleted[0] === "fake-message-1");
  const combinedDesc = channel._sent[1].embeds[0].data.description;
  check("the combined alert covers both platforms", /is now live on twitch/i.test(combinedDesc) && /is now live on kick/i.test(combinedDesc));
  check("the combined alert is now tracked", !!bot.config.combinedLiveAlert.message);
  check("Twitch went live first, so its preview image is the one shown", bot.config.combinedLiveAlert.imagePlatform === "twitch" && channel._sent[1].embeds[0].data.image?.url.includes("previews-ttv"));
  check("neither platform tracks a single-platform message anymore", !bot.config.twitchLiveState.lastAlertMessage && !bot.config.kickLiveState.lastAlertMessage);

  // ================= combined alert updates in place =================

  bot.config.kickStreamFetcher = async () => ({ ...KICK_LIVE, title: "Kick title two" });
  await bot.checkKickLiveStatus();
  check("a title change on one platform edits the combined alert instead of posting", channel._sent.length === 2 && channel._edited.length === 1);
  check("the edit shows the new Kick title and still covers both platforms", channel._edited[0].payload.embeds[0].data.description.includes("Kick title two") && /is now live on twitch/i.test(channel._edited[0].payload.embeds[0].data.description));

  await bot.checkKickLiveStatus();
  await bot.checkTwitchLiveStatus();
  check("polling again with nothing changed does not edit the combined alert again", channel._edited.length === 1);

  // A brand new Twitch session while combined -> edited in place, not reposted.
  bot.config.twitchStreamFetcher = async () => ({ ...TWITCH_LIVE, id: "twitch-stream-2", title: "Twitch title new session" });
  await bot.checkTwitchLiveStatus();
  check("a new stream session on one platform edits the combined alert rather than posting a new one", channel._sent.length === 2 && channel._edited.length === 2);
  check("the edit shows the new session's title", channel._edited[1].payload.embeds[0].data.description.includes("Twitch title new session"));

  // ================= combined -> single revert (Twitch ends, Kick continues) =================

  bot.config.twitchStreamFetcher = async () => OFFLINE;
  await bot.checkTwitchLiveStatus();
  check("one stream ending does not post anything new", channel._sent.length === 2);
  check("the combined message was edited back down into a single-platform alert", channel._edited.length === 3);
  const revertedDesc = channel._edited[2].payload.embeds[0].data.description;
  check("the reverted alert is Kick-only now", /is now live on kick/i.test(revertedDesc) && !/is now live on twitch/i.test(revertedDesc));
  check("the reverted alert keeps showing Kick's current title", revertedDesc.includes("Kick title two"));
  check("combined tracking is cleared after the revert", !bot.config.combinedLiveAlert.message && !bot.config.combinedLiveAlert.imagePlatform);
  check("Kick adopted the (former combined) message as its single alert", !!bot.config.kickLiveState.lastAlertMessage && bot.config.kickLiveState.lastAlertMessage.id === "fake-message-2");
  check("Twitch no longer tracks any message", !bot.config.twitchLiveState.lastAlertMessage && bot.config.twitchLiveState.wasLive === false);

  // Kick's title changes afterwards -> edits that same message via the normal single path.
  bot.config.kickStreamFetcher = async () => ({ ...KICK_LIVE, title: "Kick title three" });
  await bot.checkKickLiveStatus();
  check("after the revert, Kick title changes keep editing the same message", channel._sent.length === 2 && channel._edited.length === 4 && channel._edited[3].payload.embeds[0].data.description.includes("Kick title three"));

  // ================= both streams end -> combined stays as history =================

  {
    const ch = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? ch : makeFakeChannel());
    resetAll();
    bot.config.twitchStreamFetcher = async () => TWITCH_LIVE;
    bot.config.kickStreamFetcher = async () => KICK_LIVE;

    await bot.checkTwitchLiveStatus();
    await bot.checkKickLiveStatus();
    check("setup: both live produces a combined alert", ch._sent.length === 2 && !!bot.config.combinedLiveAlert.message);
    const deletedAfterCreate = ch._deleted.length;

    bot.config.twitchStreamFetcher = async () => OFFLINE;
    bot.config.kickStreamFetcher = async () => OFFLINE;
    await bot.checkTwitchLiveStatus();
    await bot.checkKickLiveStatus();
    check("both streams ending posts nothing new", ch._sent.length === 2);
    check("the combined alert message is left in the channel as a historical record (not deleted)", ch._deleted.length === deletedAfterCreate);
    check("combined tracking is cleared once both streams end", !bot.config.combinedLiveAlert.message && bot.config.combinedLiveAlert.dead === false);
    check("both platforms are marked offline", bot.config.twitchLiveState.wasLive === false && bot.config.kickLiveState.wasLive === false);

    // A fresh Twitch session afterwards posts a fresh single alert.
    bot.config.twitchStreamFetcher = async () => ({ ...TWITCH_LIVE, id: "twitch-stream-3", title: "Twitch title return" });
    await bot.checkTwitchLiveStatus();
    check("a new session after both ended posts a fresh single alert", ch._sent.length === 3 && /is now live on twitch/i.test(ch._sent[2].embeds[0].data.description) && !/is now live on kick/i.test(ch._sent[2].embeds[0].data.description));
  }

  // ================= Kick live first -> combined uses Kick's image =================

  {
    const ch = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? ch : makeFakeChannel());
    resetAll();
    bot.config.twitchStreamFetcher = async () => OFFLINE;
    bot.config.kickStreamFetcher = async () => KICK_LIVE;

    await bot.checkKickLiveStatus();
    check("Kick going live alone posts its single-platform alert", ch._sent.length === 1 && !bot.config.combinedLiveAlert.message);

    bot.config.twitchStreamFetcher = async () => TWITCH_LIVE;
    await bot.checkTwitchLiveStatus();
    check("Twitch going live second merges into a combined alert", ch._sent.length === 2 && !!bot.config.combinedLiveAlert.message);
    check("Kick went live first, so its preview image is the one shown", bot.config.combinedLiveAlert.imagePlatform === "kick" && ch._sent[1].embeds[0].data.image?.url.includes("images.kick.com"));
    check("the combined footer lists Kick first", ch._sent[1].embeds[0].data.footer?.text === "Streaming on Kick and Twitch");
  }

  // ================= only one platform ever live -> no combined alert =================

  {
    const ch = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? ch : makeFakeChannel());
    resetAll();
    bot.config.twitchStreamFetcher = async () => TWITCH_LIVE;
    bot.config.kickStreamFetcher = async () => OFFLINE;

    await bot.checkTwitchLiveStatus();
    await bot.checkTwitchLiveStatus();
    await bot.checkKickLiveStatus();
    check("a single-platform stream never creates a combined alert", ch._sent.length === 1 && ch._deleted.length === 0 && !bot.config.combinedLiveAlert.message);
  }

  // ================= prime recovers a combined alert after a restart =================

  {
    const ch = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? ch : makeFakeChannel());
    resetAll();
    // Simulate the pre-restart process: both live, combined alert posted.
    // Same display name on both platforms, like the real setup — so the
    // posted combined alert uses the single-name header.
    bot.config.twitchLiveState = { ...blankState(), wasLive: true, lastAlertedStreamId: TWITCH_LIVE.id, lastTitle: TWITCH_LIVE.title, lastGameName: TWITCH_LIVE.gameName, lastViewerCount: TWITCH_LIVE.viewerCount, lastThumbnailUrl: TWITCH_LIVE.thumbnailUrl, lastUserName: TWITCH_LIVE.userName };
    bot.config.kickLiveState = { ...blankState(), wasLive: true, lastAlertedStreamId: KICK_LIVE.id, lastTitle: KICK_LIVE.title, lastGameName: KICK_LIVE.gameName, lastViewerCount: KICK_LIVE.viewerCount, lastThumbnailUrl: KICK_LIVE.thumbnailUrl, lastUserName: TWITCH_LIVE.userName };
    await bot.postCombinedLiveAlert("twitch");
    check("setup: the pre-restart combined alert is sitting in the channel", ch._sent.length === 1);
    check("setup: the pre-restart combined alert uses the single-name header", ch._sent[0].embeds[0].data.description.includes("**TestTwitch** is now live on Twitch and Kick!"));
    check(
      "both platforms' recovery searches can find the combined alert",
      (await bot.findExistingTwitchLiveMessage("testtwitch"))?.id === "fake-message-1" &&
      (await bot.findExistingKickLiveMessage("testkick"))?.id === "fake-message-1"
    );

    // "Restart": blank in-memory state, then prime both platforms.
    resetAll();
    bot.config.twitchStreamFetcher = async () => TWITCH_LIVE;
    bot.config.kickStreamFetcher = async () => KICK_LIVE;
    await bot.primeTwitchLiveState();
    await bot.primeKickLiveState();

    check("priming after a restart never posts a new alert", ch._sent.length === 1);
    check("priming adopts the recovered combined alert", !!bot.config.combinedLiveAlert.message);
    check("priming recovers which platform went live first (from the footer)", bot.config.combinedLiveAlert.imagePlatform === "twitch");
    check("neither platform claims the combined message as its single alert", !bot.config.twitchLiveState.lastAlertMessage && !bot.config.kickLiveState.lastAlertMessage);
    check("both platforms are recorded as live", bot.config.twitchLiveState.wasLive === true && bot.config.kickLiveState.wasLive === true);

    // The next polls refresh the recovered combined message in place.
    await bot.checkTwitchLiveStatus();
    check("the first poll after recovery refreshes the combined alert instead of posting", ch._sent.length === 1 && ch._edited.length === 1);
    await bot.checkKickLiveStatus();
    check("once both platforms have polled, the combined alert shows both real titles", ch._edited.length === 2 && ch._edited[1].payload.embeds[0].data.description.includes("Twitch title one") && ch._edited[1].payload.embeds[0].data.description.includes("Kick title one"));
  }

  // ================= a vanished combined message stops updates, no repost =================

  {
    const ch = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? ch : makeFakeChannel());
    resetAll();
    bot.config.twitchStreamFetcher = async () => TWITCH_LIVE;
    bot.config.kickStreamFetcher = async () => KICK_LIVE;

    await bot.checkTwitchLiveStatus();
    await bot.checkKickLiveStatus();
    check("setup: combined alert is up", !!bot.config.combinedLiveAlert.message);
    const combinedMessage = bot.config.combinedLiveAlert.message;
    combinedMessage.edit = async () => { throw new Error("Unknown Message"); };

    bot.config.twitchStreamFetcher = async () => ({ ...TWITCH_LIVE, title: "Twitch title after deletion" });
    await bot.checkTwitchLiveStatus();
    check("a vanished combined message is handled gracefully (no throw)", bot.config.combinedLiveAlert.dead === true && !bot.config.combinedLiveAlert.message);

    await bot.checkKickLiveStatus();
    await bot.checkTwitchLiveStatus();
    check("the bot does not repost the combined alert for the rest of this session", ch._sent.length === 2);

    // One platform ends (clears the dead flag), then starts a new session ->
    // a fresh combined alert is posted.
    bot.config.twitchStreamFetcher = async () => OFFLINE;
    await bot.checkTwitchLiveStatus();
    check("the dead flag clears once a platform ends", bot.config.combinedLiveAlert.dead === false);

    bot.config.twitchStreamFetcher = async () => ({ ...TWITCH_LIVE, id: "twitch-stream-4", title: "Twitch title fresh combined" });
    await bot.checkTwitchLiveStatus();
    check("a new session after the vanished combined alert posts a fresh combined alert", ch._sent.length === 3 && !!bot.config.combinedLiveAlert.message && ch._sent[2].embeds[0].data.description.includes("Twitch title fresh combined"));
  }

  // ---- cleanup so this test doesn't leak state into other test files ----
  bot.config.twitchStreamFetcher = null;
  bot.config.kickStreamFetcher = null;
  resetAll();

  console.log(`\n[combined-live-alert] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
