// Regression coverage for: "is there a way to have the bot post an alert (no
// ping) to the same channel the digest and rank up congrats messages are
// posted in, whenever I go live on twitch if I provide my twitch info?"
//
// No real Twitch API or Discord connection is used — config.twitchStreamFetcher
// stands in for the real Helix call, and client.channels.fetch is swapped for
// a lightweight fake that records what got posted where, mirroring the
// pattern used by test/rank-up-congrats-announcement.test.js.
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

const LIVE_STREAM = {
  live: true,
  id: "stream-abc-1",
  title: "Grinding Slayer for the clan!",
  gameName: "Old School RuneScape",
  userName: "SomeCoolStreamer",
  startedAt: "2026-10-18T12:00:00Z",
  thumbnailUrl: "https://static-cdn.jtvnw.net/previews-ttv/live_user_x-{width}x{height}.jpg",
};
const OFFLINE_STATUS = { live: false };

(async () => {
  // ================= decideTwitchAlert (pure state machine) =================

  // First time ever seeing the channel live -> alert, remember the stream id.
  {
    const prevState = { wasLive: false, lastAlertedStreamId: null };
    const { shouldAlert, nextState } = bot.decideTwitchAlert(prevState, LIVE_STREAM);
    check("first live observation triggers an alert", shouldAlert === true);
    check("next state remembers wasLive = true", nextState.wasLive === true);
    check("next state remembers this stream's id", nextState.lastAlertedStreamId === "stream-abc-1");
  }

  // Still the same session on the next poll -> no repeat alert.
  {
    const prevState = { wasLive: true, lastAlertedStreamId: "stream-abc-1" };
    const { shouldAlert, nextState } = bot.decideTwitchAlert(prevState, LIVE_STREAM);
    check("the same ongoing stream session never re-alerts", shouldAlert === false);
    check("state still reflects the same stream id", nextState.lastAlertedStreamId === "stream-abc-1");
  }

  // Goes offline -> state updates, no alert for going offline.
  {
    const prevState = { wasLive: true, lastAlertedStreamId: "stream-abc-1" };
    const { shouldAlert, nextState } = bot.decideTwitchAlert(prevState, OFFLINE_STATUS);
    check("going offline never triggers a (fictitious) alert", shouldAlert === false);
    check("wasLive flips back to false once offline", nextState.wasLive === false);
    check("the last alerted stream id is preserved across the offline gap", nextState.lastAlertedStreamId === "stream-abc-1");
  }

  // Offline, then a brand NEW stream session starts later the same day -> alerts again.
  {
    const prevState = { wasLive: false, lastAlertedStreamId: "stream-abc-1" };
    const newSession = { ...LIVE_STREAM, id: "stream-def-2" };
    const { shouldAlert, nextState } = bot.decideTwitchAlert(prevState, newSession);
    check("a new stream session later the same day alerts again", shouldAlert === true);
    check("the new session's id is now remembered", nextState.lastAlertedStreamId === "stream-def-2");
  }

  // Flicker protection: Twitch API hiccup reports the SAME stream id again
  // right after it was already alerted (without ever truly going offline) -> no duplicate.
  {
    const prevState = { wasLive: true, lastAlertedStreamId: "stream-abc-1" };
    const { shouldAlert } = bot.decideTwitchAlert(prevState, { ...LIVE_STREAM, id: "stream-abc-1" });
    check("re-seeing the same stream id while already marked live does not duplicate-alert", shouldAlert === false);
  }

  // Defensive: a null/undefined status (fetch failure) never crashes or alerts.
  {
    const prevState = { wasLive: true, lastAlertedStreamId: "stream-abc-1" };
    const { shouldAlert, nextState } = bot.decideTwitchAlert(prevState, null);
    check("a failed/undefined fetch result never alerts", shouldAlert === false);
    check("a failed/undefined fetch result is treated as offline going forward", nextState.wasLive === false);
  }

  // ================= decideTwitchAlert: keeping the posted alert current =================
  // Regression coverage for: "can you make the bot update the stream title
  // and image of the stream when it pings it?" — the already-posted alert
  // message should be edited in place as the stream's title/game change, and
  // its preview image refreshed periodically even with no other change, as
  // long as there's an actual message on file to edit.
  {
    const basePrevState = {
      wasLive: true,
      lastAlertedStreamId: "stream-abc-1",
      lastAlertMessage: { id: "msg-1" },
      lastTitle: LIVE_STREAM.title,
      lastGameName: LIVE_STREAM.gameName,
      lastImageRefreshAt: Date.now(),
    };

    const sameEverything = bot.decideTwitchAlert(basePrevState, LIVE_STREAM, { now: Date.now() });
    check("no title/game change and the image isn't due for a refresh yet -> no update", sameEverything.shouldAlert === false && sameEverything.shouldUpdate === false);

    const titleChanged = bot.decideTwitchAlert(basePrevState, { ...LIVE_STREAM, title: "New title!" }, { now: Date.now() });
    check("a title change on the same ongoing session triggers an in-place update, not a new alert", titleChanged.shouldAlert === false && titleChanged.shouldUpdate === true);

    const gameChanged = bot.decideTwitchAlert(basePrevState, { ...LIVE_STREAM, gameName: "A different game" }, { now: Date.now() });
    check("a game change on the same ongoing session also triggers an in-place update", gameChanged.shouldUpdate === true);

    const imageDue = bot.decideTwitchAlert(basePrevState, LIVE_STREAM, {
      now: basePrevState.lastImageRefreshAt + 10 * 60 * 1000,
      imageRefreshIntervalMs: 5 * 60 * 1000,
    });
    check("even with nothing else changed, the preview image is refreshed once the refresh interval has elapsed", imageDue.shouldUpdate === true);

    const imageNotDueYet = bot.decideTwitchAlert(basePrevState, LIVE_STREAM, {
      now: basePrevState.lastImageRefreshAt + 1000,
      imageRefreshIntervalMs: 5 * 60 * 1000,
    });
    check("the image refresh doesn't fire early, before its own interval has elapsed", imageNotDueYet.shouldUpdate === false);

    const noMessageOnFile = bot.decideTwitchAlert(
      { ...basePrevState, lastAlertMessage: null },
      { ...LIVE_STREAM, title: "New title!" },
      { now: Date.now() }
    );
    check(
      "a title change is never treated as 'update' when there's no alert message on file to edit (e.g. a stream that was already live at startup)",
      noMessageOnFile.shouldUpdate === false
    );

    const newSessionNeverUpdates = bot.decideTwitchAlert(basePrevState, { ...LIVE_STREAM, id: "stream-def-2", title: "Brand new session" }, { now: Date.now() });
    check("a genuinely NEW session always posts fresh rather than editing the previous session's message", newSessionNeverUpdates.shouldAlert === true && newSessionNeverUpdates.shouldUpdate === false);
  }

  // ================= buildTwitchLiveAlert (embed shape) =================

  const built = bot.buildTwitchLiveAlert(LIVE_STREAM, "somecoolstreamer");
  const builtDescription = built.embeds[0].data.description;

  check("the alert names the streamer", builtDescription.includes("SomeCoolStreamer"));
  check("the alert includes the stream title", builtDescription.includes("Grinding Slayer for the clan!"));
  check("the alert links to the Twitch channel", builtDescription.includes("https://twitch.tv/somecoolstreamer"));
  check("the alert says it's live", /live/i.test(builtDescription));
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
    "the thumbnail's {width}/{height} placeholders are resolved to real numbers",
    built.embeds[0].data.image?.url && !built.embeds[0].data.image.url.includes("{width}") && !built.embeds[0].data.image.url.includes("{height}")
  );

  // A stream with no game set and no thumbnail still builds a valid, minimal alert.
  const minimalBuilt = bot.buildTwitchLiveAlert({ live: true, id: "x", title: "", userName: "Minimal" }, "minimal");
  check("a minimal stream (no title/game/thumbnail) still builds without throwing", !!minimalBuilt.embeds[0]);
  check("a minimal stream falls back to a generic 'no title' message", minimalBuilt.embeds[0].data.description.includes("No title set"));

  // ================= checkTwitchLiveStatus (end-to-end wiring, fetcher mocked) =================

  const announcementsChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
  const otherChannel = makeFakeChannel();
  bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? announcementsChannel : otherChannel);

  bot.config.twitchLiveState = { wasLive: false, lastAlertedStreamId: null };
  bot.config.twitchStreamFetcher = async () => LIVE_STREAM;

  await bot.checkTwitchLiveStatus();
  check("checkTwitchLiveStatus posts exactly one alert on a fresh go-live", announcementsChannel._sent.length === 1);
  check("the posted alert went to the clan announcements channel (same as digest / rank-up congrats)", announcementsChannel._sent[0].embeds[0].data.description.includes("SomeCoolStreamer"));
  check("no other channel received anything", otherChannel._sent.length === 0);
  check("config.twitchLiveState was updated to remember this stream", bot.config.twitchLiveState.wasLive === true && bot.config.twitchLiveState.lastAlertedStreamId === "stream-abc-1");

  // Polling again mid-stream must NOT post a second alert.
  await bot.checkTwitchLiveStatus();
  check("polling again while still the same live session does not double-post", announcementsChannel._sent.length === 1);

  // Going offline then live again (a new stream id) posts a second, distinct alert.
  bot.config.twitchStreamFetcher = async () => OFFLINE_STATUS;
  await bot.checkTwitchLiveStatus();
  check("going offline posts nothing new", announcementsChannel._sent.length === 1);

  bot.config.twitchStreamFetcher = async () => ({ ...LIVE_STREAM, id: "stream-def-2", title: "Back again!" });
  await bot.checkTwitchLiveStatus();
  check("a genuinely new stream session later alerts again", announcementsChannel._sent.length === 2);
  check("the second alert is for the new stream's content", announcementsChannel._sent[1].embeds[0].data.description.includes("Back again!"));

  // ================= checkTwitchLiveStatus: keeping the alert current (end-to-end) =================
  {
    const channel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? channel : makeFakeChannel());

    bot.config.twitchLiveState = { wasLive: false, lastAlertedStreamId: null };
    bot.config.twitchImageRefreshIntervalMs = 5 * 60 * 1000;
    bot.config.twitchStreamFetcher = async () => LIVE_STREAM;

    await bot.checkTwitchLiveStatus();
    check("the initial go-live posts exactly one message", channel._sent.length === 1 && channel._edited.length === 0);
    check(
      "the posted message is remembered directly (not just an id) so later edits need no re-fetch/extra permission",
      !!bot.config.twitchLiveState.lastAlertMessage && bot.config.twitchLiveState.lastAlertMessage.channelId === bot.WEEKLY_RECAP_CHANNEL_ID
    );
    const firstMessage = bot.config.twitchLiveState.lastAlertMessage;

    // The title changes mid-stream — must edit the SAME message, not post a new one.
    bot.config.twitchStreamFetcher = async () => ({ ...LIVE_STREAM, title: "Now grinding bosses!" });
    await bot.checkTwitchLiveStatus();
    check("a title change mid-stream edits the existing alert instead of posting a new one", channel._sent.length === 1 && channel._edited.length === 1);
    check("the edit reflects the new title", channel._edited[0].payload.embeds[0].data.description.includes("Now grinding bosses!"));
    check("the edit targets the original message id", channel._edited[0].id === firstMessage.id);

    // Polling again immediately with no change and the image not due yet -> no further edit.
    await bot.checkTwitchLiveStatus();
    check("polling again with nothing changed and the image not due yet does not edit again", channel._edited.length === 1);

    // Time passes well beyond the image refresh interval with still no title/game change -> refreshes anyway.
    bot.config.twitchLiveState.lastImageRefreshAt = Date.now() - 10 * 60 * 1000;
    await bot.checkTwitchLiveStatus();
    check("once the image refresh interval elapses, the alert is edited again even with no title/game change", channel._edited.length === 2);

    // The alert message gets deleted out from under the bot — editing it now rejects.
    // Further polls must not keep failing/retrying forever against a dead reference.
    firstMessage.edit = async () => { throw new Error("Unknown Message"); };
    bot.config.twitchStreamFetcher = async () => ({ ...LIVE_STREAM, title: "Yet another title change" });
    await bot.checkTwitchLiveStatus();
    check("a vanished message is handled gracefully (no throw) instead of crashing the poll", channel._edited.length === 2);
    check("after a failed edit, the bot stops tracking the vanished message for this session", !bot.config.twitchLiveState.lastAlertMessage);

    // Going offline then live again starts a fresh session/message, not reusing the stale state.
    bot.config.twitchStreamFetcher = async () => OFFLINE_STATUS;
    await bot.checkTwitchLiveStatus();
    bot.config.twitchStreamFetcher = async () => ({ ...LIVE_STREAM, id: "stream-fresh-after-deletion" });
    await bot.checkTwitchLiveStatus();
    check("a new session after the vanished-message session posts a brand new alert", channel._sent.length === 2);
  }

  bot.config.twitchImageRefreshIntervalMs = 5 * 60 * 1000;

  // ================= primeTwitchLiveState (startup, must never alert) =================

  const primeChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
  const primeOtherChannel = makeFakeChannel();
  bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? primeChannel : primeOtherChannel);

  bot.config.twitchLiveState = { wasLive: false, lastAlertedStreamId: null };
  bot.config.twitchStreamFetcher = async () => ({ ...LIVE_STREAM, id: "stream-already-running" });

  await bot.primeTwitchLiveState();
  check("priming at startup never posts an alert, even if already live", primeChannel._sent.length === 0);
  check("priming still records the in-progress stream so a later restart check won't re-fire for it", bot.config.twitchLiveState.wasLive === true && bot.config.twitchLiveState.lastAlertedStreamId === "stream-already-running");

  // After priming silently, the NEXT poll of the same ongoing stream still does not alert...
  bot.config.twitchStreamFetcher = async () => ({ ...LIVE_STREAM, id: "stream-already-running" });
  await bot.checkTwitchLiveStatus();
  check("the first real poll after a silent startup prime does not retroactively alert for the already-running stream", primeChannel._sent.length === 0);

  // ...but a genuinely new session after that one ends does alert.
  bot.config.twitchStreamFetcher = async () => OFFLINE_STATUS;
  await bot.checkTwitchLiveStatus();
  bot.config.twitchStreamFetcher = async () => ({ ...LIVE_STREAM, id: "stream-truly-new" });
  await bot.checkTwitchLiveStatus();
  check("a fresh stream after the primed one ends does trigger a real alert", primeChannel._sent.length === 1);

  // ================= primeTwitchLiveState: recovering an in-progress alert after a restart =================
  // Regression coverage for: a real report that after merging the "update the
  // alert" feature, a stream that had been live for ~3 hours never got its
  // post updated. Root cause: if the bot process restarts while a stream is
  // already live, the OLD code path recorded no message to edit at all, so
  // that session's alert was permanently stuck until it ended — exactly
  // matching the report. Fix: prime now searches the announcements channel
  // for the bot's own still-live alert post and resumes editing it.
  {
    const recoveryChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? recoveryChannel : makeFakeChannel());

    // Simulate the OLD process having posted the live alert before "restarting"
    // (via the real postTwitchLiveAlert, so its embed text matches exactly
    // what a genuine prior session would have produced).
    const preRestartStream = { ...LIVE_STREAM, id: "stream-pre-restart", title: "Streaming before the restart" };
    await bot.postTwitchLiveAlert(preRestartStream, undefined);
    check("sanity: the pre-restart alert is sitting in the channel", recoveryChannel._sent.length === 1);

    // The "new" process boots up with a blank in-memory state and primes.
    bot.config.twitchLiveState = { wasLive: false, lastAlertedStreamId: null };
    bot.config.twitchStreamFetcher = async () => preRestartStream;
    await bot.primeTwitchLiveState();

    check("priming after a restart still never posts a brand new alert", recoveryChannel._sent.length === 1);
    check("priming recovers the existing alert message instead of losing track of it", !!bot.config.twitchLiveState.lastAlertMessage);
    check("the recovered message is the one actually posted before the restart", bot.config.twitchLiveState.lastAlertMessage?.id === "fake-message-1" && recoveryChannel._edited.length === 0);

    // The very next regular poll (title unchanged, but lastTitle was deliberately
    // left blank) should refresh the recovered message rather than leave it stale.
    await bot.checkTwitchLiveStatus();
    check("the first poll after recovery refreshes the recovered message", recoveryChannel._edited.length === 1);
    check("the refresh keeps showing the pre-restart stream's real title", recoveryChannel._edited[0].payload.embeds[0].data.description.includes("Streaming before the restart"));

    // From here on, ordinary title changes keep editing that SAME recovered message.
    bot.config.twitchStreamFetcher = async () => ({ ...preRestartStream, title: "Still going strong hours later" });
    await bot.checkTwitchLiveStatus();
    check("further title changes keep editing the recovered message, not a new one", recoveryChannel._sent.length === 1 && recoveryChannel._edited.length === 2);
  }

  // If the pre-restart message can't be found (e.g. it scrolled past the
  // recent-message search window, or the channel can't be read), priming
  // degrades gracefully: no crash, no alert, just nothing to update until a
  // fresh session starts.
  {
    const unreadableChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    unreadableChannel.messages.fetch = async () => { throw new Error("Missing Access"); };
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? unreadableChannel : makeFakeChannel());

    bot.config.twitchLiveState = { wasLive: false, lastAlertedStreamId: null };
    bot.config.twitchStreamFetcher = async () => ({ ...LIVE_STREAM, id: "stream-unreadable-history" });

    await bot.primeTwitchLiveState();
    check("a channel that can't be searched for history doesn't crash priming", unreadableChannel._sent.length === 0);
    check("priming still records the live session even without a recovered message", bot.config.twitchLiveState.wasLive === true && !bot.config.twitchLiveState.lastAlertMessage);

    await bot.checkTwitchLiveStatus();
    check("with no message to edit, the poll just does nothing for that ongoing session", unreadableChannel._sent.length === 0 && unreadableChannel._edited.length === 0);
  }

  // ================= startTwitchLiveLoop: the first check runs immediately on startup =================
  // Regression coverage for: "i want it to post NOW" — previously the loop
  // only set up a setInterval, so the very first Twitch check (and thus the
  // very first alert, or the very first refresh of a recovered alert) didn't
  // happen until a full twitchPollIntervalMs (90s by default) after the bot
  // finished starting up.
  {
    const loopChannel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID);
    bot.client.channels.fetch = async (id) => (id === bot.WEEKLY_RECAP_CHANNEL_ID ? loopChannel : makeFakeChannel());

    bot.config.twitchLiveState = { wasLive: false, lastAlertedStreamId: null };
    bot.config.twitchStreamFetcher = async () => ({ ...LIVE_STREAM, id: "stream-loop-start" });

    bot.startTwitchLiveLoop();
    // The immediate check is fired off (not awaited) by startTwitchLiveLoop
    // itself; give its promise chain a tick to resolve before asserting,
    // well before the real poll interval would ever have elapsed.
    await new Promise((resolve) => setImmediate(resolve));
    check(
      "starting the poll loop posts the first alert right away, without waiting for the poll interval to elapse",
      loopChannel._sent.length === 1
    );

    bot.stopTwitchLiveLoop();
  }

  // ---- cleanup so this test doesn't leak state into other test files ----
  bot.config.twitchStreamFetcher = null;
  bot.config.twitchLiveState = { wasLive: false, lastAlertedStreamId: null };

  console.log(`\n[twitch-live-alert] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
