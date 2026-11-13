// Regression coverage for: adding RuneLite-style in-chat !pets / !kc <boss> /
// !lvl <skill> commands, restricted to OSRS_STATS_CHANNEL_ID, that delete the
// invoker's command message and post the looked-up stat publicly in its
// place — mirroring the in-game chat command experience.
//
// No real Discord connection, OSRS Hiscores, or RuneProfile API is used —
// config.hiscoreFetcher / config.runeProfileFetcher stand in for the real
// fetches, and the message/channel objects are lightweight fakes that record
// what got sent/deleted, mirroring the pattern used by the other message-
// handler tests in this repo (e.g. recruitment-drive-upload-flow.test.js).
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
    id: bot.OSRS_STATS_CHANNEL_ID,
    isTextBased: () => true,
    send: async (payload) => {
      const msg = { id: `msg-${sent.length}`, _deleted: false, delete: async () => { msg._deleted = true; } };
      sent.push({ payload, msg });
      return msg;
    },
    _sent: sent,
  };
}

function makeFakeMessage({ content, authorId = "member-1", dmFails = false }) {
  const channel = makeFakeChannel();
  const dmsSent = [];
  let deleted = false;
  return {
    content,
    channelId: bot.OSRS_STATS_CHANNEL_ID,
    guildId: "guild-1",
    channel,
    author: {
      id: authorId,
      bot: false,
      send: async (payload) => {
        if (dmFails) throw new Error("Cannot send messages to this user");
        dmsSent.push(payload);
        return { id: "dm-1" };
      },
    },
    delete: async () => { deleted = true; },
    get _deleted() { return deleted; },
    _dmsSent: dmsSent,
    _channel: channel,
  };
}

const SAMPLE_HISCORES = {
  skills: [
    { id: 0, name: "Overall", rank: 1000, level: 2000, xp: 500000000 },
    { id: 6, name: "Woodcutting", rank: 555, level: 92, xp: 7195629 },
    { id: 3, name: "Hitpoints", rank: 10, level: 99, xp: 13034431 },
  ],
  activities: [
    { id: 0, name: "League Points", rank: -1, score: -1 },
    { id: 50, name: "Zulrah", rank: 321, score: 1500 },
    { id: 60, name: "King Black Dragon", rank: 999, score: 42 },
  ],
};

(async () => {
  // ================= parseOsrsStatsCommand =================
  {
    check("!lvl with skill + single-word rsn parses", JSON.stringify(bot.parseOsrsStatsCommand("!lvl woodcutting Zezima")) ===
      JSON.stringify({ type: "lvl", alias: "woodcutting", rsn: "Zezima" }));
    check("!kc with boss + multi-word rsn parses, preserving spaces in the rsn", JSON.stringify(bot.parseOsrsStatsCommand("!kc zulrah Lynx Titan")) ===
      JSON.stringify({ type: "kc", alias: "zulrah", rsn: "Lynx Titan" }));
    check("!pets with multi-word rsn parses", JSON.stringify(bot.parseOsrsStatsCommand("!pets Lynx Titan")) ===
      JSON.stringify({ type: "pets", rsn: "Lynx Titan" }));
    check("plain chat mentioning 'kc' in passing is not treated as a command", bot.parseOsrsStatsCommand("gz on the kc") === null);
    check("!kc with no rsn argument is not treated as a command", bot.parseOsrsStatsCommand("!kc zulrah") === null);
    check("!pets with no rsn argument is not treated as a command", bot.parseOsrsStatsCommand("!pets") === null);
    check("unrelated ! command is ignored", bot.parseOsrsStatsCommand("!help") === null);
  }

  // ================= resolveSkillHiscoreName / resolveBossHiscoreName =================
  {
    check("skill alias 'wc' resolves to Woodcutting", bot.resolveSkillHiscoreName("wc") === "Woodcutting");
    check("exact skill name (any case) resolves", bot.resolveSkillHiscoreName("WOODCUTTING") === "Woodcutting");
    check("'total'/'overall' resolve to the Overall pseudo-skill", bot.resolveSkillHiscoreName("total") === "Overall" && bot.resolveSkillHiscoreName("overall") === "Overall");
    check("unknown skill resolves to null", bot.resolveSkillHiscoreName("bananas") === null);

    check("boss alias 'kbd' resolves to King Black Dragon", bot.resolveBossHiscoreName("kbd") === "King Black Dragon");
    check("boss name with spaces/punctuation stripped resolves", bot.resolveBossHiscoreName("zulrah") === "Zulrah");
    check("a boss outside the Boss-of-the-Week rotation (Cerberus) is still resolvable for !kc", bot.resolveBossHiscoreName("cerberus") === "Cerberus");
    check("alias for a boss outside the BOTW rotation ('hydra' -> Alchemical Hydra) resolves", bot.resolveBossHiscoreName("hydra") === "Alchemical Hydra");
    check("unknown boss resolves to null", bot.resolveBossHiscoreName("bananas") === null);
  }

  // ================= handleOsrsStatsCommand: !lvl =================
  {
    const prevFetcher = bot.config.hiscoreFetcher;
    bot.config.hiscoreFetcher = async () => SAMPLE_HISCORES;
    const message = makeFakeMessage({ content: "!lvl wc Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("!lvl is recognized as a handled command", handled === true);
    check("the command message is deleted", message._deleted === true);
    check("exactly one reply is posted to the channel", message._channel._sent.length === 1);
    const text = message._channel._sent[0].payload.embeds[0].data.description;
    check("the reply names the player", text.includes("Zezima"));
    check("the reply states the resolved skill's level", text.includes("92") && text.includes("Woodcutting"));
    check("the reply includes the XP figure", text.includes("7,195,629"));
    bot.config.hiscoreFetcher = prevFetcher;
  }

  // ================= handleOsrsStatsCommand: !kc (including a non-BOTW boss) =================
  {
    const prevFetcher = bot.config.hiscoreFetcher;
    bot.config.hiscoreFetcher = async () => SAMPLE_HISCORES;
    const message = makeFakeMessage({ content: "!kc kbd Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("!kc is recognized as a handled command", handled === true);
    check("the command message is deleted", message._deleted === true);
    const text = message._channel._sent[0].payload.embeds[0].data.description;
    check("the reply states the resolved boss's kill count", text.includes("42") && text.includes("King Black Dragon"));
    bot.config.hiscoreFetcher = prevFetcher;
  }

  // ================= handleOsrsStatsCommand: !kc for an unranked boss =================
  {
    const prevFetcher = bot.config.hiscoreFetcher;
    bot.config.hiscoreFetcher = async () => SAMPLE_HISCORES;
    const message = makeFakeMessage({ content: "!kc cerberus Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("an unranked boss is still a handled command (not an error)", handled === true);
    const text = message._channel._sent[0].payload.embeds[0].data.description;
    check("the reply reports no recorded kills rather than crashing", /hasn't recorded any kills/i.test(text));
    bot.config.hiscoreFetcher = prevFetcher;
  }

  // ================= handleOsrsStatsCommand: unknown skill/boss alias =================
  {
    const message = makeFakeMessage({ content: "!lvl bananas Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("an unrecognized skill alias is still a handled (and cleaned-up) command", handled === true);
    check("the command message is still deleted even on a bad alias", message._deleted === true);
    check("a transient notice (not a permanent channel post) is sent for the bad alias", message._channel._sent.length === 1);
    bot.config = bot.config; // no-op, keep lint happy about unused var patterns elsewhere
  }

  // ================= handleOsrsStatsCommand: rsn not found on the Hiscores =================
  {
    const prevFetcher = bot.config.hiscoreFetcher;
    bot.config.hiscoreFetcher = async () => null; // 404 / not found
    const message = makeFakeMessage({ content: "!lvl wc NobodyPlaysThis123" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("a Hiscores lookup miss is still a handled command", handled === true);
    check("the command message is deleted even when the rsn isn't found", message._deleted === true);
    const text = message._channel._sent[0].payload.content;
    check("the notice explains the rsn wasn't found", /couldn't find/i.test(text));
    bot.config.hiscoreFetcher = prevFetcher;
  }

  // ================= handleOsrsStatsCommand: !pets with pets owned =================
  {
    const prevFetcher = bot.config.runeProfileFetcher;
    bot.config.runeProfileFetcher = async () => ({ ok: true, notFound: false, pets: ["Baby Mole", "Pet Zilyana"] });
    const message = makeFakeMessage({ content: "!pets Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("!pets is recognized as a handled command", handled === true);
    check("the command message is deleted", message._deleted === true);
    const text = message._channel._sent[0].payload.embeds[0].data.description;
    check("the reply lists the pet count and names", text.includes("2") && text.includes("Baby Mole") && text.includes("Pet Zilyana"));
    bot.config.runeProfileFetcher = prevFetcher;
  }

  // ================= handleOsrsStatsCommand: !pets with zero pets owned =================
  {
    const prevFetcher = bot.config.runeProfileFetcher;
    bot.config.runeProfileFetcher = async () => ({ ok: true, notFound: false, pets: [] });
    const message = makeFakeMessage({ content: "!pets Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("a RuneProfile account with zero pets is still a handled command", handled === true);
    const text = message._channel._sent[0].payload.embeds[0].data.description;
    check("the reply states the player has no pets logged", /doesn't have any pets logged/i.test(text));
    bot.config.runeProfileFetcher = prevFetcher;
  }

  // ================= handleOsrsStatsCommand: !pets, no RuneProfile account (the anti-spam case) =================
  {
    const prevFetcher = bot.config.runeProfileFetcher;
    bot.config.runeProfileFetcher = async () => ({ ok: false, notFound: true });
    const message = makeFakeMessage({ content: "!pets NobodyHasThis123" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("a missing RuneProfile account is still a handled command", handled === true);
    check("the command message is deleted", message._deleted === true);
    check("NOTHING is posted publicly to the channel for a missing RuneProfile account", message._channel._sent.length === 0);
    check("instead, the setup instructions are DMed to the invoker", message._dmsSent.length === 1);
    const dmEmbed = message._dmsSent[0].embeds[0].data;
    check("the DM explains RuneProfile needs to be set up", /RuneProfile/i.test(dmEmbed.title));
    check("the DM includes a link to runeprofile.com", dmEmbed.description.includes("https://runeprofile.com"));
    bot.config.runeProfileFetcher = prevFetcher;
  }

  // ================= handleOsrsStatsCommand: !pets, no RuneProfile account, DMs closed =================
  {
    const prevFetcher = bot.config.runeProfileFetcher;
    bot.config.runeProfileFetcher = async () => ({ ok: false, notFound: true });
    const message = makeFakeMessage({ content: "!pets NobodyHasThis123", dmFails: true });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("still handled even when the invoker's DMs are closed", handled === true);
    check("falls back to a (self-deleting) channel message instead of silently doing nothing", message._channel._sent.length === 1);
    bot.config.runeProfileFetcher = prevFetcher;
  }

  // ================= fetchRuneProfilePets: real response-shape parsing (regression) =================
  // Reproduces a bug found live: a player with real RuneProfile pet data
  // ("Iron EZ Pets") got "doesn't have any pets logged" because the code
  // looked for a collection-log page literally named "Pets" — but
  // RuneProfile (mirroring the real in-game collection log) has no such
  // page. Every pet is aggregated onto ONE page named "All Pets" (confirmed
  // against a live account's actual API response), nested under the
  // "Other" tab, while each pet ALSO separately appears on its own boss's
  // page (e.g. "Pet chaos elemental" shows up on both "Chaos Elemental" and
  // "All Pets"). This exercises fetchRuneProfilePets' real parsing logic
  // directly (not the config.runeProfileFetcher override used elsewhere in
  // this file) by stubbing the global fetch(), matching the exact response
  // shape RuneProfile's /collection-log endpoint actually returns.
  {
    const realisticCollectionLog = {
      obtained: 791,
      total: 1734,
      tabs: [
        {
          name: "Bosses",
          obtained: 204,
          total: 381,
          pages: [
            {
              name: "Chaos Elemental",
              obtained: 3,
              total: 3,
              items: [
                { id: 11995, name: "Pet chaos elemental", quantity: 1 }, // also appears on "All Pets" below — must not be double counted
                { id: 11920, name: "Dragon pickaxe", quantity: 3 },
              ],
            },
            {
              name: "Commander Zilyana",
              obtained: 2,
              total: 8,
              items: [{ id: 12651, name: "Pet Zilyana", quantity: 0 }], // not obtained here; IS obtained on "All Pets" below
            },
          ],
        },
        {
          name: "Other",
          obtained: 309,
          total: 544,
          pages: [
            {
              name: "All Pets",
              obtained: 3,
              total: 72,
              items: [
                { id: 11995, name: "Pet chaos elemental", quantity: 1 },
                { id: 12651, name: "Pet Zilyana", quantity: 1 },
                { id: 13247, name: "Hellpuppy", quantity: 0 },
                { id: 12644, name: "Pet Dagannoth Prime", quantity: 0 },
                { id: 13225, name: "TzRek-Jad", quantity: 1 },
              ],
            },
          ],
        },
      ],
    };

    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      check("fetchRuneProfilePets calls the RuneProfile v1 collection-log endpoint", String(url).startsWith("https://api.runeprofile.com/v1/accounts/"));
      check("the rsn is present (URL-encoded) in the request path", String(url).includes(encodeURIComponent("Iron EZ Pets")));
      return { ok: true, status: 200, json: async () => realisticCollectionLog };
    };

    const result = await bot.fetchRuneProfilePets("Iron EZ Pets");
    global.fetch = originalFetch;

    check("a real populated account resolves ok", result.ok === true && result.notFound === false);
    check("exactly the 3 actually-owned pets are returned (from the \"All Pets\" page, not the per-boss pages)", result.pets.length === 3);
    check("owned pets are named correctly", result.pets.includes("Pet chaos elemental") && result.pets.includes("Pet Zilyana") && result.pets.includes("TzRek-Jad"));
    check("unowned pets (quantity 0) are excluded", !result.pets.includes("Hellpuppy") && !result.pets.includes("Pet Dagannoth Prime"));
  }

  // ================= fetchRuneProfilePets: account exists but has 404'd / malformed collection-log =================
  {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ obtained: 0, total: 0, tabs: [] }) });
    const result = await bot.fetchRuneProfilePets("SomeAccount");
    global.fetch = originalFetch;
    check("an account with no tabs at all still resolves ok with an empty pet list (not a crash)", result.ok === true && Array.isArray(result.pets) && result.pets.length === 0);
  }

  // ================= fetchRuneProfilePets: a genuine 404 is reported as notFound, not a generic error =================
  {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 404 });
    const result = await bot.fetchRuneProfilePets("NobodyHasThis123");
    global.fetch = originalFetch;
    check("a 404 from RuneProfile is reported as notFound", result.ok === false && result.notFound === true);
  }

  // ================= messages outside OSRS_STATS_CHANNEL_ID are left completely alone =================
  {
    const message = makeFakeMessage({ content: "!pets Zezima" });
    message.channelId = "some-other-channel-id";
    message.channel.id = "some-other-channel-id";
    await bot.handleMessageCreate(message);
    check("a !pets command typed outside the OSRS stats channel is never deleted or answered", message._deleted === false && message._channel._sent.length === 0);
  }

  // ================= a non-command message in the OSRS stats channel is left alone =================
  {
    const message = makeFakeMessage({ content: "gl on the raid tonight" });
    await bot.handleMessageCreate(message);
    check("ordinary chat in the OSRS stats channel is not deleted or replied to", message._deleted === false && message._channel._sent.length === 0);
  }

  console.log(`\n[osrs-stat-commands] ${passed} checks passed.`);
})().catch((e) => {
  console.error("[osrs-stat-commands] FAILED:", e.message);
  process.exit(1);
});
