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
const { ComponentType } = require("discord.js");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// ================= Components V2 result test helpers =================
// sendItemListMessage (!pets / !log <category>) posts Components V2
// messages: a Container holding an optional single-item Media Gallery (the
// one overall banner picture, !log <category> only -- !pets has none), an
// overall header Text Display (first batch only), and an item-list Text
// Display whose content is one line per item (name/quantity/price/
// drop-rate label), newline-separated -- NOT a picture per item, which was
// reported live as turning into a huge scrolling mess once an account had a
// lot of items. These helpers pull the plain-JSON shape back out of a
// captured `_sent` entry for assertions.
function resultContainerJSON(sentEntry) {
  return sentEntry.payload.components[0].toJSON();
}
/** The single overall banner picture's URL, or null if this message has none. */
function resultBannerUrl(sentEntry) {
  const gallery = resultContainerJSON(sentEntry).components.find((c) => c.type === ComponentType.MediaGallery);
  return gallery ? gallery.items[0]?.media?.url || null : null;
}
function resultTextDisplays(sentEntry) {
  return resultContainerJSON(sentEntry).components.filter((c) => c.type === ComponentType.TextDisplay);
}
/** The overall header line -- only present on a batch that has one (always the first Text Display when it does). */
function resultHeaderText(sentEntry) {
  const texts = resultTextDisplays(sentEntry);
  return texts.length > 0 ? texts[0].content : null;
}
/**
 * Every item line in a batch's item-list Text Display, split into an array
 * -- an empty array if this batch has no items at all (a header-only
 * message). `hasHeader` (default true) controls whether the first Text
 * Display found is the header (so the item list is the second one, if any)
 * or whether this batch has no header of its own (a continuation-only
 * batch past the first message of a multi-message send).
 */
function resultItemLines(sentEntry, { hasHeader = true } = {}) {
  const texts = resultTextDisplays(sentEntry);
  const itemsText = hasHeader ? texts[1] : texts[0];
  return itemsText ? itemsText.content.split("\n") : [];
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

// A real (trimmed) capture of a live account's Hiscores response, used to
// reproduce a reported bug: "!kc hueycoatl" resolved the boss fine but then
// claimed "hasn't recorded any kills" for a player who actually has 1,367.
// Also exercises the real Hiscores' "The X" naming inconsistency (compare
// "The Hueycoatl" and "The Royal Titans" against "Barrows Chests", which is
// a genuinely different kind of name mismatch, not a "The " prefix one) and
// confirms genuinely-separate co-located bosses (Callisto vs Artio,
// Nightmare vs Phosani's Nightmare) are never conflated with each other.
const REAL_WORLD_HISCORES = {
  skills: [{ id: 0, name: "Overall", rank: 146470, level: 2275, xp: 409184231 }],
  activities: [
    { id: 24, name: "Artio", rank: -1, score: 1 },
    { id: 28, name: "Callisto", rank: -1, score: 0 },
    { id: 25, name: "Barrows Chests", rank: 46564, score: 833 },
    { id: 58, name: "Nightmare", rank: -1, score: 2 },
    { id: 59, name: "Phosani's Nightmare", rank: -1, score: 0 },
    { id: 72, name: "The Hueycoatl", rank: 1226, score: 1367 },
    { id: 74, name: "The Royal Titans", rank: 8390, score: 802 },
  ],
};

(async () => {
  // Default stub so ordinary tests (that don't care about wiki images) never
  // make a real network call to the OSRS Wiki — mirrors config.hiscoreFetcher
  // / config.runeProfileFetcher being stubbed everywhere else in this file.
  // Tests that specifically exercise image behavior override this locally
  // AND clear the (permanent, process-lifetime) image cache first, since
  // otherwise an earlier test's cached "no image found" result for the same
  // title would shadow a later test's differently-stubbed fetcher.
  bot.config.wikiImageFetcher = async () => new Map();
  // Same idea for the GE price + wiki drop-rate lookups: no price, no rate,
  // by default. Tests that specifically exercise that behavior override
  // these locally AND reset the (permanent, process-lifetime) caches first.
  bot.config.geMappingFetcher = async () => [];
  bot.config.geLatestPriceFetcher = async () => ({});
  bot.config.dropRateFetcher = async () => null;

  // ================= parseOsrsStatsCommand =================
  {
    check("!lvl with skill + single-word rsn parses", JSON.stringify(bot.parseOsrsStatsCommand("!lvl woodcutting Zezima")) ===
      JSON.stringify({ type: "lvl", alias: "woodcutting", rsn: "Zezima" }));
    check("!kc with boss + multi-word rsn parses, preserving spaces in the rsn", JSON.stringify(bot.parseOsrsStatsCommand("!kc zulrah Lynx Titan")) ===
      JSON.stringify({ type: "kc", alias: "zulrah", rsn: "Lynx Titan" }));
    check("!pets with multi-word rsn parses", JSON.stringify(bot.parseOsrsStatsCommand("!pets Lynx Titan")) ===
      JSON.stringify({ type: "pets", rsn: "Lynx Titan" }));
    check("!log with category + multi-word rsn parses", JSON.stringify(bot.parseOsrsStatsCommand("!log toa Lynx Titan")) ===
      JSON.stringify({ type: "log", alias: "toa", rsn: "Lynx Titan" }));
    check("plain chat mentioning 'kc' in passing is not treated as a command", bot.parseOsrsStatsCommand("gz on the kc") === null);
    check("!kc with no rsn argument is not treated as a command", bot.parseOsrsStatsCommand("!kc zulrah") === null);
    check("!pets with no rsn argument is not treated as a command", bot.parseOsrsStatsCommand("!pets") === null);
    check("!log with no rsn argument is not treated as a command", bot.parseOsrsStatsCommand("!log toa") === null);
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

  // ================= unambiguous prefix / shortened-typing fallback =================
  // Players shouldn't have to know the bot's exact curated alias spelling --
  // a shortened or slightly-truncated form of a real name or alias should
  // still resolve, as long as it's unambiguous. An ambiguous shortening
  // (one that could mean more than one different boss) must still refuse
  // rather than silently guessing the wrong one.
  {
    check("a truncated boss name ('zily' -> Commander Zilyana) resolves", bot.resolveBossHiscoreName("zily") === "Commander Zilyana");
    check("a truncated boss name missing its last letter ('zilyan') resolves", bot.resolveBossHiscoreName("zilyan") === "Commander Zilyana");
    check("a truncated alias ('cerbe' for the 'cerb' alias) resolves", bot.resolveBossHiscoreName("cerbe") === "Cerberus");
    check("a truncated alias ('vor' for the 'vork' alias) resolves to Vorkath", bot.resolveBossHiscoreName("vor") === "Vorkath");
    check("a truncated real name ('grot' for Grotesque Guardians) resolves", bot.resolveBossHiscoreName("grot") === "Grotesque Guardians");
    check("a truncated real name ('zulr' for Zulrah) resolves", bot.resolveBossHiscoreName("zulr") === "Zulrah");
    check("an ambiguous shortening ('dag', which could mean Prime/Rex/Supreme) safely refuses rather than guessing", bot.resolveBossHiscoreName("dag") === null);
    check("a too-short fragment (below the 3-character floor) is rejected rather than guessed", bot.resolveBossHiscoreName("zu") === null);

    check("a truncated skill name ('wood' -> Woodcutting) resolves", bot.resolveSkillHiscoreName("wood") === "Woodcutting");
    check("a truncated skill alias ('fir' for the implicit Firemaking name) resolves", bot.resolveSkillHiscoreName("fir") === "Firemaking");
    check("a too-short skill fragment is rejected rather than guessed", bot.resolveSkillHiscoreName("ru") === null);
  }

  // ================= handleOsrsStatsCommand: a truncated boss name works end-to-end =================
  {
    const prevFetcher = bot.config.hiscoreFetcher;
    bot.config.hiscoreFetcher = async () => SAMPLE_HISCORES;
    const message = makeFakeMessage({ content: "!kc zulr Zezima" }); // shortened, not the full "zulrah"
    const handled = await bot.handleOsrsStatsCommand(message);
    check("a shortened boss name is handled end-to-end", handled === true);
    const text = message._channel._sent[0].payload.embeds[0].data.description;
    check("it resolves and reports the right boss's kc", text.includes("1,500") && text.includes("Zulrah"));
    bot.config.hiscoreFetcher = prevFetcher;
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

  // ================= handleOsrsStatsCommand: !lvl / !kc include the OSRS Wiki image when found =================
  {
    const prevFetcher = bot.config.hiscoreFetcher;
    const prevWikiFetcher = bot.config.wikiImageFetcher;
    bot.config.hiscoreFetcher = async () => SAMPLE_HISCORES;
    bot._wikiPageImageCacheForTests.clear();

    bot.config.wikiImageFetcher = async (titles) => {
      check("!lvl queries the skill's cape title on the wiki", titles.includes("Woodcutting cape"));
      return new Map([["Woodcutting cape", "https://wiki.example/wc-cape.png"]]);
    };
    const lvlMessage = makeFakeMessage({ content: "!lvl wc Zezima" });
    await bot.handleOsrsStatsCommand(lvlMessage);
    check("!lvl's embed gets a thumbnail from the wiki", lvlMessage._channel._sent[0].payload.embeds[0].data.thumbnail?.url === "https://wiki.example/wc-cape.png");

    bot.config.wikiImageFetcher = async (titles) => {
      check("!kc queries the boss's own title on the wiki", titles.includes("King Black Dragon"));
      return new Map([["King Black Dragon", "https://wiki.example/kbd.png"]]);
    };
    const kcMessage = makeFakeMessage({ content: "!kc kbd Zezima" });
    await bot.handleOsrsStatsCommand(kcMessage);
    check("!kc's embed gets a thumbnail from the wiki", kcMessage._channel._sent[0].payload.embeds[0].data.thumbnail?.url === "https://wiki.example/kbd.png");

    bot.config.wikiImageFetcher = async () => new Map(); // simulate the wiki having no image for this one (a different boss, so it doesn't hit the cached King Black Dragon result above)
    const noImgMessage = makeFakeMessage({ content: "!kc cerberus Zezima" });
    await bot.handleOsrsStatsCommand(noImgMessage);
    check("no wiki image found gracefully omits the thumbnail instead of breaking the reply", noImgMessage._channel._sent[0].payload.embeds[0].data.thumbnail === undefined);

    bot.config.hiscoreFetcher = prevFetcher;
    bot.config.wikiImageFetcher = prevWikiFetcher;
  }

  // ================= wikiTitleForBoss / wikiTitleForSkill =================
  {
    check("a boss whose Hiscores name differs from its wiki title resolves via the override table ('Barrows Chests' -> 'Barrows')", bot.wikiTitleForBoss("Barrows Chests") === "Barrows");
    check("'Lunar Chests' overrides to the wiki's actual article title 'Moons of Peril'", bot.wikiTitleForBoss("Lunar Chests") === "Moons of Peril");
    check("bare 'Nightmare' overrides to the wiki's 'The Nightmare' article", bot.wikiTitleForBoss("Nightmare") === "The Nightmare");
    check("a raid's '...: Challenge Mode' suffix is stripped before looking up its (shared) artwork", bot.wikiTitleForBoss("Chambers of Xeric: Challenge Mode") === "Chambers of Xeric");
    check("a boss with no naming quirks is passed through as-is", bot.wikiTitleForBoss("Zulrah") === "Zulrah");

    check("a skill resolves to its skill cape's wiki title", bot.wikiTitleForSkill("Woodcutting") === "Woodcutting cape");
    check("the Overall pseudo-skill resolves to the Max cape (no 'Overall cape' exists)", bot.wikiTitleForSkill("Overall") === "Max cape");
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

  // ================= handleOsrsStatsCommand: !kc regression -- "The X" vs "X" naming mismatches =================
  // Reproduces a live bug report: "!kc hueycoatl torlokt" replied "hasn't
  // recorded any kills ... (unranked)" for a player who actually has 1,367
  // KC, because the resolved display name ("Hueycoatl") didn't textually
  // match the real Hiscores entry name ("The Hueycoatl").
  {
    const prevFetcher = bot.config.hiscoreFetcher;
    bot.config.hiscoreFetcher = async () => REAL_WORLD_HISCORES;

    const cases = [
      { cmd: "!kc hueycoatl torlokt", expectKc: "1,367", expectRank: "1,226" },
      { cmd: "!kc huey torlokt", expectKc: "1,367", expectRank: "1,226" }, // via the short alias too
      { cmd: "!kc barrows torlokt", expectKc: "833", expectRank: "46,564" }, // different mismatch kind (not a "The " prefix)
      { cmd: "!kc titans torlokt", expectKc: "802", expectRank: "8,390" },
    ];
    for (const { cmd, expectKc, expectRank } of cases) {
      const message = makeFakeMessage({ content: cmd });
      const handled = await bot.handleOsrsStatsCommand(message);
      check(`"${cmd}" is handled`, handled === true);
      const text = message._channel._sent[0]?.payload?.embeds?.[0]?.data?.description || "";
      check(`"${cmd}" reports the real KC (${expectKc}), not "hasn't recorded any kills"`, text.includes(expectKc) && !/hasn't recorded/i.test(text));
      check(`"${cmd}" also reports the real rank (#${expectRank})`, text.includes(expectRank));
    }

    // Genuinely distinct, merely co-located bosses must never be conflated
    // with each other even though they share a boss family / loot table.
    const callisto = makeFakeMessage({ content: "!kc callisto torlokt" });
    await bot.handleOsrsStatsCommand(callisto);
    const callistoText = callisto._channel._sent[0].payload.embeds[0].data.description;
    check("Callisto (0 kc) is not conflated with Artio's kc", /hasn't recorded any kills/i.test(callistoText) && callistoText.includes("Callisto"));

    const artio = makeFakeMessage({ content: "!kc artio torlokt" });
    await bot.handleOsrsStatsCommand(artio);
    const artioText = artio._channel._sent[0].payload.embeds[0].data.description;
    check("Artio (1 kc) is not conflated with Callisto's kc", /\*\*1\*\*/.test(artioText) && artioText.includes("Artio"));

    const phosani = makeFakeMessage({ content: "!kc phosani torlokt" });
    await bot.handleOsrsStatsCommand(phosani);
    const phosaniText = phosani._channel._sent[0].payload.embeds[0].data.description;
    check("Phosani's Nightmare (0 kc) is not conflated with regular Nightmare's kc", /hasn't recorded any kills/i.test(phosaniText));

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
    bot.config.runeProfileFetcher = async () => ({ ok: true, notFound: false, pets: [{ name: "Baby Mole", quantity: 1 }, { name: "Pet Zilyana", quantity: 3 }] });
    const message = makeFakeMessage({ content: "!pets Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("!pets is recognized as a handled command", handled === true);
    check("the command message is deleted", message._deleted === true);
    check("everything still fits in a single message", message._channel._sent.length === 1);
    const headerText = resultHeaderText(message._channel._sent[0]);
    check("the header states the pet count", headerText.includes("2"));
    check("!pets never shows a banner picture -- no single image represents a mixed pet list", resultBannerUrl(message._channel._sent[0]) === null);
    const lines = resultItemLines(message._channel._sent[0]);
    check("each pet gets its own compact text line rather than its own image/row", lines.length === 2);
    check("a pet obtained once is named on its own line, without a dupe badge", lines.includes("**Baby Mole**"));
    check("a pet obtained more than once shows an 'xN' dupe count on its own line", lines.includes("**Pet Zilyana** x3"));
    check("!pets' header keeps the normal (non-red) color -- only !log's header is colored red", resultContainerJSON(message._channel._sent[0]).accent_color === bot.COLOR.main);
    bot.config.runeProfileFetcher = prevFetcher;
  }

  // ================= handleOsrsStatsCommand: !pets with a lot of pets stays compact, with no per-pet image =================
  // Reported live as "a huge scrolling mess" when !pets showed one image per
  // pet: an account with ~20 pets produced an excessively long post. !pets
  // now shows no image at all (no single picture represents a mixed pet
  // list) and packs every pet into plain text lines instead.
  {
    const prevFetcher = bot.config.runeProfileFetcher;
    const prevWikiPageFetcher = bot.config.wikiImageFetcher;
    const pets = Array.from({ length: 20 }, (_, i) => ({ name: `Pet ${i}`, quantity: 1 }));
    bot.config.runeProfileFetcher = async () => ({ ok: true, notFound: false, pets });
    bot.config.wikiImageFetcher = async () => { throw new Error("!pets must never look up any image at all"); };
    const message = makeFakeMessage({ content: "!pets Zezima" });
    await bot.handleOsrsStatsCommand(message);
    check("20 pets as plain text lines comfortably fit in a single message, with no scrolling mess of per-item images", message._channel._sent.length === 1);
    check("still no banner picture even with a large pet list", resultBannerUrl(message._channel._sent[0]) === null);
    const lines = resultItemLines(message._channel._sent[0]);
    check("all 20 pets are listed", lines.length === 20);
    bot.config.runeProfileFetcher = prevFetcher;
    bot.config.wikiImageFetcher = prevWikiPageFetcher;
  }

  // ================= formatGpAmount: formats GP the way OSRS players actually write it =================
  {
    check("sub-1000 stays a plain number", bot.formatGpAmount(999) === "999");
    check("thousands get a 'k' suffix", bot.formatGpAmount(1500) === "1.5k");
    check("a round thousand doesn't show a pointless '.0'", bot.formatGpAmount(2000) === "2k");
    check("millions get an 'm' suffix", bot.formatGpAmount(4_300_000) === "4.3m");
    check("billions get a 'b' suffix", bot.formatGpAmount(2_100_000_000) === "2.1b");
    check("a non-numeric/missing amount resolves to null rather than 'NaN'", bot.formatGpAmount(undefined) === null && bot.formatGpAmount(null) === null);
  }

  // ================= fetchGePrices: resolves a GE value via the cached mapping + latest-price datasets =================
  {
    bot._resetGePriceCachesForTests();
    const prevMappingFetcher = bot.config.geMappingFetcher;
    const prevLatestFetcher = bot.config.geLatestPriceFetcher;
    let mappingCalls = 0;
    let latestCalls = 0;
    bot.config.geMappingFetcher = async () => {
      mappingCalls++;
      return [
        { id: 11832, name: "Bandos chestplate" },
        { id: 4151, name: "Abyssal whip" },
      ];
    };
    bot.config.geLatestPriceFetcher = async () => {
      latestCalls++;
      // The real /latest endpoint wraps its results in a top-level "data"
      // key -- {"data": {"4151": {...}}} -- confirmed against a live
      // request. This test hook must mirror that exact shape since it's a
      // drop-in replacement for the real fetch.
      return {
        data: {
          "11832": { high: 22000000, low: 21500000 },
          "4151": { high: null, low: 1200000 }, // only ever seen an instant-sell
        },
      };
    };
    const prices = await bot.fetchGePrices(["Bandos chestplate", "Abyssal whip", "Some Untradeable Thing"]);
    check("a tradeable item's price resolves (preferring the instant-buy 'high' price)", prices.get("Bandos chestplate") === 22000000);
    check("an item with only an instant-sell price on record falls back to 'low'", prices.get("Abyssal whip") === 1200000);
    check("an item absent from the mapping entirely (never tradeable) is simply not in the result", !prices.has("Some Untradeable Thing"));

    // A second lookup within the cache TTL must reuse the cached datasets,
    // not re-fetch the (large) mapping/latest-price datasets per command.
    await bot.fetchGePrices(["Bandos chestplate"]);
    check("the mapping dataset is only fetched once while cached", mappingCalls === 1);
    check("the latest-price dataset is only fetched once while cached", latestCalls === 1);

    bot.config.geMappingFetcher = prevMappingFetcher;
    bot.config.geLatestPriceFetcher = prevLatestFetcher;
    bot._resetGePriceCachesForTests();
  }

  // ================= fetchGePrices: the real /latest response is wrapped in a top-level "data" key -- confirmed against a live request -- and must be unwrapped correctly =================
  {
    bot._resetGePriceCachesForTests();
    const prevMappingFetcher = bot.config.geMappingFetcher;
    const prevLatestFetcher = bot.config.geLatestPriceFetcher;
    bot.config.geMappingFetcher = async () => [{ id: 4151, name: "Abyssal whip" }];

    // The real shape: {"data": {"4151": {...}}}. An earlier version of this
    // code assumed a bare itemId-keyed object instead, which made every
    // single item resolve to "no price" in production (there's no "data"
    // key in the GE mapping, so nothing ever matched).
    bot.config.geLatestPriceFetcher = async () => ({ data: { "4151": { high: 686034, low: 668662 } } });
    const wrapped = await bot.fetchGePrices(["Abyssal whip"]);
    check("the real, data-wrapped /latest shape resolves a price", wrapped.get("Abyssal whip") === 686034);
    bot._resetGePriceCachesForTests();

    // A bare itemId-keyed object (no "data" wrapper) is also accepted, as a
    // defensive fallback in case that ever changes back -- it should not be
    // required to match the live shape exactly to keep working.
    bot.config.geLatestPriceFetcher = async () => ({ "4151": { high: 686034, low: 668662 } });
    const bare = await bot.fetchGePrices(["Abyssal whip"]);
    check("a bare (non-data-wrapped) /latest response is also tolerated", bare.get("Abyssal whip") === 686034);

    bot.config.geMappingFetcher = prevMappingFetcher;
    bot.config.geLatestPriceFetcher = prevLatestFetcher;
    bot._resetGePriceCachesForTests();
  }

  // ================= fetchGePrices: a failed mapping/latest-price fetch degrades to "no prices" rather than crashing =================
  {
    bot._resetGePriceCachesForTests();
    const prevMappingFetcher = bot.config.geMappingFetcher;
    bot.config.geMappingFetcher = async () => { throw new Error("simulated GE API outage"); };
    const prices = await bot.fetchGePrices(["Bandos chestplate"]);
    check("a failed GE price lookup resolves to an empty Map instead of throwing", prices.size === 0);
    bot.config.geMappingFetcher = prevMappingFetcher;
    bot._resetGePriceCachesForTests();
  }

  // ================= fetchWikiDropRates: resolves each item's rarity, optionally scoped to a specific source page =================
  {
    bot._wikiDropRateCacheForTests.clear();
    const prevDropRateFetcher = bot.config.dropRateFetcher;
    bot.config.dropRateFetcher = async (itemName, pageNameHint) => {
      if (itemName === "Tanzanite fang" && pageNameHint === "Zulrah") return "1/512";
      if (itemName === "Magic fang") return null; // never obtained / no drop-table entry on file
      return null;
    };
    const rates = await bot.fetchWikiDropRates(["Tanzanite fang", "Magic fang"], "Zulrah");
    check("an item with a known rate (scoped to the right source page) resolves", rates.get("Tanzanite fang") === "1/512");
    check("an item with no drop-table entry at all is simply absent, not a crash", !rates.has("Magic fang"));
    bot.config.dropRateFetcher = prevDropRateFetcher;
  }

  // ================= fetchWikiDropRate: caches a hit indefinitely but retries a miss later =================
  {
    bot._wikiDropRateCacheForTests.clear();
    const prevDropRateFetcher = bot.config.dropRateFetcher;
    let calls = 0;
    bot.config.dropRateFetcher = async () => { calls++; return "1/5000"; };
    await bot.fetchWikiDropRate("Baby Mole", "Giant Mole");
    await bot.fetchWikiDropRate("Baby Mole", "Giant Mole");
    check("a resolved drop rate is cached -- the fetcher isn't called again for the same item+source", calls === 1);
    bot.config.dropRateFetcher = prevDropRateFetcher;
  }

  // ================= fetchWikiDropRateLive: queries the real `dropsline` Bucket schema correctly =================
  // Regression coverage for a real production bug: an earlier version of
  // this function queried/selected a `page_name` column that does not exist
  // on the `dropsline` bucket (confirmed directly against the OSRS Wiki's
  // own Module:DropsLine / Module:Get_drop_info Lua source -- the bucket's
  // only columns are `item_name`, `rare_drop_table`, and `drop_json`, with
  // the source page living INSIDE `drop_json` as "Dropped from"). Querying a
  // nonexistent column made the Bucket API reject every request, so NO item
  // ever showed a drop rate in production, for either !log or !pets.
  {
    bot._wikiDropRateCacheForTests.clear();
    const prevDropRateFetcher = bot.config.dropRateFetcher;
    delete bot.config.dropRateFetcher;
    const originalFetch = global.fetch;

    let capturedUrl = null;
    global.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          bucket: [
            { rare_drop_table: [false], drop_json: [JSON.stringify({ Rarity: "1/512", "Dropped from": "Zulrah" })] },
            { rare_drop_table: [true], drop_json: [JSON.stringify({ Rarity: "1/5000", "Dropped from": "Rare drop table" })] },
          ],
        }),
      };
    };
    const scoped = await bot.fetchWikiDropRate("Tanzanite fang", "Zulrah");
    global.fetch = originalFetch;

    check("the query never references the nonexistent 'page_name' bucket column", !String(capturedUrl).includes("page_name"));
    check("the query selects the bucket's real columns (item_name is filtered via .where, not .select, so just rare_drop_table/drop_json here)", String(capturedUrl).includes("rare_drop_table") && String(capturedUrl).includes("drop_json"));
    check("a row whose decoded 'Dropped from' matches the requested source page is preferred", scoped === "1/512");
    bot.config.dropRateFetcher = prevDropRateFetcher;
    bot._wikiDropRateCacheForTests.clear();
  }

  // ================= fetchWikiDropRateLive: falls back to a non-rare-drop-table entry when no source-page match is found =================
  {
    bot._wikiDropRateCacheForTests.clear();
    const prevDropRateFetcher = bot.config.dropRateFetcher;
    delete bot.config.dropRateFetcher;
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        bucket: [
          { rare_drop_table: [true], drop_json: [JSON.stringify({ Rarity: "1/5000", "Dropped from": "Rare drop table" })] },
          { rare_drop_table: [false], drop_json: [JSON.stringify({ Rarity: "1/128", "Dropped from": "Some Other Boss" })] },
        ],
      }),
    });
    const noScopeMatch = await bot.fetchWikiDropRate("Clue scroll (elite)", "A Source That Doesn't Appear In Any Row");
    global.fetch = originalFetch;
    check("when no row matches the requested source, the first non-rare-drop-table row is preferred over the RDT catch-all", noScopeMatch === "1/128");
    bot.config.dropRateFetcher = prevDropRateFetcher;
    bot._wikiDropRateCacheForTests.clear();
  }

  // ================= fetchWikiDropRateLive: a versioned source ("Zulrah#Core") still matches a plain pageNameHint of "Zulrah" =================
  {
    bot._wikiDropRateCacheForTests.clear();
    const prevDropRateFetcher = bot.config.dropRateFetcher;
    delete bot.config.dropRateFetcher;
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        bucket: [{ rare_drop_table: [false], drop_json: [JSON.stringify({ Rarity: "1/512", "Dropped from": "Zulrah#Core" })] }],
      }),
    });
    const result = await bot.fetchWikiDropRate("Tanzanite fang", "Zulrah");
    global.fetch = originalFetch;
    check("a '#Variant' suffix on the stored source is ignored when matching against pageNameHint", result === "1/512");
    bot.config.dropRateFetcher = prevDropRateFetcher;
    bot._wikiDropRateCacheForTests.clear();
  }

  // ================= buildItemExtraLabel: combines price + rate into one trailing label =================
  {
    check("both present: price first, then rate in parens", bot.buildItemExtraLabel("4.3m", "1/512") === "— 4.3m (1/512)");
    check("price only", bot.buildItemExtraLabel("4.3m", null) === "— 4.3m");
    check("rate only", bot.buildItemExtraLabel(null, "1/512") === "(1/512)");
    check("neither present is an empty string", bot.buildItemExtraLabel(null, null) === "");
  }

  // ================= enrichItemsWithExtras: wires price + drop rate into the gallery's item labels =================
  {
    bot._resetGePriceCachesForTests();
    bot._wikiDropRateCacheForTests.clear();
    const prevMappingFetcher = bot.config.geMappingFetcher;
    const prevLatestFetcher = bot.config.geLatestPriceFetcher;
    const prevDropRateFetcher = bot.config.dropRateFetcher;
    bot.config.geMappingFetcher = async () => [{ id: 1, name: "Lightbearer" }];
    bot.config.geLatestPriceFetcher = async () => ({ data: { "1": { high: 4300000, low: 4200000 } } });
    bot.config.dropRateFetcher = async (itemName) => (itemName === "Lightbearer" ? "1/200" : null);

    const items = [
      { name: "Lightbearer", quantity: 2 },
      { name: "Masori mask", quantity: 1 }, // untradeable-in-this-test (not in the mapping) and no drop rate on file
    ];
    const enrichedWithPrice = await bot.enrichItemsWithExtras(items, { includePrice: true, pageNameHint: "Tombs of Amascut" });
    check("an item with both a price and a rate gets both in its extra label", enrichedWithPrice[0].extra === "— 4.3m (1/200)");
    check("an item with neither gets no .extra field at all", enrichedWithPrice[1].extra === undefined);

    const enrichedNoPrice = await bot.enrichItemsWithExtras(items, { includePrice: false, pageNameHint: "Tombs of Amascut" });
    check("includePrice: false (used for !pets, since pets are untradeable) omits the price even for an otherwise-tradeable name", enrichedNoPrice[0].extra === "(1/200)");

    bot.config.geMappingFetcher = prevMappingFetcher;
    bot.config.geLatestPriceFetcher = prevLatestFetcher;
    bot.config.dropRateFetcher = prevDropRateFetcher;
    bot._resetGePriceCachesForTests();
    bot._wikiDropRateCacheForTests.clear();
  }

  // ================= batchItemListLines: packs item lines into message-sized batches under ITEM_LIST_CHAR_BUDGET =================
  {
    const emptyBatches = bot.batchItemListLines("Header", []);
    check("zero items still returns at least one (empty) batch, so the header still posts on its own", emptyBatches.length === 1 && emptyBatches[0].length === 0);

    const fewLines = ["**Pet 1**", "**Pet 2**", "**Pet 3**"];
    const fewBatches = bot.batchItemListLines("Header", fewLines);
    check("a short list that easily fits the budget stays in a single batch", fewBatches.length === 1 && fewBatches[0].length === 3);

    // Build enough lines that, together with the header, comfortably bust
    // ITEM_LIST_CHAR_BUDGET and force a split into (at least) two batches.
    const longLine = "*".repeat(200);
    const manyLongLines = Array.from({ length: 30 }, () => longLine); // 30 * 201 chars (incl. newline) > 3500
    const header = "Header";
    const splitBatches = bot.batchItemListLines(header, manyLongLines);
    check("a list that exceeds the character budget is split into more than one batch", splitBatches.length > 1);
    check("every single batch (all lines + header where applicable) stays under the character budget", splitBatches.every((batch, i) => {
      const total = (i === 0 ? header.length : 0) + batch.reduce((sum, l) => sum + l.length + 1, 0);
      return total <= bot.ITEM_LIST_CHAR_BUDGET;
    }));
    check("no line is lost or duplicated across the split", splitBatches.flat().length === manyLongLines.length);
  }

  // ================= handleOsrsStatsCommand: !pets batches an unusually long list across multiple messages =================
  {
    const prevFetcher = bot.config.runeProfileFetcher;
    // Long names push the combined item-list text past ITEM_LIST_CHAR_BUDGET
    // for a single message, forcing a second, header-less continuation
    // message -- the character-budget-based equivalent of the old
    // item-count-based batching cap.
    const manyPets = Array.from({ length: 80 }, (_, i) => ({ name: `A Pet With A Rather Long Name Number ${i + 1}`, quantity: 1 }));
    bot.config.runeProfileFetcher = async () => ({ ok: true, notFound: false, pets: manyPets });
    const message = makeFakeMessage({ content: "!pets Zezima" });
    await bot.handleOsrsStatsCommand(message);
    check("an unusually long pet list spills into more than one message", message._channel._sent.length > 1);
    check("the first message's header text is still present alongside its (first) item batch", resultHeaderText(message._channel._sent[0]).includes("80"));
    const firstBatchLines = resultItemLines(message._channel._sent[0]);
    const secondBatchLines = resultItemLines(message._channel._sent[1], { hasHeader: false });
    check("the first batch has at least one item line", firstBatchLines.length > 0);
    check("the second, header-less message also has item lines", secondBatchLines.length > 0);
    check("every pet across both batches is accounted for exactly once, combined across however many messages it took", message._channel._sent.reduce((sum, sent, i) => sum + resultItemLines(sent, { hasHeader: i === 0 }).length, 0) === 80);
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

    const petNames = result.pets.map((p) => p.name);
    check("a real populated account resolves ok", result.ok === true && result.notFound === false);
    check("exactly the 3 actually-owned pets are returned (from the \"All Pets\" page, not the per-boss pages)", result.pets.length === 3);
    check("owned pets are named correctly", petNames.includes("Pet chaos elemental") && petNames.includes("Pet Zilyana") && petNames.includes("TzRek-Jad"));
    check("unowned pets (quantity 0) are excluded", !petNames.includes("Hellpuppy") && !petNames.includes("Pet Dagannoth Prime"));
    check("each returned pet keeps its quantity (for dupe counts)", result.pets.every((p) => p.quantity === 1));
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

  // ================= resolveCollectionLogPage: !log <category> isn't limited to the !kc boss list =================
  // RuneProfile's data is organized as tabs -> pages, one page per
  // boss/raid/minigame/clue tier etc. !log must be able to find ANY of
  // these by name (not just the curated OSRS_BOSSES/KC_ALIASES universe
  // !kc uses), matched dynamically against whatever pages THIS player's
  // own collection log actually contains.
  const SAMPLE_COLLECTION_LOG = {
    obtained: 50,
    total: 100,
    tabs: [
      {
        name: "Raids",
        pages: [
          { name: "Tombs of Amascut", obtained: 4, total: 10, items: [
            { id: 1, name: "Masori mask", quantity: 1 },
            { id: 2, name: "Lightbearer", quantity: 2 },
            { id: 3, name: "Osmumten's fang", quantity: 0 },
          ] },
        ],
      },
      {
        name: "Bosses",
        pages: [
          // Deliberately named WITHOUT the leading "The " that resolveBossHiscoreName("huey")
          // resolves to ("The Hueycoatl") -- exercises the hiscoreMatchKey "The "-tolerant match.
          { name: "Hueycoatl", obtained: 1, total: 3, items: [{ id: 4, name: "Huasca", quantity: 1 }] },
          { name: "Zulrah", obtained: 0, total: 5, items: [{ id: 5, name: "Tanzanite fang", quantity: 0 }] },
        ],
      },
      {
        name: "Minigames",
        pages: [
          // Not a !kc boss at all -- only resolvable via direct name matching, not the boss alias table.
          { name: "Barbarian Assault", obtained: 2, total: 6, items: [{ id: 6, name: "Fighter torso", quantity: 1 }] },
        ],
      },
      {
        name: "Clues",
        pages: [
          { name: "Clue Scrolls (easy)", obtained: 1, total: 4, items: [{ id: 7, name: "Clue scroll (easy) reward", quantity: 1 }] },
          { name: "Clue Scrolls (medium)", obtained: 0, total: 4, items: [] },
        ],
      },
    ],
  };

  {
    check("a known !kc boss alias resolves against the real page name even across a 'The '-prefix mismatch ('huey' -> 'Hueycoatl' page)",
      bot.resolveCollectionLogPage(SAMPLE_COLLECTION_LOG, "huey")?.name === "Hueycoatl");
    check("the full boss name also resolves the same way", bot.resolveCollectionLogPage(SAMPLE_COLLECTION_LOG, "hueycoatl")?.name === "Hueycoatl");
    check("a known raid alias resolves normally ('toa' -> Tombs of Amascut)",
      bot.resolveCollectionLogPage(SAMPLE_COLLECTION_LOG, "toa")?.name === "Tombs of Amascut");
    check("a category outside the !kc boss list resolves via an exact name match ('barbarianassault')",
      bot.resolveCollectionLogPage(SAMPLE_COLLECTION_LOG, "barbarianassault")?.name === "Barbarian Assault");
    check("a shortened, non-boss category name resolves via the unambiguous-prefix fallback ('barb')",
      bot.resolveCollectionLogPage(SAMPLE_COLLECTION_LOG, "barb")?.name === "Barbarian Assault");
    check("an ambiguous shortened category (could be easy or medium clues) safely refuses rather than guessing",
      bot.resolveCollectionLogPage(SAMPLE_COLLECTION_LOG, "cluescrolls") === null);
    check("a completely unrecognized category resolves to null", bot.resolveCollectionLogPage(SAMPLE_COLLECTION_LOG, "bananas") === null);
  }

  // ================= handleOsrsStatsCommand: !log <category> end-to-end =================
  {
    const prevFetcher = bot.config.collectionLogFetcher;
    const prevWikiPageFetcher = bot.config.wikiImageFetcher;
    bot._wikiPageImageCacheForTests.clear();
    bot.config.collectionLogFetcher = async () => ({ ok: true, notFound: false, data: SAMPLE_COLLECTION_LOG });
    bot.config.wikiImageFetcher = async (titles) => {
      check("!log looks up the category's own boss/activity image -- the same lookup !kc already uses -- via wikiTitleForBoss", titles.length === 1 && titles[0] === "Tombs of Amascut");
      return new Map(titles.map((t) => [t, `https://wiki.example/${t.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`]));
    };

    const message = makeFakeMessage({ content: "!log toa Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("!log is recognized as a handled command", handled === true);
    check("the command message is deleted", message._deleted === true);
    check("the banner, header, and item list all combine into one Components V2 message", message._channel._sent.length === 1);
    check("!log's container is colored red (COLOR.bad), distinct from !pets' coloring", resultContainerJSON(message._channel._sent[0]).accent_color === bot.COLOR.bad);
    check("!log shows a single banner picture of the category's own boss/activity, resolved the same way !kc's image is", resultBannerUrl(message._channel._sent[0]) === "https://wiki.example/tombs-of-amascut.png");
    const headerText = resultHeaderText(message._channel._sent[0]);
    check("the header names the player and the resolved category", headerText.includes("Zezima") && headerText.includes("Tombs of Amascut"));
    check("the header shows the category's obtained/total progress", headerText.includes("4/10"));
    check("the header states how many items are shown (only the owned ones), without listing them itself", headerText.includes("2") && !headerText.includes("Masori"));
    const lines = resultItemLines(message._channel._sent[0]);
    check("only owned items get their own line (the unowned Osmumten's fang is excluded)", lines.length === 2);
    check("an item obtained once is named on its own line, without a dupe badge", lines.includes("**Masori mask**"));
    check("an item obtained more than once shows its dupe count on its own line", lines.includes("**Lightbearer** x2"));

    bot.config.collectionLogFetcher = prevFetcher;
    bot.config.wikiImageFetcher = prevWikiPageFetcher;
  }

  // ================= handleOsrsStatsCommand: !log <category> shows GE value + drop rate in the item labels, !pets shows drop rate only =================
  {
    const prevCollectionFetcher = bot.config.collectionLogFetcher;
    const prevRuneProfileFetcher = bot.config.runeProfileFetcher;
    const prevMappingFetcher = bot.config.geMappingFetcher;
    const prevLatestFetcher = bot.config.geLatestPriceFetcher;
    const prevDropRateFetcher = bot.config.dropRateFetcher;
    bot._resetGePriceCachesForTests();
    bot._wikiDropRateCacheForTests.clear();

    bot.config.collectionLogFetcher = async () => ({ ok: true, notFound: false, data: SAMPLE_COLLECTION_LOG });
    bot.config.runeProfileFetcher = async () => ({ ok: true, notFound: false, pets: [{ name: "Baby Mole", quantity: 1 }] });
    bot.config.geMappingFetcher = async () => [{ id: 1, name: "Masori mask" }, { id: 2, name: "Lightbearer" }];
    bot.config.geLatestPriceFetcher = async () => ({ data: { "1": { high: 8_500_000, low: 8_300_000 }, "2": { high: 4_300_000, low: 4_200_000 } } });
    bot.config.dropRateFetcher = async (itemName) => {
      if (itemName === "Masori mask") return "1/3,000";
      if (itemName === "Lightbearer") return "1/1,500";
      if (itemName === "Baby Mole") return "1/3,000";
      return null;
    };

    const logMessage = makeFakeMessage({ content: "!log toa Zezima" });
    await bot.handleOsrsStatsCommand(logMessage);
    const logLines = resultItemLines(logMessage._channel._sent[0]);
    check("!log's item lines include a tradeable item's GE value next to its name", logLines.includes("**Masori mask** — 8.5m (1/3,000)"));
    check("!log's item lines include a dupe-count item's GE value alongside its count", logLines.includes("**Lightbearer** x2 — 4.3m (1/1,500)"));

    const petsMessage = makeFakeMessage({ content: "!pets Zezima" });
    await bot.handleOsrsStatsCommand(petsMessage);
    const petsLines = resultItemLines(petsMessage._channel._sent[0]);
    check("!pets' item lines show the drop rate but NEVER a GE value, since pets are untradeable", petsLines.includes("**Baby Mole** (1/3,000)") && !petsLines.some((l) => /—/.test(l)));

    bot.config.collectionLogFetcher = prevCollectionFetcher;
    bot.config.runeProfileFetcher = prevRuneProfileFetcher;
    bot.config.geMappingFetcher = prevMappingFetcher;
    bot.config.geLatestPriceFetcher = prevLatestFetcher;
    bot.config.dropRateFetcher = prevDropRateFetcher;
    bot._resetGePriceCachesForTests();
    bot._wikiDropRateCacheForTests.clear();
  }

  // ================= findHiscoreActivityForCollectionLogPage: cross-referencing a !log category against the official Hiscores =================
  // RuneProfile's own collection log data never includes kill counts, so !log
  // shows them (when available) by matching the resolved category name
  // against the SAME official Hiscores activities !kc already reads from --
  // letting someone spot a mega-spooned (very few kills, lots of items) or
  // cursed (tons of kills, barely any items) account from the numbers alone.
  {
    const hiscoreData = {
      activities: [
        { name: "The Hueycoatl", rank: 1226, score: 1367 }, // "The "-prefix mismatch, same as !kc's own bug fix
        { name: "Tombs of Amascut", rank: 500, score: 42 },
        { name: "Tombs of Amascut: Expert Mode", rank: -1, score: 0 },
        { name: "Zulrah", rank: -1, score: 0 }, // never killed -- must NOT be reported as "0 kills recorded"
      ],
    };
    check(
      "a page name resolves against the Hiscores even across a 'The '-prefix mismatch",
      bot.findHiscoreActivityForCollectionLogPage(hiscoreData, "Hueycoatl")?.score === 1367
    );
    check(
      "an exact-name match (no prefix quirk) also resolves",
      bot.findHiscoreActivityForCollectionLogPage(hiscoreData, "Tombs of Amascut")?.score === 42
    );
    check(
      "a raid's '...: Expert Mode' collection log page name falls back to the base raid's Hiscores entry when the CM-specific one is unranked",
      bot.findHiscoreActivityForCollectionLogPage(hiscoreData, "Tombs of Amascut: Expert Mode")?.score === 42
    );
    check(
      "a Hiscores entry with 0 recorded kills (never actually killed) is treated as no match, not a real 0-kill result",
      bot.findHiscoreActivityForCollectionLogPage(hiscoreData, "Zulrah") === null
    );
    check(
      "a category with no Hiscores equivalent at all (e.g. a non-tracked minigame) resolves to null rather than crashing",
      bot.findHiscoreActivityForCollectionLogPage(hiscoreData, "Some Untracked Minigame") === null
    );
    check("a missing/null hiscoreData is handled gracefully", bot.findHiscoreActivityForCollectionLogPage(null, "Zulrah") === null);
  }

  // ================= handleOsrsStatsCommand: !log <category> shows Hiscores KC/completions alongside the item count =================
  {
    const prevCollectionFetcher = bot.config.collectionLogFetcher;
    const prevHiscoreFetcher = bot.config.hiscoreFetcher;
    bot.config.collectionLogFetcher = async () => ({ ok: true, notFound: false, data: SAMPLE_COLLECTION_LOG });
    bot.config.hiscoreFetcher = async () => ({ activities: [{ name: "The Hueycoatl", rank: 1226, score: 1367 }] });

    const message = makeFakeMessage({ content: "!log huey Zezima" });
    await bot.handleOsrsStatsCommand(message);
    const headerText = resultHeaderText(message._channel._sent[0]);
    check("the header includes the matched Hiscores kill count for a boss category", headerText.includes("1,367"));
    check("the header phrases it as kills/completions recorded", /kills?\/completions? recorded/i.test(headerText));

    bot.config.collectionLogFetcher = prevCollectionFetcher;
    bot.config.hiscoreFetcher = prevHiscoreFetcher;
  }

  // ================= handleOsrsStatsCommand: !log <category> still works fine when there's no Hiscores match (or the lookup fails) =================
  {
    const prevCollectionFetcher = bot.config.collectionLogFetcher;
    const prevHiscoreFetcher = bot.config.hiscoreFetcher;
    bot.config.collectionLogFetcher = async () => ({ ok: true, notFound: false, data: SAMPLE_COLLECTION_LOG });
    bot.config.hiscoreFetcher = async () => { throw new Error("simulated Hiscores outage"); };

    const message = makeFakeMessage({ content: "!log toa Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("a failed/unmatched Hiscores lookup doesn't break the !log command itself", handled === true);
    const headerText = resultHeaderText(message._channel._sent[0]);
    check("the header simply omits the kills/completions clause rather than crashing or showing a bogus number", !/kills?\/completions?/i.test(headerText));

    bot.config.collectionLogFetcher = prevCollectionFetcher;
    bot.config.hiscoreFetcher = prevHiscoreFetcher;
  }

  // ================= handleOsrsStatsCommand: !log <category> with nothing obtained yet =================
  {
    const prevFetcher = bot.config.collectionLogFetcher;
    bot.config.collectionLogFetcher = async () => ({ ok: true, notFound: false, data: SAMPLE_COLLECTION_LOG });
    const message = makeFakeMessage({ content: "!log zulrah Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("a category with zero owned items is still a handled command", handled === true);
    const text = message._channel._sent[0].payload.embeds[0].data.description;
    check("the reply states nothing's been obtained yet rather than crashing", /hasn't obtained anything/i.test(text) && text.includes("Zulrah"));
    bot.config.collectionLogFetcher = prevFetcher;
  }

  // ================= handleOsrsStatsCommand: !log <category> with an unrecognized category =================
  {
    const prevFetcher = bot.config.collectionLogFetcher;
    bot.config.collectionLogFetcher = async () => ({ ok: true, notFound: false, data: SAMPLE_COLLECTION_LOG });
    const message = makeFakeMessage({ content: "!log bananas Zezima" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("an unrecognized !log category is still a handled (and cleaned-up) command", handled === true);
    check("the command message is still deleted", message._deleted === true);
    check("a transient notice (not a permanent channel post) is sent", message._channel._sent.length === 1);
    bot.config.collectionLogFetcher = prevFetcher;
  }

  // ================= handleOsrsStatsCommand: !log, no RuneProfile account (the anti-spam case) =================
  {
    const prevFetcher = bot.config.collectionLogFetcher;
    bot.config.collectionLogFetcher = async () => ({ ok: false, notFound: true, data: null });
    const message = makeFakeMessage({ content: "!log toa NobodyHasThis123" });
    const handled = await bot.handleOsrsStatsCommand(message);
    check("a missing RuneProfile account is still a handled command", handled === true);
    check("NOTHING is posted publicly to the channel for a missing RuneProfile account", message._channel._sent.length === 0);
    check("instead, the setup instructions are DMed to the invoker", message._dmsSent.length === 1);
    bot.config.collectionLogFetcher = prevFetcher;
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
