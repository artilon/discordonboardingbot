// Regression coverage for: "i am now going to start streaming on kick so I
// need the bot to also do the same notification thing when i go live on
// twitch to also work for kick" — a second, fully independent "now live"
// alert subsystem for Kick, built on the exact same pattern as the Twitch
// one (see test/twitch-live-alert.test.js), including the restart-recovery
// and immediate-first-poll fixes that were already shipped for Twitch.
//
// No real Kick API or Discord connection is used — config.kickStreamFetcher
// stands in for the real Kick Public API call, and client.channels.fetch is
// swapped for a lightweight fake that records what got posted where.
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
  const messagesById = new Map();
  return {
    isTextBased: () => true,
    send: async (payload) => {
      const id = `fake-message-${sent.length + 1}`;
      sent.push(payload);
      const msg = {
        id,
        channelId,
        author: { id: BOT_USER_ID },
        embeds: (payload.embeds || []).map((e) => ({ description: e.data.description })),
        edit: async (p) => {
          edited.push({ id, payload: p });
          msg.lastPayload = p;
          msg.embeds = (p.embeds || []).map((e) => ({ description: e.data.description }));
          return msg;
        },
        lastPayload: payload,
      };
      messagesById.set(id, msg);
      return msg;
    },
    messages: {
      // Mirrors discord.js: fetch(id) looks up a single message; fetch({ limit })
      // returns a Map-like collection of recent messages, newest first.
      fetch: async (arg) => {
        if (arg && typeof arg === "object" && !Array.isArray(arg)) {
          return new Map([...messagesById.entries()].reverse());
        }
        return messagesById.get(arg) || null;
      },
    },
    _sent: sent,
    _edited: edited,
  };
}

// Kick statuses are normalized to the same shape as Twitch's, except there's
// no distinct stream-session id field, so `id` is the stream's start_time.
const LIVE_STREAM = {
  live: true,
  id: "2026-10-18T12:00:00Z",
  title: "Grinding Slayer for the clan!",
  gameName: "Old School RuneScape",
  userName: "SomeCoolStreamer",
  startedAt: "2026-10-18T12:00:00Z",
  thumbnailUrl: "https://images.kick.com/video_thumbnails/example/720.webp",
};
const OFFLINE_STATUS = { live: false };

(async () => {
  // ================= decideKickAlert (pure state machine, shared core with Twitch) =================

  // First time ever seeing the channel live -> alert, remember the stream id.
  {
    const prevState = { wasLive: false, lastAlertedStreamId: null };
    const { shouldAlert, nextState } = bot.decideKickAlert(prevState, LIVE_STREAM);
    check("first live observation triggers an alert", shouldAlert === true);
    check("next state remembers wasLive = true", nextState.wasLive === true);
    check("next state remembers this stream's id", nextState.lastAlertedStreamId === LIVE_STREAM.id);
  }

  // Still the same session on the next poll -> no repeat alert.
  {
    const prevState = { wasLive: true, lastAlertedStreamId: LIVE_STREAM.id };
    const { shouldAlert, nextState } = bot.decideKickAlert(prevState, LIVE_STREAM);
    check("the same ongoing stream session never re-alerts", shouldAlert === false);
    check("state still reflects the same stream id", nextState.lastAlertedStreamId === LIVE_STREAM.id);
  }

  // Goes offline -> state updates, no alert for going offline.
  {
    const prevState = { wasLive: true, lastAlertedStreamId: LIVE_STREAM.id };
    const { shouldAlert, nextState } = bot.decideKickAlert(prevState, OFFLINE_STATUS);
    check("going offline never triggers a (fictitious) alert", shouldAlert === false);
    check("wasLive flips back to false once offline", nextState.wasLive === false);
  }

  // A brand new stream session (new start_time) later alerts again.
  {
    const prevState = { wasLive: false, lastAlertedStreamId: LIVE_STREAM.id };
    const newSession = { ...LIVE_STREAM, id: "2026-10-18T20:00:00Z" };
    const { shouldAlert, nextState } = bot.decideKickAlert(prevState, newSession);
    check("a new stream session later the same day alerts again", shouldAlert === true);
    check("the new session's id is now remembered", nextState.lastAlertedStreamId === "2026-10-18T20:00:00Z");
  }

  // Defensive: a null/undefined status (fetch failure) never crashes or alerts.
  {
    const prevState = { wasLive: true, lastAlertedStreamId: LIVE_STREAM.id };
    const { shouldAlert, nextState } = bot.decideKickAlert(prevState, null);
    check("a failed/undefined fetch result never alerts", shouldAlert === false);
    check("a failed/undefined fetch result is treated as offline going forward", nextState.wasLive === false);
  }

  // decideKickAlert defaults its image-refresh cadence to config.kickImageRefreshIntervalMs
  // (independently from Twitch's own config.twitchImageRefreshIntervalMs).
  {
    const basePrevState = {
      wasLive: true,
      lastAlertedStreamId: LIVE_STREAM.id,
      lastAlertMessage: { id: "msg-1" },
      lastTitle: LIVE_STREAM.title,
      lastGameName: LIVE_STREAM.gameName,
      lastImageRefreshAt: Date.now() - 10 * 60 * 1000,
    };
    const originalInterval = bot.config.kickImageRefreshIntervalMs;
    bot.config.kickImageRefreshIntervalMs = 5 * 60 * 1000;
    const imageDue = bot.decideKickAlert(basePrevState, LIVE_STREAM);
    check("decideKickAlert uses config.kickImageRefreshIntervalMs as its default cadence", imageDue.shouldUpdate === true);
    bot.config.kickImageRefreshIntervalMs = originalInterval;

    const titleChanged = bot.decideKickAlert(
      { ...basePrevState, lastImageRefreshAt: Date.now() },
      { ...LIVE_STREAM, title: "New title!" },
      { now: Date.now() }
    );
    check("a title change on the same ongoing session triggers an in-place update, not a new alert", titleChanged.shouldAlert === false && titleChanged.shouldUpdate === true);

    const noMessageOnFile = bot.decideKickAlert(
      { ...basePrevState, lastAlertMessage: null, lastImageRefreshAt: Date.now() },
      { ...LIVE_STREAM, title: "New title!" },
      { now: Date.now() }
    );
    check(
      "a title change is never treated as 'update' when there's no alert message on file to edit",
      noMessageOnFile.shouldUpdate === false
    );

    const newSessionNeverUpdates = bot.decideKickAlert(
      { ...basePrevState, lastImageRefreshAt: Date.now() },
      { ...LIVE_STREAM, id: "2026-10-19T00:00:00Z", title: "Brand new session" },
      { now: Date.now() }
    );
    check("a genuinely NEW session always posts fresh rather than editing the previous session's message", newSessionNeverUpdates.shouldAlert === true && newSessionNeverUpdates.shouldUpdate === false);
  }

  // ================= buildKickLiveAlert (embed shape) =================

  const built = bot.buildKickLiveAlert(LIVE_STREAM, "somecoolstreamer");
  const builtDescription = built.embeds[0].data.description;

  check("the alert names the streamer", builtDescription.includes("SomeCoolStreamer"));
  check("the alert includes the stream title", builtDescription.includes("Grinding Slayer for the clan!"));
  check("the alert links to the Kick channel", builtDescription.includes("https://kick.com/somecoolstreamer"));
  check("the Kick link is preceded by the custom Kick emoji", builtDescription.includes("<:kick:1571618398532534382> https://kick.com/somecoolstreamer"));
  check("the alert says it's live on Kick", /live on kick/i.test(builtDescription));
  check(
    "the alert does not contain a Discord @mention (no way to ping anyone)",
    !/<@!?\d+>/.test(JSON.stringify(built))
  );
  check(
    "allowedMentions is explicitly locked down as a defensive second layer against pings",
    built.allowedMentions && Array.isArray(built.allowedMentions.parse) && built.allowedMentions.parse.length === 0
  );
  check(
    "the game/activity is included as a field when known",
    built.embeds[0].data.fields?.some((f) => f.value === "Old School RuneScape")
  );
  check(
    "the thumbnail is set directly (Kick's thumbnail URL needs no {width}/{height} substitution)",
    built.embeds[0].data.image?.url?.startsWith(LIVE_STREAM.thumbnailUrl)
  );

  const minimalBuilt = bot.buildKickLiveAlert({ live: true, id: "x", title: "", userName: "Minimal" }, "minimal");
  check("a minimal stream (no title/game/thumbnail) still builds without throwing", !!minimalBuilt.embeds[0]);
  check("a minimal stream falls back to a generic 'no title' message", minimalBuilt.embeds[0].data.description.includes("No title set"));

  // ================= checkKickLiveStatus (end-to-end wiring, fetcher mocked) =================

  const announcementsChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
  const otherChannel = makeFakeChannel();
  bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? announcementsChannel : otherChannel);

  bot.config.kickLiveState = { wasLive: false, lastAlertedStreamId: null };
  bot.config.kickStreamFetcher = async () => LIVE_STREAM;

  await bot.checkKickLiveStatus();
  check("checkKickLiveStatus posts exactly one alert on a fresh go-live", announcementsChannel._sent.length === 1);
  check("the posted alert went to the clan announcements channel (same as Twitch's)", announcementsChannel._sent[0].embeds[0].data.description.includes("SomeCoolStreamer"));
  check("no other channel received anything", otherChannel._sent.length === 0);
  check("config.kickLiveState was updated to remember this stream", bot.config.kickLiveState.wasLive === true && bot.config.kickLiveState.lastAlertedStreamId === LIVE_STREAM.id);

  // Polling again mid-stream must NOT post a second alert.
  await bot.checkKickLiveStatus();
  check("polling again while still the same live session does not double-post", announcementsChannel._sent.length === 1);

  // Going offline then live again (a new stream id) posts a second, distinct alert.
  bot.config.kickStreamFetcher = async () => OFFLINE_STATUS;
  await bot.checkKickLiveStatus();
  check("going offline posts nothing new", announcementsChannel._sent.length === 1);

  bot.config.kickStreamFetcher = async () => ({ ...LIVE_STREAM, id: "2026-10-19T00:00:00Z", title: "Back again!" });
  await bot.checkKickLiveStatus();
  check("a genuinely new stream session later alerts again", announcementsChannel._sent.length === 2);
  check("the second alert is for the new stream's content", announcementsChannel._sent[1].embeds[0].data.description.includes("Back again!"));

  // ================= checkKickLiveStatus: keeping the alert current (end-to-end) =================
  {
    const channel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? channel : makeFakeChannel());

    bot.config.kickLiveState = { wasLive: false, lastAlertedStreamId: null };
    bot.config.kickImageRefreshIntervalMs = 5 * 60 * 1000;
    bot.config.kickStreamFetcher = async () => LIVE_STREAM;

    await bot.checkKickLiveStatus();
    check("the initial go-live posts exactly one message", channel._sent.length === 1 && channel._edited.length === 0);
    const firstMessage = bot.config.kickLiveState.lastAlertMessage;
    check(
      "the posted message is remembered directly so later edits need no re-fetch/extra permission",
      !!firstMessage && firstMessage.channelId === bot.WEEKLY_RECAP_CHANNEL_ID
    );

    bot.config.kickStreamFetcher = async () => ({ ...LIVE_STREAM, title: "Now grinding bosses!" });
    await bot.checkKickLiveStatus();
    check("a title change mid-stream edits the existing alert instead of posting a new one", channel._sent.length === 1 && channel._edited.length === 1);
    check("the edit reflects the new title", channel._edited[0].payload.embeds[0].data.description.includes("Now grinding bosses!"));
    check("the edit targets the original message id", channel._edited[0].id === firstMessage.id);

    await bot.checkKickLiveStatus();
    check("polling again with nothing changed and the image not due yet does not edit again", channel._edited.length === 1);

    bot.config.kickLiveState.lastImageRefreshAt = Date.now() - 10 * 60 * 1000;
    await bot.checkKickLiveStatus();
    check("once the image refresh interval elapses, the alert is edited again even with no title/game change", channel._edited.length === 2);

    firstMessage.edit = async () => { throw new Error("Unknown Message"); };
    bot.config.kickStreamFetcher = async () => ({ ...LIVE_STREAM, title: "Yet another title change" });
    await bot.checkKickLiveStatus();
    check("a vanished message is handled gracefully (no throw) instead of crashing the poll", channel._edited.length === 2);
    check("after a failed edit, the bot stops tracking the vanished message for this session", !bot.config.kickLiveState.lastAlertMessage);

    bot.config.kickStreamFetcher = async () => OFFLINE_STATUS;
    await bot.checkKickLiveStatus();
    bot.config.kickStreamFetcher = async () => ({ ...LIVE_STREAM, id: "2026-10-20T00:00:00Z" });
    await bot.checkKickLiveStatus();
    check("a new session after the vanished-message session posts a brand new alert", channel._sent.length === 2);
  }

  bot.config.kickImageRefreshIntervalMs = 5 * 60 * 1000;

  // ================= primeKickLiveState (startup, must never alert) =================

  const primeChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
  bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? primeChannel : makeFakeChannel());

  bot.config.kickLiveState = { wasLive: false, lastAlertedStreamId: null };
  bot.config.kickStreamFetcher = async () => ({ ...LIVE_STREAM, id: "already-running" });

  await bot.primeKickLiveState();
  check("priming at startup never posts an alert, even if already live", primeChannel._sent.length === 0);
  check("priming still records the in-progress stream so a later restart check won't re-fire for it", bot.config.kickLiveState.wasLive === true && bot.config.kickLiveState.lastAlertedStreamId === "already-running");

  bot.config.kickStreamFetcher = async () => ({ ...LIVE_STREAM, id: "already-running" });
  await bot.checkKickLiveStatus();
  check("the first real poll after a silent startup prime does not retroactively alert for the already-running stream", primeChannel._sent.length === 0);

  bot.config.kickStreamFetcher = async () => OFFLINE_STATUS;
  await bot.checkKickLiveStatus();
  bot.config.kickStreamFetcher = async () => ({ ...LIVE_STREAM, id: "truly-new" });
  await bot.checkKickLiveStatus();
  check("a fresh stream after the primed one ends does trigger a real alert", primeChannel._sent.length === 1);

  // ================= primeKickLiveState: recovering an in-progress alert after a restart =================
  {
    const recoveryChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? recoveryChannel : makeFakeChannel());

    const preRestartStream = { ...LIVE_STREAM, id: "pre-restart", title: "Streaming before the restart" };
    await bot.postKickLiveAlert(preRestartStream, undefined);
    check("sanity: the pre-restart alert is sitting in the channel", recoveryChannel._sent.length === 1);

    bot.config.kickLiveState = { wasLive: false, lastAlertedStreamId: null };
    bot.config.kickStreamFetcher = async () => preRestartStream;
    await bot.primeKickLiveState();

    check("priming after a restart still never posts a brand new alert", recoveryChannel._sent.length === 1);
    check("priming recovers the existing alert message instead of losing track of it", !!bot.config.kickLiveState.lastAlertMessage);
    check("the recovered message is the one actually posted before the restart", bot.config.kickLiveState.lastAlertMessage?.id === "fake-message-1" && recoveryChannel._edited.length === 0);

    await bot.checkKickLiveStatus();
    check("the first poll after recovery refreshes the recovered message", recoveryChannel._edited.length === 1);
    check("the refresh keeps showing the pre-restart stream's real title", recoveryChannel._edited[0].payload.embeds[0].data.description.includes("Streaming before the restart"));

    bot.config.kickStreamFetcher = async () => ({ ...preRestartStream, title: "Still going strong hours later" });
    await bot.checkKickLiveStatus();
    check("further title changes keep editing the recovered message, not a new one", recoveryChannel._sent.length === 1 && recoveryChannel._edited.length === 2);
  }

  // Degrades gracefully if the channel can't be searched.
  {
    const unreadableChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    unreadableChannel.messages.fetch = async () => { throw new Error("Missing Access"); };
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? unreadableChannel : makeFakeChannel());

    bot.config.kickLiveState = { wasLive: false, lastAlertedStreamId: null };
    bot.config.kickStreamFetcher = async () => ({ ...LIVE_STREAM, id: "unreadable-history" });

    await bot.primeKickLiveState();
    check("a channel that can't be searched for history doesn't crash priming", unreadableChannel._sent.length === 0);
    check("priming still records the live session even without a recovered message", bot.config.kickLiveState.wasLive === true && !bot.config.kickLiveState.lastAlertMessage);

    await bot.checkKickLiveStatus();
    check("with no message to edit, the poll just does nothing for that ongoing session", unreadableChannel._sent.length === 0 && unreadableChannel._edited.length === 0);
  }

  // Cross-platform isolation: a Twitch alert mid-stream must not be mistaken
  // for a Kick one when priming/searching (and vice versa) — they only
  // differ by URL domain in the embed description, which is enough to tell
  // them apart even though both are posted by the bot to the same channel.
  {
    const sharedChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? sharedChannel : makeFakeChannel());

    await bot.postTwitchLiveAlert({ ...LIVE_STREAM, id: "twitch-side-by-side" }, "somecoolstreamer");
    check("sanity: a Twitch alert is sitting in the shared channel", sharedChannel._sent.length === 1);

    const foundForKick = await bot.findExistingKickLiveMessage("somecoolstreamer");
    check("searching for an existing KICK alert does not pick up a Twitch alert for the same username", foundForKick === null);

    await bot.postKickLiveAlert({ ...LIVE_STREAM, id: "kick-side-by-side" }, "somecoolstreamer");
    const foundForTwitch = await bot.findExistingTwitchLiveMessage("somecoolstreamer");
    check("searching for an existing TWITCH alert does not pick up the Kick alert either", foundForTwitch?.id === "fake-message-1");

    const foundForKickNow = await bot.findExistingKickLiveMessage("somecoolstreamer");
    check("the Kick search correctly finds the Kick alert once it exists", foundForKickNow?.id === "fake-message-2");
  }

  // ================= startKickLiveLoop: the first check runs immediately on startup =================
  {
    const loopChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? loopChannel : makeFakeChannel());

    bot.config.kickLiveState = { wasLive: false, lastAlertedStreamId: null };
    bot.config.kickStreamFetcher = async () => ({ ...LIVE_STREAM, id: "loop-start" });

    bot.startKickLiveLoop();
    await new Promise((resolve) => setImmediate(resolve));
    check(
      "starting the poll loop posts the first alert right away, without waiting for the poll interval to elapse",
      loopChannel._sent.length === 1
    );

    bot.stopKickLiveLoop();
  }

  // ---- cleanup so this test doesn't leak state into other test files ----
  bot.config.kickStreamFetcher = null;
  bot.config.kickLiveState = { wasLive: false, lastAlertedStreamId: null };
  bot.config.twitchStreamFetcher = null;
  bot.config.twitchLiveState = { wasLive: false, lastAlertedStreamId: null };

  console.log(`\n[kick-live-alert] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
