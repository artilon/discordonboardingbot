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

  const announcementsChannel = makeFakeChannel();
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

  // ================= primeTwitchLiveState (startup, must never alert) =================

  const primeChannel = makeFakeChannel();
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

  // ---- cleanup so this test doesn't leak state into other test files ----
  bot.config.twitchStreamFetcher = null;
  bot.config.twitchLiveState = { wasLive: false, lastAlertedStreamId: null };

  console.log(`\n[twitch-live-alert] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
