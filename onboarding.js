// ================= HEIMDALL — ONBOARDING + ORIENTATION + RANKING BOT =================
// Flow:
//   1. Member joins -> bot gives them the Unverified role.
//   2. Member finishes the Discord onboarding:
//        - they ended up with the Clan Member role -> bot @pings them in the onboarding channel
//        - they did NOT have the Clan Member role  -> no ping; bot just removes Unverified
//   3. A permanent embed in that channel has one button: "Update Server Nickname".
//   4. Button (only usable by members with the Clan Member role) -> popup asks for in-game
//      username -> two confirmations -> nickname is set.
//   5. Once the nickname is set, the bot gives the OSRS role, removes the Unverified role
//      and deletes that member's @ping. Only the permanent embed remains.
//   Roles the bot gives: Unverified (on join) and OSRS (only after the nickname is set).
//   Any other access role is handled elsewhere.
//
// Orientation (separate channel):
//   A permanent embed explains the chain of command and has two buttons:
//     - "I Accept Leader Role"          usable only by the Leader role      -> gives Verified Leader
//     - "I Accept Staff/Jr. Staff Role" usable only by the Staff or Jr. Staff role -> gives Verified Staff
//   These buttons ONLY ever add the verified role. They never remove any role.
//
// Clan Ranking System (Supabase-backed):
//   - Reads clan members (RSN + joined_date) from Supabase (`clan_members` and `roster_upload`).
//   - Automatically calculates time in clan from `joined_date` to current date and awards
//     progressive Rank XP for Weekly (2,500 x rank multiplier), Monthly (10,000), and Yearly (100,000)
//     tenure milestones.
//   - Posts XP awards, confirmed rank-ups (with the staff member who ranked them up), and
//     clan departures to the XP & Rank Log channel.
//   - Sends Rank-Up and Member-Left alerts to the Staff Alert channel with a 2-step confirmation
//     flow that auto-deletes the alert as soon as the 2nd confirmation is clicked.
//   - Maintains an auto-updated permanent Rank List in the Rank List channel.

require("dotenv").config();
if (typeof globalThis.WebSocket === "undefined") {
  try {
    globalThis.WebSocket = require("ws");
  } catch {}
}
const zlib = require("zlib");
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  Events,
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildMemberFlags,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const UNVERIFIED_ROLE_ID    = "1547278787815804928";
const CLAN_MEMBER_ROLE_ID   = "1546403975656505354";
const OSRS_ROLE_ID          = "1546412132822810744";
const ONBOARDING_CHANNEL_ID = "1546401367004811314";

// Orientation acknowledgement & leadership roles
const ORIENTATION_CHANNEL_ID   = "1559995329825472542";
const OWNER_ROLE_ID            = "1546401420453085204";
const CO_OWNER_ROLE_ID         = "1559998510110347274";
const LEADER_ROLE_ID           = "1546401937883402293";
const STAFF_ROLE_ID            = "1546402959049359360";
const JR_STAFF_ROLE_ID         = "1546403383752134656";
const VERIFIED_LEADER_ROLE_ID  = "1559994620442710097";
const VERIFIED_STAFF_ROLE_ID   = "1559997317325656094";

// Roles allowed to upload the clan roster through the bot
const ROSTER_UPLOAD_ROLE_IDS = [
  OWNER_ROLE_ID,
  CO_OWNER_ROLE_ID,
  VERIFIED_LEADER_ROLE_ID,
  LEADER_ROLE_ID,
];

// Ranking system channels
const STAFF_ALERT_CHANNEL_ID = "1561481869197840504";
const RANK_LIST_CHANNEL_ID   = "1561482413341679757";
const RANK_LOG_CHANNEL_ID    = "1561484125016428605";

// Temporary Voice Channel Creator & Category IDs
const CREATE_VOICE_CHANNEL_ID        = "1562519552414453911";
const SOCIAL_HUB_CATEGORY_ID         = "1546412771598532628";
const OSRS_CATEGORY_ID               = "1545654996928823377";
const OTHER_GAMES_CATEGORY_ID        = "1545654996928823378";
const VOICE_EMPTY_TIMEOUT_MS         = 5 * 60 * 1000; // Auto-delete 5 minutes after last person leaves
const VOICE_INITIAL_EMPTY_TIMEOUT_MS = 60 * 1000;     // Auto-delete after 60 seconds if nobody joins after creation
const VOICE_CREATE_COOLDOWN_MS       = 5 * 60 * 1000; // Limit each user to creating 1 voice channel every 5 minutes

// Weekly Events (Skill of the Week & Boss of the Week)
const WEEKLY_EVENTS_CHANNEL_ID       = "1562600669796507760";
const WEEKLY_EVENT_POLL_INTERVAL_MS  = 2 * 60 * 60 * 1000; // Poll OSRS HiScores every 2 hours starting Friday 00:00 Central
const WEEKLY_EVENTS_TIMEZONE         = "America/Chicago";  // Central Time (CST/CDT)
const WEEKLY_EVENTS_ANCHOR_DATE      = { year: 2026, month: 10, day: 23 }; // Friday, Oct 23, 2026
const WEEKLY_EVENTS_ANCHOR_ISO       = "2026-10-23T00:00:00-05:00"; // First SOTW starts Friday, Oct 23, 2026 at 00:00 Central
const FRACTURED_ARCHIVES_UNLOCK_DATE = "2027-04-21"; // 6-month restriction from 2026-10-21

const OSRS_SKILLS = [
  { name: "Attack",       hiscoreNames: ["Attack"] },
  { name: "Strength",     hiscoreNames: ["Strength"] },
  { name: "Defence",      hiscoreNames: ["Defence"] },
  { name: "Ranged",       hiscoreNames: ["Ranged"] },
  { name: "Prayer",       hiscoreNames: ["Prayer"] },
  { name: "Magic",        hiscoreNames: ["Magic"] },
  { name: "Hitpoints",    hiscoreNames: ["Hitpoints"] },
  { name: "Mining",       hiscoreNames: ["Mining"] },
  { name: "Fishing",      hiscoreNames: ["Fishing"] },
  { name: "Woodcutting",  hiscoreNames: ["Woodcutting"] },
  { name: "Farming",      hiscoreNames: ["Farming"] },
  { name: "Hunter",       hiscoreNames: ["Hunter"] },
  { name: "Sailing",      hiscoreNames: ["Sailing"] },
  { name: "Runecraft",    hiscoreNames: ["Runecraft", "Runecrafting"] },
  { name: "Construction", hiscoreNames: ["Construction"] },
  { name: "Herblore",     hiscoreNames: ["Herblore"] },
  { name: "Crafting",     hiscoreNames: ["Crafting"] },
  { name: "Fletching",    hiscoreNames: ["Fletching"] },
  { name: "Smithing",     hiscoreNames: ["Smithing"] },
  { name: "Cooking",      hiscoreNames: ["Cooking"] },
  { name: "Firemaking",   hiscoreNames: ["Firemaking"] },
  { name: "Agility",      hiscoreNames: ["Agility"] },
  { name: "Thieving",     hiscoreNames: ["Thieving"] },
  { name: "Slayer",       hiscoreNames: ["Slayer"] },
];

const OSRS_BOSSES = [
  // Raids (regular & challenge/hard/expert modes combined)
  { name: "Chambers of Xeric",                  hiscoreNames: ["Chambers of Xeric", "Chambers of Xeric: Challenge Mode"] },
  { name: "Theatre of Blood",                   hiscoreNames: ["Theatre of Blood", "Theatre of Blood: Hard Mode"] },
  { name: "Tombs of Amascut",                   hiscoreNames: ["Tombs of Amascut", "Tombs of Amascut: Expert Mode"] },
  {
    name: "The Fractured Archives",
    hiscoreNames: ["The Fractured Archives", "The Fractured Archives: Hard Mode", "The Fractured Archives: Challenge Mode", "Fractured Archives"],
    unlockAfter: FRACTURED_ARCHIVES_UNLOCK_DATE,
  },
  // God Wars Dungeon
  { name: "Commander Zilyana",                  hiscoreNames: ["Commander Zilyana"] },
  { name: "General Graardor",                   hiscoreNames: ["General Graardor"] },
  { name: "K'ril Tsutsaroth",                   hiscoreNames: ["K'ril Tsutsaroth"] },
  { name: "Kree'arra",                          hiscoreNames: ["Kree'arra"] },
  { name: "Nex",                                hiscoreNames: ["Nex"] },
  // Desert Treasure II
  { name: "Duke Sucellus",                      hiscoreNames: ["Duke Sucellus"] },
  { name: "The Leviathan",                      hiscoreNames: ["The Leviathan"] },
  { name: "The Whisperer",                      hiscoreNames: ["The Whisperer"] },
  { name: "Vardorvis",                          hiscoreNames: ["Vardorvis"] },
  // Wilderness Bosses (Solo & Multi combined)
  { name: "Callisto / Artio",                   hiscoreNames: ["Callisto", "Artio"] },
  { name: "Venenatis / Spindel",                hiscoreNames: ["Venenatis", "Spindel"] },
  { name: "Vet'ion / Calvar'ion",               hiscoreNames: ["Vet'ion", "Calvar'ion"] },
  { name: "Chaos Elemental",                    hiscoreNames: ["Chaos Elemental"] },
  { name: "Chaos Fanatic",                      hiscoreNames: ["Chaos Fanatic"] },
  { name: "Crazy Archaeologist",                hiscoreNames: ["Crazy Archaeologist"] },
  { name: "Scorpia",                            hiscoreNames: ["Scorpia"] },
  // Varlamore, Kourend & Newer Bosses
  { name: "Amoxliatl",                          hiscoreNames: ["Amoxliatl"] },
  { name: "Doom of Mokhaiotl",                  hiscoreNames: ["Doom of Mokhaiotl"] },
  { name: "The Hueycoatl",                      hiscoreNames: ["The Hueycoatl", "Hueycoatl"] },
  { name: "Moons of Peril",                     hiscoreNames: ["Lunar Chests", "Moons of Peril"] },
  { name: "Royal Titans",                       hiscoreNames: ["The Royal Titans", "Royal Titans"] },
  { name: "Sarachnis",                          hiscoreNames: ["Sarachnis"] },
  { name: "Yama",                               hiscoreNames: ["Yama"] },
  // Classic, World & Instanced Bosses
  { name: "Barrows",                            hiscoreNames: ["Barrows Chests", "Barrows"] },
  { name: "Bryophyta",                          hiscoreNames: ["Bryophyta"] },
  { name: "Brutus",                             hiscoreNames: ["Brutus"] },
  { name: "Corporeal Beast",                    hiscoreNames: ["Corporeal Beast"] },
  { name: "Dagannoth Kings",                    hiscoreNames: ["Dagannoth Prime", "Dagannoth Rex", "Dagannoth Supreme"] },
  { name: "Deranged Archaeologist",             hiscoreNames: ["Deranged Archaeologist"] },
  { name: "Giant Mole",                         hiscoreNames: ["Giant Mole"] },
  { name: "Kalphite Queen",                     hiscoreNames: ["Kalphite Queen"] },
  { name: "King Black Dragon",                  hiscoreNames: ["King Black Dragon"] },
  { name: "Obor",                               hiscoreNames: ["Obor"] },
  { name: "Phantom Muspah",                     hiscoreNames: ["Phantom Muspah"] },
  { name: "Scurrius",                           hiscoreNames: ["Scurrius"] },
  { name: "The Nightmare / Phosani's Nightmare", hiscoreNames: ["Nightmare", "The Nightmare", "Phosani's Nightmare"] },
  { name: "Vorkath",                            hiscoreNames: ["Vorkath"] },
  { name: "Zulrah",                             hiscoreNames: ["Zulrah"] },
  // Skilling, Gauntlet & Wave Bosses
  { name: "The Gauntlet / Corrupted Gauntlet",  hiscoreNames: ["The Gauntlet", "The Corrupted Gauntlet"] },
  { name: "Tempoross",                          hiscoreNames: ["Tempoross"] },
  { name: "Wintertodt",                         hiscoreNames: ["Wintertodt"] },
  { name: "Zalcano",                            hiscoreNames: ["Zalcano"] },
  { name: "TzTok-Jad",                          hiscoreNames: ["TzTok-Jad"] },
  { name: "TzKal-Zuk",                          hiscoreNames: ["TzKal-Zuk"] },
  { name: "Sol Heredit",                        hiscoreNames: ["Sol Heredit"] },
];

const VOICE_CATEGORIES = [
  {
    key: "social",
    categoryId: SOCIAL_HUB_CATEGORY_ID,
    label: "Social Hub",
    prefix: "Social Voice",
    description: "Creates Social Voice 1, 2, 3... under Social Hub",
  },
  {
    key: "osrs",
    categoryId: OSRS_CATEGORY_ID,
    label: "Old School Runescape",
    prefix: "OSRS Voice",
    description: "Creates OSRS Voice 1, 2, 3... under Old School Runescape",
  },
  {
    key: "other_games",
    categoryId: OTHER_GAMES_CATEGORY_ID,
    label: "Other Games",
    prefix: "Other Games Voice",
    description: "Creates Other Games Voice 1, 2, 3... under Other Games",
  },
];

// Clan creation date floor (join dates earlier than this are clamped to 2026-10-11)
const CLAN_CREATION_DATE = "2026-10-11";

// Tenure XP award amounts
const WEEKLY_BASE_XP  = 2500;   // Multiplied by current rank multiplier every 7 days
const MONTHLY_BASE_XP = 10000;  // Awarded every 30 days
const YEARLY_BASE_XP  = 100000; // Awarded every 365 days

// Rank progression table (Bronze -> Legacy)
const RANK_TIERS = [
  { name: "Bronze",      multiplier: 1,    xpNeeded: 0,       emoji: "<:bronze:1561542018038104135>" },
  { name: "Steel",       multiplier: 1,    xpNeeded: 2500,    emoji: "<:steel:1561542523946537030>" },
  { name: "Black",       multiplier: 1,    xpNeeded: 10000,   emoji: "<:black:1561542000799649894>" },
  { name: "Mithril",     multiplier: 1.5,  xpNeeded: 20000,   emoji: "<:mithril:1561542215031988234>" },
  { name: "Adamant",     multiplier: 1.5,  xpNeeded: 42500,   emoji: "<:adamant:1561541980402618510>" },
  { name: "Rune",        multiplier: 2,    xpNeeded: 65000,   emoji: "<:rune:1561542461183102996>" },
  { name: "Dragon",      multiplier: 2,    xpNeeded: 105000,  emoji: "<:dragon:1561542060631130204>" },
  { name: "Sapphire",    multiplier: 2.5,  xpNeeded: 155000,  emoji: "<:sapphire:1561542479465943132>" },
  { name: "Emerald",     multiplier: 2.5,  xpNeeded: 220000,  emoji: "<:emerald:1561542095075024896>" },
  { name: "Ruby",        multiplier: 3,    xpNeeded: 295000,  emoji: "<:ruby:1561542439272063056>" },
  { name: "Diamond",     multiplier: 3,    xpNeeded: 400000,  emoji: "<:diamond:1561542040876228792>" },
  { name: "Dragonstone", multiplier: 3.5,  xpNeeded: 500000,  emoji: "<:dragonstone:1561542078612246598>" },
  { name: "Onyx",        multiplier: 3.5,  xpNeeded: 655000,  emoji: "<:onyx:1561542393709199470>" },
  { name: "Zenyte",      multiplier: 4,    xpNeeded: 780000,  emoji: "<:zenyte:1561542547799674910>" },
  { name: "Legacy",      multiplier: null, xpNeeded: 1045000, emoji: "<:legacy:1561542158346100776>" },
];

// OSRS display names: max 12 characters (OSRS wiki, Account Management > Display name).
const RSN_MAX_LENGTH = 12;
const RSN_PATTERN    = /^[A-Za-z0-9 _-]+$/;

// How many recent channel messages to scan when looking for old messages.
const SCAN_PAGES_PERMANENT = 5; // 500 messages — finding the permanent embed
const SCAN_PAGES_PINGS     = 2; // 200 messages — finding a member's ping

// Runtime configuration
const config = {
  settleMs: 3000,
  rankSyncIntervalMs: 30 * 60 * 1000, // Check Supabase + tenure milestones every 30 minutes
  weeklyEventPollIntervalMs: WEEKLY_EVENT_POLL_INTERVAL_MS,
  voiceEmptyTimeoutMs: VOICE_EMPTY_TIMEOUT_MS,
  voiceInitialEmptyTimeoutMs: VOICE_INITIAL_EMPTY_TIMEOUT_MS,
  voiceCreateCooldownMs: VOICE_CREATE_COOLDOWN_MS,
  multiplyMonthlyYearly: false,       // Weekly uses rank multiplier; Monthly & Yearly are flat bonuses
  growthChartRange: "all",            // "30d" | "6m" | "all"
  supabase: null,                     // Initialized on startup or injected for tests
  hiscoreFetcher: null,               // Optional override for testing OSRS HiScores fetches
};

// Component custom IDs
const ID = {
  START:    "nick_start",
  MODAL:    "nick_modal",
  INPUT:    "nick_input",
  CONFIRM1: "nick_c1",
  CONFIRM2: "nick_c2",
  CANCEL:   "nick_cancel",
  ORIENT_LEADER: "orient_leader",
  ORIENT_STAFF:  "orient_staff",
  // Ranking system custom IDs
  RANK_LIST_REFRESH: "rank_list_refresh",
  ROSTER_UPLOAD_BTN: "roster_upload_btn",
  ROSTER_PASTE_BTN:  "roster_paste_btn",
  ROSTER_MODAL:      "roster_modal",
  ROSTER_INPUT:      "roster_input",
  GROWTH_RANGE_30D:  "growth_range_30d",
  GROWTH_RANGE_6M:   "growth_range_6m",
  GROWTH_RANGE_ALL:  "growth_range_all",
  RANKUP_C1:         "rankup_c1",
  RANKUP_C2:         "rankup_c2",
  RANKUP_CANCEL:     "rankup_cancel",
  LEFT_C1:           "left_c1",
  LEFT_C2:           "left_c2",
  LEFT_CANCEL:       "left_cancel",
  // Temporary voice channel creator custom IDs
  VOICE_CATEGORY_SELECT: "voice_cat_select",
  VOICE_CREATE_CONFIRM:  "voice_create_confirm",
  VOICE_CREATE_CANCEL:   "voice_create_cancel",
};

const COLOR = {
  main: 0x2b6cb0,
  warn: 0xd69e2e,
  ok:   0x38a169,
  bad:  0xe53e3e,
  gold: 0xd69e2e,
};

// ================= CLIENT =================
const client = new Client({
  // GuildMembers is a privileged intent — it must be enabled in the Developer Portal
  // (Bot tab -> Privileged Gateway Intents -> Server Members Intent).
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

function getSupabase() {
  if (config.supabase) return config.supabase;
  if (SUPABASE_URL && SUPABASE_KEY) {
    if (typeof globalThis.WebSocket === "undefined") {
      try {
        globalThis.WebSocket = require("ws");
      } catch {}
    }
    config.supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
      realtime: globalThis.WebSocket ? { transport: globalThis.WebSocket } : undefined,
    });
    return config.supabase;
  }
  return null;
}

// ================= HELPERS =================
function validateRsn(raw) {
  const name = String(raw ?? "").trim();
  if (!name) {
    return { ok: false, error: "You didn't enter a username." };
  }
  if (name.length > RSN_MAX_LENGTH) {
    return { ok: false, error: `In-game usernames can't be longer than ${RSN_MAX_LENGTH} characters (you entered ${name.length}).` };
  }
  if (!RSN_PATTERN.test(name)) {
    return { ok: false, error: "Usernames can only contain letters, numbers, spaces, hyphens (-) and underscores (_)." };
  }
  return { ok: true, name };
}

const encodeName = (name) => Buffer.from(String(name ?? ""), "utf8").toString("base64url");
const decodeName = (b64) => Buffer.from(String(b64 ?? ""), "base64url").toString("utf8");

function messageHasButton(message, customIds) {
  return (message.components || []).some((row) =>
    (row.components || []).some((c) => customIds.includes(c.customId))
  );
}

function messageHasStartButton(message) {
  return messageHasButton(message, [ID.START]);
}

function isPingFor(message, userId) {
  return (
    message.author?.id === client.user?.id &&
    typeof message.content === "string" &&
    message.content.includes(`<@${userId}>`) &&
    !messageHasStartButton(message)
  );
}

async function getChannelById(channelId, label = "Channel") {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.error(`[${label}] Channel ${channelId} not found or not text-based.`);
    return null;
  }
  return channel;
}

const getOnboardingChannel = () => getChannelById(ONBOARDING_CHANNEL_ID, "Onboarding");
const getStaffAlertChannel = () => getChannelById(STAFF_ALERT_CHANNEL_ID, "StaffAlert");
const getRankListChannel   = () => getChannelById(RANK_LIST_CHANNEL_ID, "RankList");
const getRankLogChannel    = () => getChannelById(RANK_LOG_CHANNEL_ID, "RankLog");

// Collect up to `pages` x 100 recent messages (newest first).
async function fetchRecentMessages(channel, pages) {
  const all = [];
  let before;
  for (let i = 0; i < pages; i++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch || batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all;
}

// ================= RANKING MATH & DATE HELPERS =================
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MONTH_MAP = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Parses ISO dates (YYYY-MM-DD), OSRS dates (18-Oct-2026 / 18 Oct 2026), or US dates (MM/DD/YYYY)
// into a normalized YYYY-MM-DD string and UTC midnight timestamp.
function parseJoinedDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    const y = raw.getUTCFullYear();
    const m = raw.getUTCMonth() + 1;
    const d = raw.getUTCDate();
    return {
      iso: `${y}-${pad2(m)}-${pad2(d)}`,
      utcMs: Date.UTC(y, m - 1, d),
    };
  }

  const str = String(raw).trim();
  if (!str) return null;

  // 1. YYYY-MM-DD (or ISO timestamp starting with YYYY-MM-DD)
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    const utcMs = Date.UTC(y, m - 1, d);
    if (!isNaN(utcMs)) return { iso: `${y}-${pad2(m)}-${pad2(d)}`, utcMs };
  }

  // 2. OSRS in-game format: DD-Mon-YYYY or DD Mon YYYY (e.g. "18-Oct-2026")
  const osrsMatch = str.match(/^(\d{1,2})[\s/-]([A-Za-z]+)[\s/-](\d{4})$/);
  if (osrsMatch) {
    const d = Number(osrsMatch[1]);
    const m = MONTH_MAP[osrsMatch[2].toLowerCase()];
    const y = Number(osrsMatch[3]);
    if (m) {
      const utcMs = Date.UTC(y, m - 1, d);
      if (!isNaN(utcMs)) return { iso: `${y}-${pad2(m)}-${pad2(d)}`, utcMs };
    }
  }

  // 3. MM/DD/YYYY
  const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const m = Number(slashMatch[1]);
    const d = Number(slashMatch[2]);
    const y = Number(slashMatch[3]);
    const utcMs = Date.UTC(y, m - 1, d);
    if (!isNaN(utcMs)) return { iso: `${y}-${pad2(m)}-${pad2(d)}`, utcMs };
  }

  // Fallback Date.parse
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear();
    const m = parsed.getUTCMonth() + 1;
    const d = parsed.getUTCDate();
    return {
      iso: `${y}-${pad2(m)}-${pad2(d)}`,
      utcMs: Date.UTC(y, m - 1, d),
    };
  }

  return null;
}

function getRankForXp(xp) {
  const numericXp = Number(xp) || 0;
  let current = RANK_TIERS[0];
  for (const tier of RANK_TIERS) {
    if (numericXp >= tier.xpNeeded) {
      current = tier;
    } else {
      break;
    }
  }
  return current;
}

function getNextRankTier(rankName) {
  const idx = getRankIndex(rankName);
  if (idx < 0 || idx >= RANK_TIERS.length - 1) return null;
  return RANK_TIERS[idx + 1];
}

function getRankIndex(rankName) {
  if (!rankName) return 0;
  const lower = String(rankName).trim().toLowerCase();
  const idx = RANK_TIERS.findIndex((t) => t.name.toLowerCase() === lower);
  return idx === -1 ? 0 : idx;
}

function getRankEmoji(rankName) {
  const tier = RANK_TIERS[getRankIndex(rankName)];
  return tier?.emoji || "";
}

function formatRankName(rankName, bold = true) {
  const tier = RANK_TIERS[getRankIndex(rankName)];
  const name = tier?.name || String(rankName || "Bronze");
  const emoji = tier?.emoji ? `${tier.emoji} ` : "";
  return bold ? `${emoji}**${name}**` : `${emoji}${name}`;
}

function formatMultiplier(mult) {
  return mult === null || mult === undefined ? "n/a" : `${mult}x`;
}

// ── Rank progress display ────────────────────────────────────────────────────
// The member list deliberately does NOT print a rank multiplier.
//
// Rank is now the sum of two independent XP streams: `tenure_xp` (replayed from
// the join date, and the only stream that ever applies a multiplier) and
// `bonus_xp` (flat Honour Marks quest XP, never multiplied). Because both feed
// the displayed rank, a member CAN rank up above their tenure tier — but their
// tenure awards still use the tenure-tier multiplier. Printing "Ruby (3x)" next
// to a member who is actually earning 2.5x on their weekly was a lie the embed
// could never fix.
//
// So we drop the multiplier from the member line entirely and show distance to
// the next rank instead. That is both accurate and the thing that actually
// motivates: a 100 XP quest visibly moves the bar.
const RANK_PROGRESS_SEGMENTS = 10;

function buildRankProgressBar(xp, nextTier) {
  const currentTier = getRankForXp(xp);
  if (!nextTier) return "▰".repeat(RANK_PROGRESS_SEGMENTS);

  const span = nextTier.xpNeeded - currentTier.xpNeeded;
  const into = Math.max(0, (Number(xp) || 0) - currentTier.xpNeeded);
  const ratio = span > 0 ? Math.min(1, into / span) : 1;
  const filled = Math.min(
    RANK_PROGRESS_SEGMENTS,
    Math.max(0, Math.round(ratio * RANK_PROGRESS_SEGMENTS))
  );
  return "▰".repeat(filled) + "▱".repeat(RANK_PROGRESS_SEGMENTS - filled);
}

/** e.g. `▰▰▰▱▱▱▱▱▱▱ 26% → Onyx (39,950 XP)` */
function formatRankProgress(xp, nextTierOverride = null) {
  const numericXp = Number(xp) || 0;
  const tier = getRankForXp(numericXp);
  const next = nextTierOverride || getNextRankTier(tier.name);

  if (!next) {
    return "▰▰▰▰▰▰▰▰▰▰ **Max rank reached**";
  }

  const span = next.xpNeeded - tier.xpNeeded;
  const into = Math.max(0, numericXp - tier.xpNeeded);
  const pct = span > 0 ? Math.min(100, Math.floor((into / span) * 100)) : 100;
  const remaining = Math.max(0, next.xpNeeded - numericXp);

  return `${buildRankProgressBar(numericXp, next)} ${pct}% → ${formatRankName(next.name)} (${remaining.toLocaleString()} XP)`;
}

/** Tenure-stream XP for a member row (safe to call before the split is applied). */
function getTenureRankXp(member = {}) {
  const tenureXp = Number(member.tenure_xp);
  const bonusXp = Number(member.bonus_xp) || 0;
  // Legacy rows (and rows written before the split) have no tenure_xp yet —
  // fall back to the stored total so nothing reads as 0 during/after migration.
  return Number.isFinite(tenureXp) && tenureXp > 0
    ? tenureXp
    : Math.max(0, (Number(member.xp) || 0) - bonusXp);
}

/** Total XP is the ONLY place the two streams meet: tenure + bonus. */
function getTotalRankXp(member = {}) {
  return getTenureRankXp(member) + (Number(member.bonus_xp) || 0);
}

function formatTenureDuration(days) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  const years = Math.floor(d / 365);
  const months = Math.floor((d % 365) / 30);
  const remDays = d - years * 365 - months * 30;
  const parts = [];
  if (years > 0) parts.push(`${years}y`);
  if (months > 0) parts.push(`${months}m`);
  if (remDays > 0 || parts.length === 0) parts.push(`${remDays}d`);
  const short = parts.join(" ");
  const total = `${d}d`;
  // Avoid "17d (17d)" for anything under a month — the two halves matched.
  return short === total ? total : `${short} (${total})`;
}

/**
 * Simulates a member's tenure day-by-day from `joinedDate` up to `asOfDate`.
 * Awards Weekly (every 7 days), Monthly (every 30 days), and Yearly (every 365 days) XP
 * using the progressive rank multiplier as they cross each rank threshold.
 */
function calculateTenureProgression(joinedDate, asOfDate = new Date(), prevAwards = {}) {
  const joined = parseJoinedDate(joinedDate);
  const asOf = parseJoinedDate(asOfDate) || parseJoinedDate(new Date());
  if (!joined || !asOf) {
    return {
      totalDays: 0,
      xp: 0,
      eligibleRank: RANK_TIERS[0],
      weeksAwarded: 0,
      monthsAwarded: 0,
      yearsAwarded: 0,
      newEvents: [],
    };
  }

  const totalDays = Math.max(0, Math.floor((asOf.utcMs - joined.utcMs) / MS_PER_DAY));
  const prevWeeks = Number(prevAwards.weeks_awarded ?? prevAwards.weeksAwarded ?? 0);
  const prevMonths = Number(prevAwards.months_awarded ?? prevAwards.monthsAwarded ?? 0);
  const prevYears = Number(prevAwards.years_awarded ?? prevAwards.yearsAwarded ?? 0);

  let xp = 0;
  const newEvents = [];

  for (let day = 1; day <= totalDays; day++) {
    const milestoneDateIso = new Date(joined.utcMs + day * MS_PER_DAY).toISOString().slice(0, 10);

    // 1. Weekly milestone (every 7 days)
    if (day % 7 === 0) {
      const weekIndex = day / 7;
      const rankBefore = getRankForXp(xp);
      const mult = rankBefore.multiplier ?? 4;
      const xpGained = Math.round(WEEKLY_BASE_XP * mult);
      xp += xpGained;
      const rankAfter = getRankForXp(xp);

      if (weekIndex > prevWeeks) {
        newEvents.push({
          type: "weekly",
          index: weekIndex,
          day,
          date: milestoneDateIso,
          xpGained,
          multiplier: mult,
          rankBefore: rankBefore.name,
          rankAfter: rankAfter.name,
          totalXpAfter: xp,
          reason: `Week #${weekIndex} clan tenure (${WEEKLY_BASE_XP.toLocaleString()} base × ${mult}x ${formatRankName(rankBefore.name)})`,
        });
      }
    }

    // 2. Monthly milestone (every 30 days)
    if (day % 30 === 0) {
      const monthIndex = day / 30;
      const rankBefore = getRankForXp(xp);
      const mult = config.multiplyMonthlyYearly ? (rankBefore.multiplier ?? 4) : 1;
      const xpGained = Math.round(MONTHLY_BASE_XP * mult);
      xp += xpGained;
      const rankAfter = getRankForXp(xp);

      if (monthIndex > prevMonths) {
        newEvents.push({
          type: "monthly",
          index: monthIndex,
          day,
          date: milestoneDateIso,
          xpGained,
          multiplier: mult,
          rankBefore: rankBefore.name,
          rankAfter: rankAfter.name,
          totalXpAfter: xp,
          reason: config.multiplyMonthlyYearly
            ? `Month #${monthIndex} clan tenure (${MONTHLY_BASE_XP.toLocaleString()} base × ${mult}x ${formatRankName(rankBefore.name)})`
            : `Month #${monthIndex} clan tenure bonus (+${MONTHLY_BASE_XP.toLocaleString()} XP)`,
        });
      }
    }

    // 3. Yearly milestone (every 365 days)
    if (day % 365 === 0) {
      const yearIndex = day / 365;
      const rankBefore = getRankForXp(xp);
      const mult = config.multiplyMonthlyYearly ? (rankBefore.multiplier ?? 4) : 1;
      const xpGained = Math.round(YEARLY_BASE_XP * mult);
      xp += xpGained;
      const rankAfter = getRankForXp(xp);

      if (yearIndex > prevYears) {
        newEvents.push({
          type: "yearly",
          index: yearIndex,
          day,
          date: milestoneDateIso,
          xpGained,
          multiplier: mult,
          rankBefore: rankBefore.name,
          rankAfter: rankAfter.name,
          totalXpAfter: xp,
          reason: config.multiplyMonthlyYearly
            ? `Year #${yearIndex} clan tenure (${YEARLY_BASE_XP.toLocaleString()} base × ${mult}x ${formatRankName(rankBefore.name)})`
            : `Year #${yearIndex} clan anniversary bonus (+${YEARLY_BASE_XP.toLocaleString()} XP)`,
        });
      }
    }
  }

  const eligibleRank = getRankForXp(xp);
  return {
    totalDays,
    xp,
    eligibleRank,
    weeksAwarded: Math.floor(totalDays / 7),
    monthsAwarded: Math.floor(totalDays / 30),
    yearsAwarded: Math.floor(totalDays / 365),
    newEvents,
  };
}

// ================= PERMANENT EMBEDS (ONBOARDING & ORIENTATION) =================
function buildPermanentMessage() {
  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle("Welcome — Set Your Server Nickname")
    .setDescription(
      "To get started, your server nickname must match your **exact in-game username**.\n\n" +
      "Click the button below, type your in-game username, and confirm it. " +
      "Double-check your spelling — no extra characters, no typos."
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ID.START)
      .setLabel("Update Server Nickname")
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

// Makes sure exactly one copy of a permanent embed exists in a channel.
// Stateless: it is found by its button custom IDs.
async function ensureEmbedMessage({ channelId, label, buttonIds, payload, what }) {
  const channel = await getChannelById(channelId, label);
  if (!channel) return;

  const recent = await fetchRecentMessages(channel, SCAN_PAGES_PERMANENT);
  const existing = recent.filter((m) => m.author?.id === client.user.id && messageHasButton(m, buttonIds));

  if (existing.length === 0) {
    await channel.send(payload);
    console.log(`[${label}] Posted ${what}.`);
    return;
  }

  // Keep the newest, refresh its content, remove any accidental duplicates.
  const [keep, ...dupes] = existing;
  await keep.edit(payload).catch((e) => console.warn(`[${label}] Could not refresh ${what}:`, e.message));
  for (const d of dupes) {
    await d.delete().catch(() => {});
  }
  console.log(`[${label}] ${what} present${dupes.length ? ` (removed ${dupes.length} duplicate(s))` : ""}.`);
}

async function ensurePermanentMessage() {
  return ensureEmbedMessage({
    channelId: ONBOARDING_CHANNEL_ID,
    label: "Onboarding",
    buttonIds: [ID.START],
    payload: buildPermanentMessage(),
    what: "permanent nickname embed",
  });
}

// ================= ORIENTATION EMBED =================
function buildOrientationMessage() {
  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle("Leadership & Staff Orientation")
    .setDescription(
      "Please read this through, then press the button for your role to confirm you understand and accept your responsibilities.\n\n" +
      "**Chain of Command**\n" +
      "Owners > Leaders > Staff > Jr. Staff\n\n" +
      "Everyone should know who is responsible for what. This structure keeps questions and problems in the right hands, " +
      "so no one ends up handling a constant stream of requests alone. Staff and Jr. Staff are the first point of contact " +
      "for clan members. If something needs to go further up, Staff or Jr. Staff are the ones who bring it to the Leaders."
    )
    .addFields(
      {
        name: "Leaders",
        value:
          "Leaders keep the clan running smoothly and make the core decisions that shape its direction. " +
          "They interview candidates and carry out every promotion to Staff and Jr. Staff. " +
          "When a major issue is beyond what Staff or Jr. Staff can handle, Leaders use their own judgment to resolve it, " +
          "and only Owners can overrule a Leader's decision. " +
          "If you'd like to help shape the clan's future and growth, you're welcome to ask about becoming a Leader.",
      },
      {
        name: "Staff / Jr. Staff",
        value:
          "Staff and Jr. Staff handle the clan's day-to-day work. " +
          "Staff make sure Jr. Staff get the training they need to become full Staff, keep recruitment going, " +
          "and keep the clan chat and Discord relaxed and fun. " +
          "Both should be ready to answer questions and step in when problems come up. " +
          "Staff can remove members from the clan at their discretion; if no Staff or Leaders are online, " +
          "Jr. Staff can make recommendations on how to handle an issue. " +
          "Staff also interview anyone interested in becoming Jr. Staff and working toward Leader or Co-Owner, " +
          "and are free to host events as often as they like to keep the clan engaged.",
      }
    )
    .setFooter({ text: "Only the button matching your current role will work. Accepting never removes any of your existing roles." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID.ORIENT_LEADER).setLabel("I Accept Leader Role").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(ID.ORIENT_STAFF).setLabel("I Accept Staff/Jr. Staff Role").setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

async function ensureOrientationMessage() {
  return ensureEmbedMessage({
    channelId: ORIENTATION_CHANNEL_ID,
    label: "Orientation",
    buttonIds: [ID.ORIENT_LEADER, ID.ORIENT_STAFF],
    payload: buildOrientationMessage(),
    what: "orientation embed",
  });
}

// ================= TEMPORARY VOICE CHANNEL CREATOR =================
const selectedVoiceCategoryByUser = new Map(); // userId -> categoryKey
const voiceCreateLastAtByUser = new Map();     // userId -> timestampMs
const tempVoiceDeleteTimers = new Map();       // channelId -> Timeout

function getVoiceCreateCooldownRemainingMs(userId, nowMs = Date.now()) {
  if (!userId) return 0;
  const lastAt = voiceCreateLastAtByUser.get(userId);
  if (!lastAt) return 0;
  const cooldownMs = config.voiceCreateCooldownMs ?? VOICE_CREATE_COOLDOWN_MS;
  const elapsed = nowMs - lastAt;
  return elapsed < cooldownMs ? cooldownMs - elapsed : 0;
}

function clearVoiceCreateCooldown(userId) {
  if (!userId) voiceCreateLastAtByUser.clear();
  else voiceCreateLastAtByUser.delete(userId);
}

function getVoiceCategoryConfig(keyOrCategoryId) {
  if (!keyOrCategoryId) return null;
  return (
    VOICE_CATEGORIES.find((c) => c.key === keyOrCategoryId || c.categoryId === keyOrCategoryId) || null
  );
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isManagedTempVoiceChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  const cfg = VOICE_CATEGORIES.find((c) => c.categoryId === channel.parentId);
  if (!cfg) return false;
  const pattern = new RegExp(`^${escapeRegex(cfg.prefix)} \\d+$`, "i");
  return pattern.test(String(channel.name || "").trim());
}

function getNonBotVoiceMemberCount(channel) {
  if (!channel || !channel.members) return 0;
  if (typeof channel.members.filter === "function") {
    const filtered = channel.members.filter((m) => !m?.user?.bot);
    return typeof filtered.size === "number" ? filtered.size : (filtered.length || 0);
  }
  if (typeof channel.members.values === "function") {
    let count = 0;
    for (const m of channel.members.values()) {
      if (!m?.user?.bot) count++;
    }
    return count;
  }
  return 0;
}

function clearTempVoiceTimer(channelId) {
  const existing = tempVoiceDeleteTimers.get(channelId);
  if (existing) {
    clearTimeout(existing);
    tempVoiceDeleteTimers.delete(channelId);
  }
}

function scheduleTempVoiceDeletion(channel, customTimeoutMs = null) {
  if (!channel || !isManagedTempVoiceChannel(channel)) return;
  if (getNonBotVoiceMemberCount(channel) > 0) {
    clearTempVoiceTimer(channel.id);
    return;
  }
  if (tempVoiceDeleteTimers.has(channel.id)) return; // Countdown already running

  const timeoutMs = customTimeoutMs ?? (config.voiceEmptyTimeoutMs ?? VOICE_EMPTY_TIMEOUT_MS);
  const timer = setTimeout(async () => {
    tempVoiceDeleteTimers.delete(channel.id);
    try {
      const fresh =
        (await channel.guild?.channels?.fetch?.(channel.id).catch(() => null)) ||
        (await client.channels.fetch(channel.id).catch(() => null));
      if (!fresh || !isManagedTempVoiceChannel(fresh)) return;
      if (getNonBotVoiceMemberCount(fresh) === 0) {
        await fresh.delete("Temporary voice channel empty timeout reached");
        console.log(`[TempVoice] Deleted empty temporary voice channel ${fresh.name} (${fresh.id}).`);
      }
    } catch (err) {
      console.warn(`[TempVoice] Could not auto-delete voice channel ${channel.id}:`, err.message);
    }
  }, timeoutMs);

  if (typeof timer.unref === "function") timer.unref();
  tempVoiceDeleteTimers.set(channel.id, timer);
}

async function scanExistingTempVoiceChannels() {
  for (const guild of client.guilds.cache.values()) {
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    for (const ch of channels.values()) {
      if (ch && isManagedTempVoiceChannel(ch)) {
        if (getNonBotVoiceMemberCount(ch) === 0) {
          scheduleTempVoiceDeletion(ch);
        } else {
          clearTempVoiceTimer(ch.id);
        }
      }
    }
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  const joinedChannel = newState?.channel;
  const leftChannel = oldState?.channel;

  if (joinedChannel && isManagedTempVoiceChannel(joinedChannel)) {
    if (getNonBotVoiceMemberCount(joinedChannel) > 0) {
      clearTempVoiceTimer(joinedChannel.id);
    }
  }

  if (leftChannel && leftChannel.id !== joinedChannel?.id && isManagedTempVoiceChannel(leftChannel)) {
    if (getNonBotVoiceMemberCount(leftChannel) === 0) {
      scheduleTempVoiceDeletion(leftChannel);
    }
  }
}

async function getNextVoiceChannelNumber(guild, cfg) {
  const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
  const usedNumbers = new Set();
  const pattern = new RegExp(`^${escapeRegex(cfg.prefix)} (\\d+)$`, "i");

  for (const ch of channels.values()) {
    if (!ch || ch.type !== ChannelType.GuildVoice) continue;
    if (ch.parentId !== cfg.categoryId) continue;
    const match = String(ch.name || "").trim().match(pattern);
    if (match) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n > 0) usedNumbers.add(n);
    }
  }

  let nextNum = 1;
  while (usedNumbers.has(nextNum)) {
    nextNum++;
  }
  return nextNum;
}

async function createTemporaryVoiceChannel(guild, categoryKey, creatorUser) {
  const cfg = getVoiceCategoryConfig(categoryKey);
  if (!cfg) {
    throw new Error("Invalid voice channel category selected.");
  }

  const nextNum = await getNextVoiceChannelNumber(guild, cfg);
  const channelName = `${cfg.prefix} ${nextNum}`;

  const created = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: cfg.categoryId,
    reason: `Temporary voice channel created by ${creatorUser?.tag || creatorUser?.id || "member"}`,
  });

  // Explicitly sync permissions with the parent category
  if (typeof created.lockPermissions === "function") {
    await created.lockPermissions().catch((e) => {
      console.warn(`[TempVoice] Could not lockPermissions on ${created.id}:`, e.message);
    });
  }

  // Start the 60-second initial empty timer until someone connects
  const initialTimeoutMs = config.voiceInitialEmptyTimeoutMs ?? VOICE_INITIAL_EMPTY_TIMEOUT_MS;
  scheduleTempVoiceDeletion(created, initialTimeoutMs);
  console.log(`[TempVoice] Created ${channelName} (${created.id}) under ${cfg.label}.`);
  return { channel: created, category: cfg, channelName };
}

function buildVoiceCreatorMessage() {
  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle("Create a Temporary Voice Channel")
    .setDescription(
      "Need a voice channel? Pick a category from the dropdown menu below and click **Confirm & Create Voice Channel**.\n\n" +
      "• **Social Hub** ➔ `Social Voice 1, 2, 3…`\n" +
      "• **Old School Runescape** ➔ `OSRS Voice 1, 2, 3…`\n" +
      "• **Other Games** ➔ `Other Games Voice 1, 2, 3…`\n\n" +
      "Permissions are automatically synced with the category. Channels auto-delete **after 60 seconds if nobody joins**, or **5 minutes after the last person disconnects** (1 channel per user every 5 minutes)."
    );

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(ID.VOICE_CATEGORY_SELECT)
    .setPlaceholder("Select a category for your voice channel...")
    .addOptions(
      VOICE_CATEGORIES.map((c) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(c.label)
          .setValue(c.key)
          .setDescription(c.description)
      )
    );

  const selectRow = new ActionRowBuilder().addComponents(selectMenu);
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ID.VOICE_CREATE_CONFIRM)
      .setLabel("Confirm & Create Voice Channel")
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [selectRow, buttonRow] };
}

async function ensureVoiceCreatorMessage() {
  return ensureEmbedMessage({
    channelId: CREATE_VOICE_CHANNEL_ID,
    label: "TempVoice",
    buttonIds: [ID.VOICE_CATEGORY_SELECT, ID.VOICE_CREATE_CONFIRM],
    payload: buildVoiceCreatorMessage(),
    what: "permanent temporary voice creator embed",
  });
}

// ================= WEEKLY EVENTS: SKILL OF THE WEEK & BOSS OF THE WEEK =================
const weeklyEventsMemoryStore = new Map(); // weekKey -> state object

function normalizeHiscoreName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ");
}

function getEligibleBosses(asOfDate = new Date()) {
  const d = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  const asOfIso = d.toISOString().slice(0, 10);
  return OSRS_BOSSES.filter((b) => !b.unlockAfter || asOfIso >= b.unlockAfter);
}

// Deterministic seeded PRNG (Mulberry32) so weekly random picks remain identical across restarts
function createSeededRng(seedInt) {
  let a = seedInt >>> 0;
  return function nextRand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, seedInt) {
  const arr = [...items];
  const rand = createSeededRng(seedInt);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickWeeklyEventTarget(eventType, typeCycleIndex, asOfDate = new Date()) {
  const pool = eventType === "sotw" ? OSRS_SKILLS : getEligibleBosses(asOfDate);
  if (pool.length === 0) return null;

  const cycleLen = pool.length;
  const idx = Math.max(0, Number(typeCycleIndex) || 0);
  const passNumber = Math.floor(idx / cycleLen);
  const posInPass = idx % cycleLen;

  const baseSeed = eventType === "sotw" ? 0x534f5457 : 0x424f5457; // "SOTW" / "BOTW"
  const shuffled = seededShuffle(pool, baseSeed + passNumber * 1009);

  // Prevent boundary back-to-back repeat between consecutive passes
  if (passNumber > 0) {
    const prevShuffled = seededShuffle(pool, baseSeed + (passNumber - 1) * 1009);
    const prevLast = prevShuffled[prevShuffled.length - 1];
    if (shuffled[0]?.name === prevLast?.name && shuffled.length > 1) {
      [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
    }
  }

  return shuffled[posInPass] || shuffled[0];
}

// Convert a calendar date & wall-clock time in America/Chicago (CST/CDT) into exact UTC milliseconds
function centralTimeToUtcMs(year, month, day, hour = 0, minute = 0, second = 0) {
  const targetWallUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: WEEKLY_EVENTS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const getOffsetAt = (utcMs) => {
    const parts = {};
    for (const p of formatter.formatToParts(new Date(utcMs))) {
      if (p.type !== "literal") parts[p.type] = Number(p.value);
    }
    const wallAtUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    return wallAtUtc - utcMs;
  };

  const firstGuess = targetWallUtc - getOffsetAt(targetWallUtc);
  return targetWallUtc - getOffsetAt(firstGuess);
}

function addCalendarDays(year, month, day, daysToAdd) {
  const d = new Date(Date.UTC(year, month - 1, day + daysToAdd));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    isoDate: d.toISOString().slice(0, 10),
  };
}

function getWeekWindowByIndex(weekIndex) {
  const startCal = addCalendarDays(
    WEEKLY_EVENTS_ANCHOR_DATE.year,
    WEEKLY_EVENTS_ANCHOR_DATE.month,
    WEEKLY_EVENTS_ANCHOR_DATE.day,
    weekIndex * 7
  );
  const endCal = addCalendarDays(
    WEEKLY_EVENTS_ANCHOR_DATE.year,
    WEEKLY_EVENTS_ANCHOR_DATE.month,
    WEEKLY_EVENTS_ANCHOR_DATE.day,
    weekIndex * 7 + 6
  );

  // Each event runs Friday 00:00 Central -> Thursday 23:59 Central (switches at 23:59 Thursday night Central)
  const startsAtMs = centralTimeToUtcMs(startCal.year, startCal.month, startCal.day, 0, 0, 0);
  const endsAtMs = centralTimeToUtcMs(endCal.year, endCal.month, endCal.day, 23, 59, 0);

  const eventType = weekIndex % 2 === 0 ? "sotw" : "botw";
  const typeCycleIndex = Math.floor(weekIndex / 2);
  const target = pickWeeklyEventTarget(eventType, typeCycleIndex, new Date(startsAtMs));
  const startIsoDate = startCal.isoDate;
  const weekKey = `week_${weekIndex}_${eventType}_${startIsoDate}`;

  return {
    weekIndex,
    weekKey,
    eventType,
    typeCycleIndex,
    targetName: target ? target.name : eventType === "sotw" ? "Mining" : "Barrows",
    targetConfig: target,
    startsAtMs,
    endsAtMs,
    startsAtIso: new Date(startsAtMs).toISOString(),
    endsAtIso: new Date(endsAtMs).toISOString(),
  };
}

function getWeeklyEventSchedule(asOfDate = new Date()) {
  const nowMs = (asOfDate instanceof Date ? asOfDate : new Date(asOfDate)).getTime();
  const week0 = getWeekWindowByIndex(0);
  const approxWeekMs = 7 * 24 * 60 * 60 * 1000;

  let weekIndex = 0;
  if (nowMs >= week0.startsAtMs) {
    weekIndex = Math.max(0, Math.floor((nowMs - week0.startsAtMs) / approxWeekMs) - 1);
    while (nowMs >= getWeekWindowByIndex(weekIndex).endsAtMs) {
      weekIndex++;
    }
  }

  const current = getWeekWindowByIndex(weekIndex);
  const next = getWeekWindowByIndex(weekIndex + 1);
  const previous = weekIndex > 0 ? getWeekWindowByIndex(weekIndex - 1) : null;

  const isRunning = nowMs >= current.startsAtMs && nowMs < current.endsAtMs;
  const isUpcoming = nowMs < current.startsAtMs;

  return {
    nowMs,
    current: {
      ...current,
      isRunning,
      isUpcoming,
    },
    next,
    previous,
    sotw: current.eventType === "sotw" ? { ...current, isRunning, isUpcoming, isCurrentWeek: true } : { ...next, isRunning: false, isUpcoming: true, isCurrentWeek: false },
    botw: current.eventType === "botw" ? { ...current, isRunning, isUpcoming, isCurrentWeek: true } : { ...next, isRunning: false, isUpcoming: true, isCurrentWeek: false },
  };
}

function formatDurationRemaining(ms) {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(clamped / 86400);
  const hours = Math.floor((clamped % 86400) / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

async function fetchPlayerHiscores(rsn) {
  if (typeof config.hiscoreFetcher === "function") {
    return config.hiscoreFetcher(rsn);
  }
  const cleanRsn = String(rsn || "").trim();
  if (!cleanRsn) return null;

  const url = `https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=${encodeURIComponent(cleanRsn)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  if (typeof timeout.unref === "function") timeout.unref();

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Odinheim-Heimdall-DiscordBot/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractHiscoreMetric(hiscoreData, eventType, targetName) {
  if (!hiscoreData || typeof hiscoreData !== "object") return null;

  if (eventType === "sotw") {
    const skillCfg =
      OSRS_SKILLS.find((s) => normalizeHiscoreName(s.name) === normalizeHiscoreName(targetName)) || {
        name: targetName,
        hiscoreNames: [targetName],
      };
    const matchNames = new Set(skillCfg.hiscoreNames.map(normalizeHiscoreName));
    const skills = Array.isArray(hiscoreData.skills) ? hiscoreData.skills : [];
    for (const s of skills) {
      if (matchNames.has(normalizeHiscoreName(s.name))) {
        const xp = Number(s.xp);
        return Number.isFinite(xp) && xp > 0 ? xp : 0;
      }
    }
    return 0;
  }

  // Boss of the Week
  const bossCfg =
    OSRS_BOSSES.find((b) => normalizeHiscoreName(b.name) === normalizeHiscoreName(targetName)) || {
      name: targetName,
      hiscoreNames: [targetName],
    };
  const matchNames = new Set(bossCfg.hiscoreNames.map(normalizeHiscoreName));
  const activities = Array.isArray(hiscoreData.activities) ? hiscoreData.activities : [];
  let totalKills = 0;
  for (const act of activities) {
    if (matchNames.has(normalizeHiscoreName(act.name))) {
      const score = Number(act.score);
      if (Number.isFinite(score) && score > 0) {
        totalKills += score;
      }
    }
  }
  return totalKills;
}

async function loadWeeklyEventState(supabase, weekInfo) {
  const weekKey = weekInfo.weekKey;
  if (weeklyEventsMemoryStore.has(weekKey)) {
    return weeklyEventsMemoryStore.get(weekKey);
  }

  const defaultState = {
    weekKey,
    weekIndex: weekInfo.weekIndex,
    eventType: weekInfo.eventType,
    targetName: weekInfo.targetName,
    startsAtIso: weekInfo.startsAtIso,
    endsAtIso: weekInfo.endsAtIso,
    baselines: {},
    standings: [],
    lastPolledAt: null,
  };

  if (!supabase) {
    weeklyEventsMemoryStore.set(weekKey, defaultState);
    return defaultState;
  }

  // 1. Try reading from public.weekly_events table
  try {
    const { data, error } = await supabase
      .from("weekly_events")
      .select("*")
      .eq("week_key", weekKey)
      .maybeSingle?.();
    if (!error && data) {
      const loaded = {
        weekKey,
        weekIndex: weekInfo.weekIndex,
        eventType: data.event_type || weekInfo.eventType,
        targetName: data.target_name || weekInfo.targetName,
        startsAtIso: weekInfo.startsAtIso,
        endsAtIso: weekInfo.endsAtIso,
        baselines: data.baselines && typeof data.baselines === "object" ? data.baselines : {},
        standings: Array.isArray(data.standings) ? data.standings : [],
        lastPolledAt: data.last_polled_at || null,
      };
      weeklyEventsMemoryStore.set(weekKey, loaded);
      return loaded;
    }
  } catch {}

  // 2. Fallback: read latest snapshot from xp_rank_logs if weekly_events table hasn't been created yet
  try {
    const { data: logs } = await supabase
      .from("xp_rank_logs")
      .select("*")
      .eq("event_type", "weekly_event_state")
      .eq("rsn", weekKey)
      .order("created_at", { ascending: false })
      .limit(1);
    if (logs && logs.length > 0 && logs[0].reason) {
      const parsed = JSON.parse(logs[0].reason);
      if (parsed && typeof parsed === "object") {
        const loaded = {
          ...defaultState,
          baselines: parsed.baselines || {},
          standings: Array.isArray(parsed.standings) ? parsed.standings : [],
          lastPolledAt: parsed.lastPolledAt || null,
        };
        weeklyEventsMemoryStore.set(weekKey, loaded);
        return loaded;
      }
    }
  } catch {}

  weeklyEventsMemoryStore.set(weekKey, defaultState);
  return defaultState;
}

async function saveWeeklyEventState(supabase, state) {
  weeklyEventsMemoryStore.set(state.weekKey, state);
  if (!supabase) return;

  const nowIso = new Date().toISOString();
  try {
    const { error } = await supabase.from("weekly_events").upsert(
      {
        week_key: state.weekKey,
        week_index: state.weekIndex,
        event_type: state.eventType,
        target_name: state.targetName,
        starts_at: state.startsAtIso,
        ends_at: state.endsAtIso,
        baselines: state.baselines || {},
        standings: state.standings || [],
        last_polled_at: state.lastPolledAt || nowIso,
        updated_at: nowIso,
      },
      { onConflict: "week_key" }
    );
    if (!error) return;
  } catch {}

  // Fallback persistence into xp_rank_logs if weekly_events table does not exist yet
  try {
    await supabase.from("xp_rank_logs").insert({
      rsn: state.weekKey,
      event_type: "weekly_event_state",
      xp_delta: 0,
      total_xp: (state.standings || []).length,
      old_rank: state.eventType,
      new_rank: state.targetName,
      reason: JSON.stringify({
        baselines: state.baselines || {},
        standings: state.standings || [],
        lastPolledAt: state.lastPolledAt || nowIso,
      }),
    });
  } catch {}
}

async function pollWeeklyEventHiscores(weekInfo, members, existingState, nowDate = new Date()) {
  const activeMembers = (members || []).filter((m) => m && m.active !== false && String(m.rsn || "").trim());
  const baselines = { ...(existingState?.baselines || {}) };
  const standings = [];

  for (const member of activeMembers) {
    const rsn = String(member.rsn).trim();
    const key = rsn.toLowerCase();
    const hiscoreData = await fetchPlayerHiscores(rsn);

    let currentVal = null;
    if (hiscoreData) {
      currentVal = extractHiscoreMetric(hiscoreData, weekInfo.eventType, weekInfo.targetName);
    }

    if (currentVal === null) {
      // If HiScores lookup failed temporarily, keep previous baseline/current value if known
      const prev = baselines[key];
      if (prev && typeof prev.startValue === "number" && typeof prev.currentValue === "number") {
        const gained = Math.max(0, prev.currentValue - prev.startValue);
        if (gained > 0) {
          standings.push({
            rsn: prev.rsn || rsn,
            startValue: prev.startValue,
            currentValue: prev.currentValue,
            gained,
          });
        }
      }
      continue;
    }

    if (!baselines[key] || typeof baselines[key].startValue !== "number") {
      baselines[key] = {
        rsn,
        startValue: currentVal,
        currentValue: currentVal,
      };
    } else {
      baselines[key] = {
        rsn,
        startValue: baselines[key].startValue,
        currentValue: currentVal,
      };
    }

    const gained = Math.max(0, baselines[key].currentValue - baselines[key].startValue);
    if (gained > 0) {
      standings.push({
        rsn,
        startValue: baselines[key].startValue,
        currentValue: baselines[key].currentValue,
        gained,
      });
    }
  }

  // Sort strictly descending by earned XP or kills (tie-break by total XP/KC, then RSN)
  standings.sort((a, b) => {
    if (b.gained !== a.gained) return b.gained - a.gained;
    if (b.currentValue !== a.currentValue) return b.currentValue - a.currentValue;
    return a.rsn.localeCompare(b.rsn);
  });

  const nowIso = (nowDate instanceof Date ? nowDate : new Date(nowDate)).toISOString();
  return {
    weekKey: weekInfo.weekKey,
    weekIndex: weekInfo.weekIndex,
    eventType: weekInfo.eventType,
    targetName: weekInfo.targetName,
    startsAtIso: weekInfo.startsAtIso,
    endsAtIso: weekInfo.endsAtIso,
    baselines,
    standings,
    lastPolledAt: nowIso,
  };
}

function formatWeeklyStandingsLines(standings, eventType) {
  if (!standings || standings.length === 0) {
    return eventType === "sotw"
      ? "*No clan members have earned XP in this skill yet this week. Only members who gain XP are listed here!*"
      : "*No clan members have recorded kills for this boss yet this week. Only members who earn kills are listed here!*";
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = standings.slice(0, 25).map((entry, idx) => {
    const rankPrefix = idx < 3 ? `${medals[idx]} ` : `\`#${idx + 1}\` `;
    if (eventType === "sotw") {
      return `${rankPrefix}**${entry.rsn}** — **+${entry.gained.toLocaleString()} XP** *(Total: ${entry.currentValue.toLocaleString()} XP)*`;
    }
    const unit = entry.gained === 1 ? "Kill" : "Kills";
    return `${rankPrefix}**${entry.rsn}** — **+${entry.gained.toLocaleString()} ${unit}** *(Total: ${entry.currentValue.toLocaleString()} KC)*`;
  });

  if (standings.length > 25) {
    lines.push(`*…and ${standings.length - 25} more member(s) with gains this week.*`);
  }
  return lines.join("\n");
}

function getNextTwoHourPollUnix(nowMs, startsAtMs, endsAtMs) {
  if (nowMs < startsAtMs) return Math.floor(startsAtMs / 1000);
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const elapsed = nowMs - startsAtMs;
  const nextPollMs = startsAtMs + (Math.floor(elapsed / twoHoursMs) + 1) * twoHoursMs;
  return Math.floor(Math.min(nextPollMs, endsAtMs) / 1000);
}

function buildSotwEmbedPayload(schedule, currentState, previousSotwState = null) {
  const isCurrentSotw = schedule.current.eventType === "sotw";
  const sotwInfo = schedule.sotw;
  const startUnix = Math.floor(sotwInfo.startsAtMs / 1000);
  const endUnix = Math.floor(sotwInfo.endsAtMs / 1000);

  if (isCurrentSotw) {
    const isRunning = schedule.current.isRunning;
    const remainingText = formatDurationRemaining(sotwInfo.endsAtMs - schedule.nowMs);
    const standings = currentState?.standings || [];
    const nextPollUnix = getNextTwoHourPollUnix(schedule.nowMs, sotwInfo.startsAtMs, sotwInfo.endsAtMs);
    const lastPollUnix = currentState?.lastPolledAt
      ? Math.floor(new Date(currentState.lastPolledAt).getTime() / 1000)
      : null;

    const timerLines = isRunning
      ? [
          `🟢 **CURRENT RUNNING EVENT:** **${sotwInfo.targetName}** *(Skill of the Week)*`,
          `⏱️ **Running Timer:** Ends <t:${endUnix}:R> (**${remainingText} remaining**)`,
          `📅 **Starts:** <t:${startUnix}:F>`,
          `🏁 **Ends:** <t:${endUnix}:F>`,
        ]
      : [
          `⏳ **SCHEDULED EVENT:** **${sotwInfo.targetName}** *(Skill of the Week)*`,
          `⏱️ **Running Timer:** Starts <t:${startUnix}:R> • Ends <t:${endUnix}:R>`,
          `📅 **Starts:** <t:${startUnix}:F>`,
          `🏁 **Ends:** <t:${endUnix}:F>`,
        ];

    const embed = new EmbedBuilder()
      .setColor(COLOR.ok)
      .setTitle(`Skill of the Week — ${sotwInfo.targetName}`)
      .setDescription(timerLines.join("\n"))
      .addFields(
        {
          name: `Leaderboard — Members With ${sotwInfo.targetName} XP Gained (${standings.length})`,
          value: formatWeeklyStandingsLines(standings, "sotw"),
          inline: false,
        },
        {
          name: "OSRS HiScores Tracking (Every 2 Hours)",
          value:
            (lastPollUnix ? `• **Last Synced:** <t:${lastPollUnix}:R>\n` : "") +
            `• **Next Sync:** <t:${nextPollUnix}:R> (<t:${nextPollUnix}:t>)\n` +
            "• **Next Week's Event:** Boss of the Week",
          inline: false,
        }
      )
      .setFooter({ text: "Odinheim Weekly Events • Official OSRS HiScores • Only members who gained XP are listed" })
      .setTimestamp(new Date(schedule.nowMs));

    return { embeds: [embed], components: [] };
  }

  // Boss of the Week is currently running -> Skill of the Week is Up Next
  const prevStandings = previousSotwState?.standings || [];
  const prevTitleSuffix = previousSotwState?.targetName ? ` (Last SOTW: ${previousSotwState.targetName})` : "";

  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle("Skill of the Week — Up Next")
    .setDescription(
      `⏸️ **Status:** Alternating Week — **Boss of the Week (${schedule.current.targetName})** is currently active!\n` +
      `⏭️ **Next Skill of the Week:** **${sotwInfo.targetName}**\n` +
      `⏱️ **Starts:** <t:${startUnix}:R> (<t:${startUnix}:F>)\n` +
      `🏁 **Ends:** <t:${endUnix}:F>`
    )
    .addFields({
      name: `Previous Skill of the Week Standings${prevTitleSuffix}`,
      value: prevStandings.length > 0
        ? formatWeeklyStandingsLines(prevStandings, "sotw")
        : "*New Skill of the Week leaderboard will begin when the event starts!*",
      inline: false,
    })
    .setFooter({ text: "Odinheim Weekly Events • Alternates weekly between Skill & Boss of the Week" })
    .setTimestamp(new Date(schedule.nowMs));

  return { embeds: [embed], components: [] };
}

function buildBotwEmbedPayload(schedule, currentState, previousBotwState = null) {
  const isCurrentBotw = schedule.current.eventType === "botw";
  const botwInfo = schedule.botw;
  const startUnix = Math.floor(botwInfo.startsAtMs / 1000);
  const endUnix = Math.floor(botwInfo.endsAtMs / 1000);

  if (isCurrentBotw) {
    const isRunning = schedule.current.isRunning;
    const remainingText = formatDurationRemaining(botwInfo.endsAtMs - schedule.nowMs);
    const standings = currentState?.standings || [];
    const nextPollUnix = getNextTwoHourPollUnix(schedule.nowMs, botwInfo.startsAtMs, botwInfo.endsAtMs);
    const lastPollUnix = currentState?.lastPolledAt
      ? Math.floor(new Date(currentState.lastPolledAt).getTime() / 1000)
      : null;

    const timerLines = isRunning
      ? [
          `🟢 **CURRENT RUNNING EVENT:** **${botwInfo.targetName}** *(Boss of the Week)*`,
          `⏱️ **Running Timer:** Ends <t:${endUnix}:R> (**${remainingText} remaining**)`,
          `📅 **Starts:** <t:${startUnix}:F>`,
          `🏁 **Ends:** <t:${endUnix}:F>`,
        ]
      : [
          `⏳ **SCHEDULED EVENT:** **${botwInfo.targetName}** *(Boss of the Week)*`,
          `⏱️ **Running Timer:** Starts <t:${startUnix}:R> • Ends <t:${endUnix}:R>`,
          `📅 **Starts:** <t:${startUnix}:F>`,
          `🏁 **Ends:** <t:${endUnix}:F>`,
        ];

    const embed = new EmbedBuilder()
      .setColor(COLOR.gold)
      .setTitle(`Boss of the Week — ${botwInfo.targetName}`)
      .setDescription(timerLines.join("\n"))
      .addFields(
        {
          name: `Leaderboard — Members With ${botwInfo.targetName} Kills Earned (${standings.length})`,
          value: formatWeeklyStandingsLines(standings, "botw"),
          inline: false,
        },
        {
          name: "OSRS HiScores Tracking (Every 2 Hours)",
          value:
            (lastPollUnix ? `• **Last Synced:** <t:${lastPollUnix}:R>\n` : "") +
            `• **Next Sync:** <t:${nextPollUnix}:R> (<t:${nextPollUnix}:t>)\n` +
            "• **Next Week's Event:** Skill of the Week",
          inline: false,
        }
      )
      .setFooter({ text: "Odinheim Weekly Events • Official OSRS HiScores • Only members who earned kills are listed" })
      .setTimestamp(new Date(schedule.nowMs));

    return { embeds: [embed], components: [] };
  }

  // Skill of the Week is currently running -> Boss of the Week is Up Next
  const prevStandings = previousBotwState?.standings || [];
  const prevTitleSuffix = previousBotwState?.targetName ? ` (Last BOTW: ${previousBotwState.targetName})` : "";

  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle("Boss of the Week — Up Next")
    .setDescription(
      `⏸️ **Status:** Alternating Week — **Skill of the Week (${schedule.current.targetName})** is currently active!\n` +
      `⏭️ **Next Boss of the Week:** **${botwInfo.targetName}**\n` +
      `⏱️ **Starts:** <t:${startUnix}:R> (<t:${startUnix}:F>)\n` +
      `🏁 **Ends:** <t:${endUnix}:F>`
    )
    .addFields({
      name: `Previous Boss of the Week Standings${prevTitleSuffix}`,
      value: prevStandings.length > 0
        ? formatWeeklyStandingsLines(prevStandings, "botw")
        : "*Boss of the Week leaderboard will begin when BOTW starts!*",
      inline: false,
    })
    .setFooter({ text: "Odinheim Weekly Events • Alternates weekly between Skill & Boss of the Week" })
    .setTimestamp(new Date(schedule.nowMs));

  return { embeds: [embed], components: [] };
}

function isSotwPermanentMessage(message) {
  if (!message || message.author?.id !== client.user?.id) return false;
  const title = message.embeds?.[0]?.title || "";
  return title.startsWith("Skill of the Week");
}

function isBotwPermanentMessage(message) {
  if (!message || message.author?.id !== client.user?.id) return false;
  const title = message.embeds?.[0]?.title || "";
  return title.startsWith("Boss of the Week");
}

async function ensureWeeklyEventsMessages(sotwPayload, botwPayload) {
  const channel = await getChannelById(WEEKLY_EVENTS_CHANNEL_ID, "WeeklyEvents");
  if (!channel) return;

  const recent = await fetchRecentMessages(channel, SCAN_PAGES_PERMANENT);
  const myMessages = recent
    .filter((m) => isSotwPermanentMessage(m) || isBotwPermanentMessage(m))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp); // Oldest first (top-to-bottom in Discord)

  if (myMessages.length >= 2) {
    const [firstMsg, secondMsg, ...dupes] = myMessages;
    await firstMsg.edit(sotwPayload).catch((e) => console.warn("[WeeklyEvents] Could not edit SOTW message:", e.message));
    await secondMsg.edit(botwPayload).catch((e) => console.warn("[WeeklyEvents] Could not edit BOTW message:", e.message));
    for (const d of dupes) {
      await d.delete().catch(() => {});
    }
    return;
  }

  for (const m of myMessages) {
    await m.delete().catch(() => {});
  }
  await channel.send(sotwPayload).catch((e) => console.warn("[WeeklyEvents] Could not send SOTW message:", e.message));
  await channel.send(botwPayload).catch((e) => console.warn("[WeeklyEvents] Could not send BOTW message:", e.message));
  console.log("[WeeklyEvents] Posted permanent Skill of the Week and Boss of the Week embeds.");
}

let weeklyEventsSyncInFlight = false;
let activeWeeklyEventKey = null;
let lastTwoHourSlotPolled = null;

async function syncWeeklyEvents(asOfDate = new Date(), options = {}) {
  if (weeklyEventsSyncInFlight) return null;
  weeklyEventsSyncInFlight = true;
  try {
    const nowDate = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
    const schedule = getWeeklyEventSchedule(nowDate);
    const supabase = getSupabase();

    let members = options.members || null;
    if (!members && supabase) {
      const { data } = await supabase
        .from("clan_members")
        .select("*")
        .eq("active", true);
      members = data || [];
    }

    let currentState = await loadWeeklyEventState(supabase, schedule.current);
    const prevState = schedule.previous ? await loadWeeklyEventState(supabase, schedule.previous) : null;

    const shouldPollHiscores =
      schedule.current.isRunning &&
      (options.forcePoll === true ||
        !currentState.lastPolledAt ||
        Object.keys(currentState.baselines || {}).length === 0);

    if (shouldPollHiscores && members && members.length > 0) {
      currentState = await pollWeeklyEventHiscores(schedule.current, members, currentState, nowDate);
      await saveWeeklyEventState(supabase, currentState);
    }

    const prevSotwState =
      schedule.previous?.eventType === "sotw" ? prevState : null;
    const prevBotwState =
      schedule.previous?.eventType === "botw" ? prevState : null;

    const sotwPayload = buildSotwEmbedPayload(schedule, currentState, prevSotwState);
    const botwPayload = buildBotwEmbedPayload(schedule, currentState, prevBotwState);

    await ensureWeeklyEventsMessages(sotwPayload, botwPayload);
    activeWeeklyEventKey = schedule.current.weekKey;

    return {
      schedule,
      currentState,
      sotwPayload,
      botwPayload,
    };
  } finally {
    weeklyEventsSyncInFlight = false;
  }
}

let weeklyEventsTimer = null;

function startWeeklyEventsLoop() {
  if (weeklyEventsTimer) clearInterval(weeklyEventsTimer);

  // Check every 60 seconds for:
  //   1. Thursday 23:59 event rollover (switching between Skill of the Week and Boss of the Week)
  //   2. Every 2-hour OSRS HiScores poll starting at 00:00 Friday morning (00:00, 02:00, 04:00, ..., 22:00)
  weeklyEventsTimer = setInterval(async () => {
    try {
      const now = new Date();
      const schedule = getWeeklyEventSchedule(now);
      const twoHoursMs = config.weeklyEventPollIntervalMs ?? WEEKLY_EVENT_POLL_INTERVAL_MS;

      const weekSwitched = activeWeeklyEventKey && activeWeeklyEventKey !== schedule.current.weekKey;
      const currentSlot =
        schedule.nowMs >= schedule.current.startsAtMs
          ? `${schedule.current.weekKey}_slot_${Math.floor((schedule.nowMs - schedule.current.startsAtMs) / twoHoursMs)}`
          : `${schedule.current.weekKey}_prestart`;

      const slotChanged = currentSlot !== lastTwoHourSlotPolled && schedule.nowMs >= schedule.current.startsAtMs;

      if (weekSwitched || slotChanged) {
        lastTwoHourSlotPolled = currentSlot;
        await syncWeeklyEvents(now, { forcePoll: true });
      }
    } catch (err) {
      console.error("[WeeklyEvents] Loop error:", err.message);
    }
  }, 60 * 1000);

  if (typeof weeklyEventsTimer.unref === "function") weeklyEventsTimer.unref();
}

// ================= RANKING SYSTEM: GROWTH CHART, PERMANENT RANK LIST, ALERTS & LOGS =================
const SHORT_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const FONT_5X7 = {
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "3": ["11110","00001","00001","01110","00001","00001","11110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["00110","01000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00010","01100"],
  "A": ["01110","10001","10001","11111","10001","10001","10001"],
  "B": ["11110","10001","10001","11110","10001","10001","11110"],
  "C": ["01110","10001","10000","10000","10000","10001","01110"],
  "D": ["11100","10010","10001","10001","10001","10010","11100"],
  "E": ["11111","10000","10000","11110","10000","10000","11111"],
  "F": ["11111","10000","10000","11110","10000","10000","10000"],
  "G": ["01110","10001","10000","10111","10001","10001","01110"],
  "H": ["10001","10001","10001","11111","10001","10001","10001"],
  "I": ["01110","00100","00100","00100","00100","00100","01110"],
  "J": ["00111","00010","00010","00010","00010","10010","01100"],
  "K": ["10001","10010","10100","11000","10100","10010","10001"],
  "L": ["10000","10000","10000","10000","10000","10000","11111"],
  "M": ["10001","11011","10101","10101","10001","10001","10001"],
  "N": ["10001","11001","10101","10011","10001","10001","10001"],
  "O": ["01110","10001","10001","10001","10001","10001","01110"],
  "P": ["11110","10001","10001","11110","10000","10000","10000"],
  "Q": ["01110","10001","10001","10001","10101","10010","01101"],
  "R": ["11110","10001","10001","11110","10100","10010","10001"],
  "S": ["01111","10000","10000","01110","00001","00001","11110"],
  "T": ["11111","00100","00100","00100","00100","00100","00100"],
  "U": ["10001","10001","10001","10001","10001","10001","01110"],
  "V": ["10001","10001","10001","10001","10001","01010","00100"],
  "W": ["10001","10001","10001","10101","10101","11011","10001"],
  "X": ["10001","10001","01010","00100","01010","10001","10001"],
  "Y": ["10001","10001","01010","00100","00100","00100","00100"],
  "Z": ["11111","00001","00010","00100","01000","10000","11111"],
  "-": ["00000","00000","00000","11111","00000","00000","00000"],
  "+": ["00000","00100","00100","11111","00100","00100","00000"],
  "/": ["00001","00010","00010","00100","01000","01000","10000"],
  ":": ["00000","00100","00100","00000","00100","00100","00000"],
  ".": ["00000","00000","00000","00000","00000","00100","00100"],
  "'": ["00100","00100","00000","00000","00000","00000","00000"],
  "(": ["00010","00100","01000","01000","01000","00100","00010"],
  ")": ["01000","00100","00010","00010","00010","00100","01000"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
};

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", compressed),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function formatShortChartDate(isoDate, spanDays = 30) {
  const parsed = parseJoinedDate(isoDate);
  if (!parsed) return String(isoDate || "");
  const [y, m, d] = parsed.iso.split("-").map(Number);
  const mon = SHORT_MONTHS[(m || 1) - 1] || "JAN";
  if (spanDays > 150) {
    return `${mon} '${String(y).slice(-2)}`;
  }
  return `${mon} ${d}`;
}

/**
 * Builds the chronological daily growth snapshot series from `CLAN_CREATION_DATE` through `asOfDate`,
 * combining member join/departure dates from `clan_members` with any explicit snapshots in `clan_growth_history`.
 */
function buildGrowthSeries(members = [], recordedSnapshots = [], asOfDate = new Date()) {
  const asOfParsed = parseJoinedDate(asOfDate) || parseJoinedDate(new Date());
  const todayIso = asOfParsed ? asOfParsed.iso : CLAN_CREATION_DATE;

  const normalizedMembers = (members || [])
    .map((m) => {
      const pJoin = parseJoinedDate(m.joined_date);
      if (!pJoin) return null;
      const joinedIso = pJoin.iso < CLAN_CREATION_DATE ? CLAN_CREATION_DATE : pJoin.iso;
      const pLeft = m.active === false && m.left_at ? parseJoinedDate(m.left_at) : null;
      return {
        rsn: m.rsn,
        active: m.active !== false,
        joinedIso,
        leftIso: pLeft ? pLeft.iso : null,
      };
    })
    .filter(Boolean);

  const snapshotByDate = new Map();
  for (const snap of recordedSnapshots || []) {
    const p = parseJoinedDate(snap.recorded_date);
    if (!p) continue;
    const iso = p.iso < CLAN_CREATION_DATE ? CLAN_CREATION_DATE : p.iso;
    snapshotByDate.set(iso, snap);
  }

  const dateSet = new Set([CLAN_CREATION_DATE]);
  if (todayIso >= CLAN_CREATION_DATE) dateSet.add(todayIso);

  for (const m of normalizedMembers) {
    if (m.joinedIso >= CLAN_CREATION_DATE && m.joinedIso <= todayIso) {
      dateSet.add(m.joinedIso);
    }
    if (m.leftIso && m.leftIso >= CLAN_CREATION_DATE && m.leftIso <= todayIso) {
      dateSet.add(m.leftIso);
    }
  }
  for (const iso of snapshotByDate.keys()) {
    if (iso >= CLAN_CREATION_DATE && iso <= todayIso) {
      dateSet.add(iso);
    }
  }

  const sortedDates = Array.from(dateSet).sort();
  const series = [];
  let prevActive = 0;

  for (const dateIso of sortedDates) {
    const joinedMembers = normalizedMembers.filter((m) => m.joinedIso === dateIso).map((m) => m.rsn);
    const leftMembers = normalizedMembers.filter((m) => !m.active && m.leftIso === dateIso).map((m) => m.rsn);
    const computedActive = normalizedMembers.filter(
      (m) => m.joinedIso <= dateIso && (m.active || !m.leftIso || m.leftIso > dateIso)
    ).length;

    const recorded = snapshotByDate.get(dateIso);
    const activeMembers =
      recorded && typeof recorded.active_members === "number" && recorded.active_members > 0
        ? Math.max(recorded.active_members, computedActive)
        : computedActive;

    const delta = activeMembers - prevActive;
    const membersJoined =
      joinedMembers.length > 0
        ? joinedMembers.length
        : recorded?.members_joined ?? (delta > 0 ? delta : 0);
    const membersLeft =
      leftMembers.length > 0
        ? leftMembers.length
        : recorded?.members_left ?? (delta < 0 ? Math.abs(delta) : 0);

    series.push({
      date: dateIso,
      activeMembers,
      membersJoined,
      membersLeft,
      joinedNames: joinedMembers,
      leftNames: leftMembers,
      note: recorded?.note || null,
    });
    prevActive = activeMembers;
  }

  return series;
}

/**
 * Filters a growth series by time window ("30d", "6m", or "all") and downsamples
 * to at most `maxPoints` evenly spaced snapshots so the chart stays clean over months and years.
 */
function filterAndDownsampleGrowth(series = [], rangeKey = "all", asOfDate = new Date(), maxPoints = 10) {
  if (!series || series.length === 0) {
    return {
      points: [{ date: CLAN_CREATION_DATE, label: "OCT 11", activeMembers: 0, membersJoined: 0, membersLeft: 0 }],
      rangeLabel: "ALL-TIME",
      spanDays: 1,
    };
  }

  const asOfParsed = parseJoinedDate(asOfDate) || parseJoinedDate(new Date());
  const asOfMs = asOfParsed ? asOfParsed.utcMs : Date.now();
  const windowDays = rangeKey === "30d" ? 30 : rangeKey === "6m" ? 180 : null;
  const rangeLabel = rangeKey === "30d" ? "LAST 30 DAYS" : rangeKey === "6m" ? "LAST 6 MONTHS" : "ALL-TIME";

  let filtered = series;
  if (windowDays !== null) {
    const cutoffIso = new Date(asOfMs - windowDays * MS_PER_DAY).toISOString().slice(0, 10);
    filtered = series.filter((s) => s.date >= cutoffIso);
    if (filtered.length === 0) {
      filtered = series.slice(-1);
    }
  }

  const firstParsed = parseJoinedDate(filtered[0].date);
  const lastParsed = parseJoinedDate(filtered[filtered.length - 1].date);
  const spanDays =
    firstParsed && lastParsed ? Math.max(1, Math.round((lastParsed.utcMs - firstParsed.utcMs) / MS_PER_DAY)) : 1;

  let sampled = filtered;
  if (filtered.length > maxPoints) {
    sampled = [];
    for (let i = 0; i < maxPoints; i++) {
      const idx = i === maxPoints - 1 ? filtered.length - 1 : Math.round((i * (filtered.length - 1)) / (maxPoints - 1));
      sampled.push(filtered[idx]);
    }
  }

  const points = sampled.map((s) => ({
    ...s,
    label: formatShortChartDate(s.date, spanDays),
  }));

  return { points, rangeLabel, spanDays };
}

function renderGrowthChartPng(points = [], rangeLabel = "ALL-TIME") {
  const W = 800;
  const H = 360;
  const rgba = Buffer.alloc(W * H * 4);

  function blendPixel(x, y, r, g, b, a = 255) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= W || yi < 0 || yi >= H) return;
    const idx = (yi * W + xi) * 4;
    if (a >= 255) {
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    } else {
      const alpha = a / 255;
      rgba[idx] = Math.round(rgba[idx] * (1 - alpha) + r * alpha);
      rgba[idx + 1] = Math.round(rgba[idx + 1] * (1 - alpha) + g * alpha);
      rgba[idx + 2] = Math.round(rgba[idx + 2] * (1 - alpha) + b * alpha);
      rgba[idx + 3] = 255;
    }
  }

  function fillRect(x0, y0, w, h, r, g, b, a = 255) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        blendPixel(x, y, r, g, b, a);
      }
    }
  }

  function drawText(text, x, y, scale, r, g, b, align = "left") {
    const str = String(text).toUpperCase();
    const charW = 6 * scale;
    const totalW = str.length * charW - scale;
    let startX = x;
    if (align === "center") startX = Math.round(x - totalW / 2);
    else if (align === "right") startX = Math.round(x - totalW);

    for (let i = 0; i < str.length; i++) {
      const glyph = FONT_5X7[str[i]] || FONT_5X7[" "];
      const gx = startX + i * charW;
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === "1") {
            fillRect(gx + col * scale, y + row * scale, scale, scale, r, g, b, 255);
          }
        }
      }
    }
  }

  function drawLine(x0, y0, x1, y1, thickness, r, g, b, a = 255) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1) * 2;
    const rad = thickness / 2;
    for (let i = 0; i <= steps; i++) {
      const px = x0 + ((x1 - x0) * i) / steps;
      const py = y0 + ((y1 - y0) * i) / steps;
      for (let dy = -Math.ceil(rad); dy <= Math.ceil(rad); dy++) {
        for (let dx = -Math.ceil(rad); dx <= Math.ceil(rad); dx++) {
          if (dx * dx + dy * dy <= rad * rad) {
            blendPixel(px + dx, py + dy, r, g, b, a);
          }
        }
      }
    }
  }

  function drawCircle(cx, cy, radius, r, g, b, a = 255) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= radius * radius) {
          blendPixel(cx + dx, cy + dy, r, g, b, a);
        }
      }
    }
  }

  fillRect(0, 0, W, H, 15, 23, 42, 255);
  fillRect(16, 16, W - 32, H - 32, 24, 34, 56, 255);

  drawText("ODINHEIM CLAN MEMBER GROWTH", 40, 34, 2, 226, 232, 240, "left");
  drawText(`VIEW: ${rangeLabel}`, W - 40, 34, 2, 96, 165, 250, "right");

  const padL = 76;
  const padR = 48;
  const padT = 78;
  const padB = 64;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const safePoints =
    points.length > 0
      ? points
      : [{ date: CLAN_CREATION_DATE, label: "OCT 11", activeMembers: 0 }];

  const gridTicks = 4;
  const rawTop = Math.max(4, ...safePoints.map((p) => Number(p.activeMembers) || 0)) + 1;
  const tickStep =
    rawTop <= 8 ? 2 : rawTop <= 12 ? 3 : rawTop <= 20 ? 5 : rawTop <= 40 ? 10 : rawTop <= 80 ? 20 : rawTop <= 200 ? 50 : 100;
  const maxY = tickStep * gridTicks;

  for (let i = 0; i <= gridTicks; i++) {
    const val = tickStep * i;
    const y = Math.round(padT + plotH - (val / maxY) * plotH);
    fillRect(padL, y, plotW, 1, 51, 65, 85, 255);
    drawText(String(val), padL - 12, y - 6, 2, 148, 163, 184, "right");
  }

  const coords = safePoints.map((p, idx) => {
    const x =
      safePoints.length === 1
        ? Math.round(padL + plotW / 2)
        : Math.round(padL + (idx / (safePoints.length - 1)) * plotW);
    const val = Number(p.activeMembers) || 0;
    const y = Math.round(padT + plotH - (val / maxY) * plotH);
    return { x, y, ...p, activeMembers: val };
  });

  const baseY = padT + plotH;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i];
    const p1 = coords[i + 1];
    for (let x = p0.x; x <= p1.x; x++) {
      const t = p1.x === p0.x ? 0 : (x - p0.x) / (p1.x - p0.x);
      const topY = Math.round(p0.y + (p1.y - p0.y) * t);
      for (let y = topY; y < baseY; y++) {
        const fade = 1 - (y - topY) / Math.max(1, baseY - topY);
        blendPixel(x, y, 56, 189, 248, Math.round(90 * fade));
      }
    }
  }

  for (let i = 0; i < coords.length - 1; i++) {
    drawLine(coords[i].x, coords[i].y, coords[i + 1].x, coords[i + 1].y, 4, 56, 189, 248, 255);
  }

  for (const c of coords) {
    drawCircle(c.x, c.y, 7, 15, 23, 42, 255);
    drawCircle(c.x, c.y, 5, 56, 189, 248, 255);
    drawText(String(c.activeMembers), c.x, c.y - 22, 2, 248, 250, 252, "center");
    drawText(c.label || c.date, c.x, baseY + 16, 2, 148, 163, 184, "center");
  }

  return encodePng(W, H, rgba);
}

function buildGrowthChartEmbedAndAttachment(
  members = [],
  growthSnapshots = [],
  asOfDate = new Date(),
  rangeKey = config.growthChartRange || "all"
) {
  const fullSeries = buildGrowthSeries(members, growthSnapshots, asOfDate);
  const { points, rangeLabel } = filterAndDownsampleGrowth(fullSeries, rangeKey, asOfDate, 10);
  const pngBuffer = renderGrowthChartPng(points, rangeLabel);
  const attachment = new AttachmentBuilder(pngBuffer, { name: "clan-growth.png" });

  const currentActive = members.filter((m) => m.active !== false).length;
  const peakMembers = Math.max(currentActive, ...fullSeries.map((s) => s.activeMembers));

  // Show the 5 most recent dates where roster changes occurred
  const changeSnapshots = fullSeries.filter((s) => s.membersJoined > 0 || s.membersLeft > 0 || s.date === CLAN_CREATION_DATE);
  const recentSnapshots = (changeSnapshots.length > 0 ? changeSnapshots : fullSeries).slice(-5).reverse();

  const recentLines = recentSnapshots.map((s) => {
    const changeParts = [];
    if (s.membersJoined > 0) {
      const names = s.joinedNames?.length ? `: *${s.joinedNames.slice(0, 4).join(", ")}${s.joinedNames.length > 4 ? "…" : ""}*` : "";
      changeParts.push(`+${s.membersJoined} joined${names}`);
    }
    if (s.membersLeft > 0) {
      const names = s.leftNames?.length ? `: *${s.leftNames.slice(0, 4).join(", ")}${s.leftNames.length > 4 ? "…" : ""}*` : "";
      changeParts.push(`-${s.membersLeft} left${names}`);
    }
    const deltaText = changeParts.length > 0 ? ` (${changeParts.join(", ")})` : "";
    return `• \`${s.date}\` — **${s.activeMembers} members**${deltaText}`;
  });

  const latestChange = recentSnapshots[0];
  const latestDeltaSummary = latestChange
    ? `+${latestChange.membersJoined} joined, -${latestChange.membersLeft} left (\`${latestChange.date}\`)`
    : "No changes recorded yet";

  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle("Odinheim Clan Growth & Roster History")
    .setDescription(
      `**Current Active Members:** \`${currentActive}\` • **All-Time Peak:** \`${peakMembers}\` • **View:** \`${rangeLabel}\`\n` +
      `**Clan Founded:** \`${CLAN_CREATION_DATE}\` • **Latest Roster Change:** ${latestDeltaSummary}\n\n` +
      `**Recent Roster Snapshots:**\n${recentLines.join("\n")}`
    )
    .setImage("attachment://clan-growth.png");

  return { embed, attachment, fullSeries };
}

function buildRankTableSummary() {
  return RANK_TIERS.map((t) => {
    const multText = t.multiplier ? `${t.multiplier}x` : "Max";
    return `${formatRankName(t.name)} (${multText}) — \`${t.xpNeeded.toLocaleString()} XP\``;
  }).join(" • ");
}

function buildRankListPayload(members = [], asOfDate = new Date(), options = {}) {
  const rangeKey = options.range || config.growthChartRange || "all";
  const growthSnapshots = options.growthSnapshots || [];

  const activeMembers = members
    .filter((m) => m.active !== false)
    .slice()
    .sort((a, b) => {
      const xpDiff = getTotalRankXp(b) - getTotalRankXp(a);
      if (xpDiff !== 0) return xpDiff;
      return String(a.rsn || "").localeCompare(String(b.rsn || ""));
    });

  const asOfParsed = parseJoinedDate(asOfDate) || parseJoinedDate(new Date());
  const nowUnix = Math.floor(Date.now() / 1000);

  const { embed: growthEmbed, attachment: growthAttachment } = buildGrowthChartEmbedAndAttachment(
    members,
    growthSnapshots,
    asOfDate,
    rangeKey
  );

  const headerDesc =
    "** Clan Rank Progression & Member Standings**\n" +
    `**Tenure XP:** Weekly \`+${WEEKLY_BASE_XP.toLocaleString()} XP × tenure rank multiplier\` • ` +
    `Monthly \`+${MONTHLY_BASE_XP.toLocaleString()}\` • Yearly \`+${YEARLY_BASE_XP.toLocaleString()}\`\n` +
    `**Honour Marks quests:** flat XP, never multiplied\n` +
    `**Rank** = Tenure XP + Quest XP\n\n` +
    `**Rank Tiers:**\n${buildRankTableSummary()}\n\n` +
    `**Active Clan Members:** \`${activeMembers.length}\` • **Last Synced:** <t:${nowUnix}:R>`;

  const lines = activeMembers.map((m, idx) => {
    // Rank is driven by the COMBINED total (tenure + flat quest XP)...
    const xp = getTotalRankXp(m);
    const eligibleTier = getRankForXp(xp);
    const confirmedRank = m.confirmed_rank || "Bronze";
    const joined = parseJoinedDate(m.joined_date);
    const days = joined && asOfParsed ? Math.max(0, Math.floor((asOfParsed.utcMs - joined.utcMs) / MS_PER_DAY)) : 0;
    const joinedStr = joined ? joined.iso : "Unknown";
    const pendingTag =
      getRankIndex(eligibleTier.name) > getRankIndex(confirmedRank)
        ? ` *(⏳ Rank-up to ${formatRankName(eligibleTier.name)} pending)*`
        : "";

    // ...but the multiplier is earned from the tenure stream alone, so we never
    // print it here — see formatRankProgress for why. Progress toward the next
    // rank replaces it.
    const progress = formatRankProgress(xp);

    // Only show the tenure/quest split when quest XP actually exists, so the
    // line stays short for members who have never turned in a quest.
    const bonusXp = Number(m.bonus_xp) || 0;
    const tenureXp = Math.max(0, xp - bonusXp);
    const split =
      bonusXp > 0
        ? `Tenure \`${tenureXp.toLocaleString()}\` + Quests \`${bonusXp.toLocaleString()}\` • `
        : "";

    return (
      `**${idx + 1}. ${m.rsn}** — ${formatRankName(confirmedRank)} • \`${xp.toLocaleString()} XP\`\n` +
      `┗ Joined \`${joinedStr}\` • ${formatTenureDuration(days)} • ${split}${progress}${pendingTag}`
    );
  });

  // Growth Chart Embed is always embeds[0] (directly above the Member List!)
  const embeds = [growthEmbed];
  if (lines.length === 0) {
    embeds.push(
      new EmbedBuilder()
        .setColor(COLOR.main)
        .setTitle("Clan Rank List & Tenure Standings")
        .setDescription(`${headerDesc}\n\n*No active clan members found in the database yet.*`)
    );
  } else {
    // Split member lines across embeds so no embed description exceeds Discord's 4096-char limit
    const MAX_DESC = 3500;
    let currentChunk = `${headerDesc}\n\n`;
    let isFirst = true;

    for (const line of lines) {
      if (currentChunk.length + line.length + 2 > MAX_DESC && embeds.length < 9) {
        embeds.push(
          new EmbedBuilder()
            .setColor(COLOR.main)
            .setTitle(isFirst ? "Clan Rank List & Tenure Standings" : "Clan Rank List (Continued)")
            .setDescription(currentChunk.trimEnd())
        );
        isFirst = false;
        currentChunk = "";
      }
      currentChunk += `${line}\n`;
    }

    if (currentChunk.trim().length > 0) {
      embeds.push(
        new EmbedBuilder()
          .setColor(COLOR.main)
          .setTitle(isFirst ? "Clan Rank List & Tenure Standings" : "Clan Rank List (Continued)")
          .setDescription(currentChunk.trimEnd())
      );
    }
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ID.RANK_LIST_REFRESH)
      .setLabel("Refresh Rank List")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(ID.ROSTER_UPLOAD_BTN)
      .setLabel("Upload Roster")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(ID.GROWTH_RANGE_30D)
      .setLabel("Chart: 30 Days")
      .setStyle(rangeKey === "30d" ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ID.GROWTH_RANGE_6M)
      .setLabel("Chart: 6 Months")
      .setStyle(rangeKey === "6m" ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ID.GROWTH_RANGE_ALL)
      .setLabel("Chart: All-Time")
      .setStyle(rangeKey === "all" ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  return { embeds, components: [row], files: [growthAttachment] };
}

async function syncGrowthHistoryToSupabase(supabase, members = [], asOfDate = new Date()) {
  if (!supabase) return [];
  try {
    const { data: existingSnapshots } = await supabase
      .from("clan_growth_history")
      .select("*")
      .order("recorded_date", { ascending: true });

    const series = buildGrowthSeries(members, existingSnapshots || [], asOfDate);
    const existingByDate = new Map();
    for (const row of existingSnapshots || []) {
      const p = parseJoinedDate(row.recorded_date);
      if (p) existingByDate.set(p.iso, row);
    }

    const nowIso = new Date().toISOString();
    for (const pt of series) {
      const prev = existingByDate.get(pt.date);
      if (!prev) {
        await supabase.from("clan_growth_history").insert({
          recorded_date: pt.date,
          active_members: pt.activeMembers,
          members_joined: pt.membersJoined,
          members_left: pt.membersLeft,
          updated_at: nowIso,
        });
      } else if (
        prev.active_members !== pt.activeMembers ||
        prev.members_joined !== pt.membersJoined ||
        prev.members_left !== pt.membersLeft
      ) {
        await supabase
          .from("clan_growth_history")
          .update({
            active_members: pt.activeMembers,
            members_joined: pt.membersJoined,
            members_left: pt.membersLeft,
            updated_at: nowIso,
          })
          .eq("id", prev.id);
      }
    }

    const { data: refreshed } = await supabase
      .from("clan_growth_history")
      .select("*")
      .order("recorded_date", { ascending: true });
    return refreshed || [];
  } catch {
    return [];
  }
}

async function ensureRankListMessage(members, growthSnapshots) {
  let list = members;
  let snapshots = growthSnapshots;
  const supabase = getSupabase();

  if (!list) {
    if (supabase) {
      const { data } = await supabase
        .from("clan_members")
        .select("*")
        .order("xp", { ascending: false });
      list = data || [];
    } else {
      list = [];
    }
  }

  if (!snapshots && supabase) {
    snapshots = await syncGrowthHistoryToSupabase(supabase, list);
  }

  return ensureEmbedMessage({
    channelId: RANK_LIST_CHANNEL_ID,
    label: "RankList",
    buttonIds: [
      ID.RANK_LIST_REFRESH,
      ID.ROSTER_UPLOAD_BTN,
      ID.GROWTH_RANGE_30D,
      ID.GROWTH_RANGE_6M,
      ID.GROWTH_RANGE_ALL,
    ],
    payload: buildRankListPayload(list, new Date(), {
      range: config.growthChartRange,
      growthSnapshots: snapshots || [],
    }),
    what: "permanent clan growth chart & rank list",
  });
}

// ---- Staff Alert Builders (2-Step Confirmation) ----
function buildRankUpAlertStep1(member, targetRankName) {
  const xp = Number(member.xp) || 0;
  const currentRank = member.confirmed_rank || "Bronze";
  const targetTier = RANK_TIERS.find((t) => t.name === targetRankName) || getRankForXp(xp);
  const nextTier = getNextRankTier(targetTier.name);
  const tenureXp = getTenureRankXp(member);
  const bonusXp = Math.max(0, Number(member.bonus_xp) || 0);
  const tenureTier = getRankForXp(tenureXp);
  const joined = parseJoinedDate(member.joined_date);
  const days = joined ? Math.max(0, Math.floor((Date.now() - joined.utcMs) / MS_PER_DAY)) : 0;

  const embed = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle(`Rank-Up Alert — ${member.rsn}`)
    .setDescription(
      `**${member.rsn}** has earned enough Clan Rank XP to be promoted from ${formatRankName(currentRank)} to ${formatRankName(targetTier.name)} in-game!\n\n` +
      `Please rank them up in-game, then complete the double confirmation below.`
    )
    .addFields(
      { name: "Member (RSN)", value: `\`${member.rsn}\``, inline: true },
      { name: "Previous Rank", value: `${formatRankName(currentRank)}`, inline: true },
      // No multiplier here: rank comes from combined XP, but the multiplier is
      // earned from tenure alone. Showing the new tier's multiplier would
      // advertise a rate this member doesn't actually get. The tenure tier's
      // multiplier is shown separately below, where it's true.
      { name: "New Rank", value: `${formatRankName(targetTier.name)}`, inline: true },
      {
        name: "Total Rank XP",
        value: `\`${xp.toLocaleString()} XP\`` +
          (bonusXp > 0 ? `\nTenure \`${tenureXp.toLocaleString()}\` + Quests \`${bonusXp.toLocaleString()}\`` : ""),
        inline: true,
      },
      { name: "Tenure Multiplier", value: `${formatRankName(tenureTier.name)} → ${formatMultiplier(tenureTier.multiplier)}`, inline: true },
      { name: "Next Rank Goal", value: nextTier ? `${formatRankName(nextTier.name)} (\`${nextTier.xpNeeded.toLocaleString()} XP\`)` : "Max Rank Reached", inline: true },
      { name: "Time in Clan", value: `${formatTenureDuration(days)} (Joined \`${joined ? joined.iso : member.joined_date}\`)`, inline: true }
    )
    .setFooter({ text: "Confirmation 1 of 2 • Alert auto-deletes after 2nd confirmation." });

  const btn = new ButtonBuilder()
    .setCustomId(`${ID.RANKUP_C1}:${encodeName(member.rsn)}:${targetTier.name}`)
    .setLabel(`Ranked Up to ${targetTier.name} In-Game (1/2)`)
    .setStyle(ButtonStyle.Primary);
  if (targetTier.emoji) {
    btn.setEmoji(targetTier.emoji);
  }
  const row = new ActionRowBuilder().addComponents(btn);

  return { embeds: [embed], components: [row] };
}

function buildRankUpAlertStep2(rsn, currentRank, targetRankName, xp, clickedByUserId) {
  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle(`Confirmation 2 of 2 — Rank-Up for ${rsn}`)
    .setDescription(
      `<@${clickedByUserId}> marked **${rsn}** as ranked up.\n\n` +
      `Are you **absolutely sure** that **${rsn}** has been promoted from ${formatRankName(currentRank)} to ${formatRankName(targetRankName)} in-game?\n\n` +
      `Confirming will log the promotion in the XP & Rank Log channel, update the permanent rank list, and **auto-delete** this alert.`
    )
    .addFields(
      { name: "Member (RSN)", value: `\`${rsn}\``, inline: true },
      { name: "Promotion", value: `${formatRankName(currentRank)} ➔ ${formatRankName(targetRankName)}`, inline: true },
      { name: "Total Rank XP", value: `\`${(Number(xp) || 0).toLocaleString()} XP\``, inline: true }
    )
    .setFooter({ text: "Confirmation 2 of 2 — Final Check" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID.RANKUP_C2}:${encodeName(rsn)}:${targetRankName}`)
      .setLabel("Yes, Confirm Rank-Up (2/2)")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${ID.RANKUP_CANCEL}:${encodeName(rsn)}:${targetRankName}`)
      .setLabel("No, Go Back")
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

function buildMemberLeftAlertStep1(member) {
  const xp = Number(member.xp) || 0;
  const lastRank = member.confirmed_rank || member.eligible_rank || "Bronze";
  const joined = parseJoinedDate(member.joined_date);

  const embed = new EmbedBuilder()
    .setColor(COLOR.bad)
    .setTitle(`Member Left the Clan — ${member.rsn}`)
    .setDescription(
      `**${member.rsn}** is no longer on the active clan roster.\n\n` +
      `Please verify and complete the double confirmation below to clear this alert.`
    )
    .addFields(
      { name: "Member (RSN)", value: `\`${member.rsn}\``, inline: true },
      { name: "Last Rank", value: `${formatRankName(lastRank)}`, inline: true },
      { name: "Final Rank XP", value: `\`${xp.toLocaleString()} XP\``, inline: true },
      { name: "Joined Date", value: `\`${joined ? joined.iso : (member.joined_date || "Unknown")}\``, inline: true }
    )
    .setFooter({ text: "Confirmation 1 of 2 • Alert auto-deletes after 2nd confirmation." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID.LEFT_C1}:${encodeName(member.rsn)}`)
      .setLabel("Acknowledge Member Left (1/2)")
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

function buildMemberLeftAlertStep2(rsn, lastRank, xp, clickedByUserId) {
  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle(`Confirmation 2 of 2 — Departure for ${rsn}`)
    .setDescription(
      `<@${clickedByUserId}> acknowledged that **${rsn}** left the clan.\n\n` +
      `Are you **sure** all in-game/clan cleanup for **${rsn}** is complete?\n\n` +
      `Confirming will log this confirmation and **auto-delete** this alert.`
    )
    .addFields(
      { name: "Member (RSN)", value: `\`${rsn}\``, inline: true },
      { name: "Final Rank", value: `${formatRankName(lastRank)}`, inline: true },
      { name: "Final XP", value: `\`${(Number(xp) || 0).toLocaleString()} XP\``, inline: true }
    )
    .setFooter({ text: "Confirmation 2 of 2 — Final Check" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID.LEFT_C2}:${encodeName(rsn)}`)
      .setLabel("Yes, Confirm & Delete Alert (2/2)")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${ID.LEFT_CANCEL}:${encodeName(rsn)}`)
      .setLabel("No, Go Back")
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

// ---- Log Channel Helpers ----
async function recordAuditLog(entry) {
  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase
        .from("xp_rank_logs")
        .insert({
          rsn: entry.rsn,
          event_type: entry.eventType,
          xp_delta: entry.xpDelta ?? 0,
          total_xp: entry.totalXp ?? 0,
          old_rank: entry.oldRank ?? null,
          new_rank: entry.newRank ?? null,
          reason: entry.reason ?? null,
          staff_user_id: entry.staffUserId ?? null,
          staff_user_tag: entry.staffUserTag ?? null,
        });
    } catch {}
  }
}

async function logXpAwardToDiscord(memberRsn, events, totalXp, eligibleRankName) {
  if (!events || events.length === 0) return;
  const channel = await getRankLogChannel();
  const nowUnix = Math.floor(Date.now() / 1000);
  const totalGained = events.reduce((sum, e) => sum + e.xpGained, 0);

  for (const ev of events) {
    await recordAuditLog({
      rsn: memberRsn,
      eventType: "xp_award",
      xpDelta: ev.xpGained,
      totalXp: ev.totalXpAfter,
      oldRank: ev.rankBefore,
      newRank: ev.rankAfter,
      reason: ev.reason,
    });
  }

  if (!channel) return;

  if (events.length === 1) {
    const ev = events[0];
    const embed = new EmbedBuilder()
      .setColor(COLOR.main)
      .setTitle("Rank XP Awarded")
      .addFields(
        { name: "Member (RSN)", value: `\`${memberRsn}\``, inline: true },
        { name: "XP Awarded", value: `\`+${ev.xpGained.toLocaleString()} XP\``, inline: true },
        { name: "New Total XP", value: `\`${totalXp.toLocaleString()} XP\` (${formatRankName(eligibleRankName)})`, inline: true },
        { name: "Awarded For", value: ev.reason, inline: false },
        { name: "When", value: `<t:${nowUnix}:F> (Milestone date: \`${ev.date}\`)`, inline: false }
      );
    await channel.send({ embeds: [embed] }).catch((e) => console.warn("[RankLog] Failed to post XP log:", e.message));
  } else {
    // Summarize multi-milestone catch-up (e.g. when a member is uploaded with existing tenure)
    const weeklyCount = events.filter((e) => e.type === "weekly").length;
    const monthlyCount = events.filter((e) => e.type === "monthly").length;
    const yearlyCount = events.filter((e) => e.type === "yearly").length;
    const parts = [];
    if (weeklyCount) parts.push(`${weeklyCount} weekly`);
    if (monthlyCount) parts.push(`${monthlyCount} monthly`);
    if (yearlyCount) parts.push(`${yearlyCount} yearly`);

    const recentLines = events
      .slice(-5)
      .map((e) => `• \`${e.date}\`: **+${e.xpGained.toLocaleString()} XP** — ${e.reason}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor(COLOR.main)
      .setTitle("Rank XP Awarded (Tenure Milestones)")
      .addFields(
        { name: "Member (RSN)", value: `\`${memberRsn}\``, inline: true },
        { name: "Total XP Awarded", value: `\`+${totalGained.toLocaleString()} XP\``, inline: true },
        { name: "New Total XP", value: `\`${totalXp.toLocaleString()} XP\` (${formatRankName(eligibleRankName)})`, inline: true },
        {
          name: `Milestones Awarded (${parts.join(", ")})`,
          value: events.length > 5 ? `*Showing latest 5 of ${events.length} milestones:*\n${recentLines}` : recentLines,
          inline: false,
        },
        { name: "When", value: `<t:${nowUnix}:F>`, inline: false }
      );
    await channel.send({ embeds: [embed] }).catch((e) => console.warn("[RankLog] Failed to post XP summary log:", e.message));
  }
}

async function logRankUpConfirmedToDiscord({ rsn, oldRank, newRank, totalXp, staffUser }) {
  const nowUnix = Math.floor(Date.now() / 1000);
  await recordAuditLog({
    rsn,
    eventType: "rank_up",
    xpDelta: 0,
    totalXp,
    oldRank,
    newRank,
    reason: `Promoted in-game from ${oldRank} to ${newRank}`,
    staffUserId: staffUser.id,
    staffUserTag: staffUser.tag || staffUser.username,
  });

  const channel = await getRankLogChannel();
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(COLOR.ok)
    .setTitle("Member Ranked Up")
    .addFields(
      { name: "Member (RSN)", value: `\`${rsn}\``, inline: true },
      { name: "Rank Promotion", value: `${formatRankName(oldRank)} ➔ ${formatRankName(newRank)}`, inline: true },
      { name: "Total Rank XP", value: `\`${(Number(totalXp) || 0).toLocaleString()} XP\``, inline: true },
      { name: "Ranked Up By (Staff)", value: `<@${staffUser.id}> (\`${staffUser.tag || staffUser.username}\`)`, inline: true },
      { name: "When", value: `<t:${nowUnix}:F>`, inline: true }
    );

  await channel.send({ embeds: [embed] }).catch((e) => console.warn("[RankLog] Failed to post rank-up log:", e.message));
}

async function logMemberLeftToDiscord(member, staffUser = null) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const xp = Number(member.xp) || 0;
  const finalRank = member.confirmed_rank || member.eligible_rank || "Bronze";

  await recordAuditLog({
    rsn: member.rsn,
    eventType: staffUser ? "member_left_confirmed" : "member_left",
    xpDelta: 0,
    totalXp: xp,
    oldRank: finalRank,
    newRank: null,
    reason: staffUser ? `Departure confirmed by ${staffUser.tag || staffUser.username}` : "Member left the clan (removed from roster)",
    staffUserId: staffUser?.id ?? null,
    staffUserTag: staffUser ? (staffUser.tag || staffUser.username) : null,
  });

  const channel = await getRankLogChannel();
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(COLOR.bad)
    .setTitle(staffUser ? "Member Departure Confirmed" : "Member Left the Clan")
    .addFields(
      { name: "Member (RSN)", value: `\`${member.rsn}\``, inline: true },
      { name: "Final Rank", value: `${formatRankName(finalRank)}`, inline: true },
      { name: "Final Rank XP", value: `\`${xp.toLocaleString()} XP\``, inline: true },
      ...(staffUser
        ? [{ name: "Confirmed By (Staff)", value: `<@${staffUser.id}> (\`${staffUser.tag || staffUser.username}\`)`, inline: true }]
        : []),
      { name: "When", value: `<t:${nowUnix}:F>`, inline: true }
    );

  await channel.send({ embeds: [embed] }).catch((e) => console.warn("[RankLog] Failed to post departure log:", e.message));
}

// ---- Supabase Roster Upload & Sync Engine ----
/**
 * Parses CSV or plain-text clan roster exports (such as "AztecSoul,Minion,17-Oct-2026"
 * or "AztecSoul,2026-10-17") into deduplicated `{ rsn, joined_date }` rows.
 */
function parseRosterText(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  const byKey = new Map();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const delimiter = line.includes(",") ? "," : line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
    const cells = line
      .split(delimiter)
      .map((c) => c.trim().replace(/^["']+|["']+$/g, "").trim())
      .filter((c) => c.length > 0);

    if (cells.length < 2) continue;

    const rsn = cells[0];
    if (!rsn || /^(rsn|name|member|username|player)$/i.test(rsn)) continue;

    // Find the column containing the join date (supports 2-column "RSN,Date" or 3+ column "RSN,Rank,Date")
    let parsedDate = null;
    for (let i = cells.length - 1; i >= 1; i--) {
      const candidate = parseJoinedDate(cells[i]);
      if (candidate) {
        parsedDate = candidate;
        break;
      }
    }
    if (!parsedDate) continue;

    const clampedIso = parsedDate.iso < CLAN_CREATION_DATE ? CLAN_CREATION_DATE : parsedDate.iso;
    byKey.set(rsn.toLowerCase(), {
      rsn,
      joined_date: clampedIso,
    });
  }

  return Array.from(byKey.values());
}

async function importRosterRows(supabase, rows = []) {
  if (!supabase || !rows || rows.length === 0) {
    return { ok: false, totalUploaded: 0, added: [], reactivated: [], markedLeft: [] };
  }

  const uploadedByKey = new Map();
  for (const row of rows) {
    const rsn = String(row.rsn || "").trim();
    const parsedDate = parseJoinedDate(row.joined_date);
    if (!rsn || !parsedDate) continue;
    const clampedIso = parsedDate.iso < CLAN_CREATION_DATE ? CLAN_CREATION_DATE : parsedDate.iso;
    uploadedByKey.set(rsn.toLowerCase(), {
      rsn,
      joined_date: clampedIso,
    });
  }

  if (uploadedByKey.size === 0) {
    return { ok: false, totalUploaded: 0, added: [], reactivated: [], markedLeft: [] };
  }

  const { data: existingMembers, error: existingErr } = await supabase
    .from("clan_members")
    .select("*");
  if (existingErr) {
    console.error("[RankSync] Could not fetch clan_members for roster import:", existingErr.message);
    return { ok: false, error: existingErr.message, totalUploaded: 0, added: [], reactivated: [], markedLeft: [] };
  }

  const existingByKey = new Map();
  for (const m of existingMembers || []) {
    existingByKey.set(String(m.rsn || "").trim().toLowerCase(), m);
  }

  const nowIso = new Date().toISOString();
  const added = [];
  const reactivated = [];
  const markedLeft = [];

  // 1. Insert new members or update existing members present in the upload
  for (const [key, uploaded] of uploadedByKey.entries()) {
    const existing = existingByKey.get(key);
    if (!existing) {
      await supabase.from("clan_members").insert({
        rsn: uploaded.rsn,
        joined_date: uploaded.joined_date,
        active: true,
        xp: 0,
        eligible_rank: "Bronze",
        confirmed_rank: "Bronze",
        weeks_awarded: 0,
        months_awarded: 0,
        years_awarded: 0,
        left_logged: false,
        left_confirmed: false,
        updated_at: nowIso,
      });
      added.push(uploaded.rsn);
    } else if (!existing.active || existing.joined_date !== uploaded.joined_date || existing.rsn !== uploaded.rsn) {
      if (!existing.active) reactivated.push(uploaded.rsn);
      await supabase
        .from("clan_members")
        .update({
          rsn: uploaded.rsn,
          joined_date: uploaded.joined_date,
          active: true,
          left_at: null,
          left_logged: false,
          left_confirmed: false,
          updated_at: nowIso,
        })
        .eq("id", existing.id);
    }
  }

  // 2. Mark previously active members missing from the upload as having left the clan
  for (const [key, existing] of existingByKey.entries()) {
    if (existing.active && !uploadedByKey.has(key)) {
      markedLeft.push(existing.rsn);
      await supabase
        .from("clan_members")
        .update({
          active: false,
          left_at: nowIso,
          left_logged: false,
          left_confirmed: false,
          pending_alert_message_id: null,
          pending_alert_type: null,
          updated_at: nowIso,
        })
        .eq("id", existing.id);
    }
  }

  return {
    ok: true,
    totalUploaded: uploadedByKey.size,
    added,
    reactivated,
    markedLeft,
  };
}

async function processRosterUpload(supabase) {
  const { data: uploads, error: uploadErr } = await supabase
    .from("roster_upload")
    .select("*")
    .order("id", { ascending: true });

  if (uploadErr || !uploads || uploads.length === 0) return false;

  const result = await importRosterRows(supabase, uploads);
  if (!result.ok) return false;

  const uploadIds = uploads.map((u) => u.id).filter((id) => id !== undefined);
  if (uploadIds.length > 0) {
    await supabase.from("roster_upload").delete().in("id", uploadIds);
  }

  console.log(`[RankSync] Processed roster_upload (${result.totalUploaded} member(s)).`);
  return true;
}

async function ensureStaffAlertMessage(supabase, member, alertType, payload) {
  const alertChannel = await getStaffAlertChannel();
  if (!alertChannel) return null;

  // If an alert message ID is already recorded for the same alert type, try updating/verifying it
  if (member.pending_alert_message_id && member.pending_alert_type === alertType) {
    const existingMsg = await alertChannel.messages.fetch(member.pending_alert_message_id).catch(() => null);
    if (existingMsg) {
      // Do not overwrite if a staff member is currently on Step 2 confirmation
      const onStep2 = messageHasButton(existingMsg, [ID.RANKUP_C2, ID.LEFT_C2]);
      if (!onStep2) {
        await existingMsg.edit(payload).catch(() => {});
      }
      return existingMsg.id;
    }
  }

  const sent = await alertChannel.send(payload).catch((e) => {
    console.error(`[StaffAlert] Could not send ${alertType} alert for ${member.rsn}:`, e.message);
    return null;
  });
  if (!sent) return null;

  await supabase
    .from("clan_members")
    .update({
      pending_alert_message_id: sent.id,
      pending_alert_type: alertType,
      updated_at: new Date().toISOString(),
    })
    .eq("id", member.id);

  return sent.id;
}

let rankSyncInFlight = false;
let lastRankSyncFinishedAt = 0;

// ── Honour Marks quest XP intake ─────────────────────────────────────────────
// The HM bot never writes `clan_members` directly. It appends to
// `pending_rank_xp`, and Heimdall is the only writer of the ladder. That keeps
// the tenure stream (replayed from the join date) and the quest stream (flat,
// additive) fully independent: neither reads the other, they only meet when
// `xp` is summed for display and rank.
//
// Consumption is claim-first: the conditional update on `consumed_at is null`
// is what stops a double credit when the 30-minute timer and a Realtime nudge
// overlap. Claim, THEN credit — never the reverse.
const PENDING_RANK_XP_BATCH = 200;

async function claimPendingRow(supabase, id) {
  const { data } = await supabase
    .from("pending_rank_xp")
    .update({ consumed_at: new Date().toISOString(), consumed_by: "heimdall" })
    .eq("id", id)
    .is("consumed_at", null)
    .select("id");
  return Array.isArray(data) && data.length > 0;
}

async function deferPendingRow(supabase, row) {
  // The RSN isn't on the roster yet (roster upload lag, or a typo). Push the
  // row to the back of the queue rather than letting it clog the batch head.
  try {
    await supabase
      .from("pending_rank_xp")
      .update({
        attempts: (Number(row.attempts) || 0) + 1,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  } catch { /* non-fatal */ }
}

/** Resolves a queue row to a roster key (lowercased RSN). */
async function resolvePendingRsn(supabase, row, byRsn) {
  const own = row.rsn ? String(row.rsn).trim().toLowerCase() : null;
  if (own && byRsn.has(own)) return own;

  if (row.user_id) {
    // Mimir keeps the Discord id -> RSN mapping in hm_members, same database.
    try {
      const { data } = await supabase
        .from("hm_members")
        .select("rsn")
        .eq("user_id", String(row.user_id))
        .maybeSingle();
      const mapped = data?.rsn ? String(data.rsn).trim().toLowerCase() : null;
      if (mapped && byRsn.has(mapped)) return mapped;
    } catch { /* hm_members may not exist yet — fall through */ }
  }
  return null;
}

/**
 * Drains unconsumed `pending_rank_xp` rows into each member's `bonus_xp`.
 * Mutates the passed member objects in place, so the caller's loop sees the
 * credited amount. Returns a small summary for logging.
 */
async function consumePendingRankXp(supabase, members = []) {
  const summary = { rows: 0, credited: 0, deferred: 0 };
  if (!Array.isArray(members) || members.length === 0) return summary;

  const byRsn = new Map();
  for (const m of members) {
    if (m && m.rsn) byRsn.set(String(m.rsn).trim().toLowerCase(), m);
  }
  if (byRsn.size === 0) return summary;

  let pending = [];
  try {
    const { data, error } = await supabase
      .from("pending_rank_xp")
      .select("*")
      .is("consumed_at", null)
      // Rows that keep failing to resolve sink to the back so a single bad
      // entry can't starve the queue head forever.
      .order("attempts", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(PENDING_RANK_XP_BATCH);
    if (error) {
      console.error("[RankSync] Could not read pending_rank_xp:", error.message);
      return summary;
    }
    pending = data || [];
  } catch (e) {
    console.error("[RankSync] pending_rank_xp read failed:", e.message);
    return summary;
  }

  for (const row of pending) {
    summary.rows += 1;
    const key = await resolvePendingRsn(supabase, row, byRsn);
    const member = key ? byRsn.get(key) : null;
    if (!member) {
      summary.deferred += 1;
      await deferPendingRow(supabase, row);
      continue;
    }

    const amount = Math.round(Number(row.amount) || 0);
    if (amount <= 0) {
      await claimPendingRow(supabase, row.id); // nothing to credit; don't retry
      continue;
    }

    if (!(await claimPendingRow(supabase, row.id))) continue; // lost the race — skip

    member.bonus_xp = (Number(member.bonus_xp) || 0) + amount;
    summary.credited += amount;

    try {
      await supabase.from("hm_audit_log").insert({
        guild_id: row.guild_id || null,
        kind: "rank_xp_credited",
        subject_id: row.user_id || null,
        amount,
        detail: {
          rsn: member.rsn,
          event_key: row.event_key || null,
          reason: row.reason || null,
          source: "pending_rank_xp",
        },
      });
    } catch { /* audit is best-effort */ }
  }

  if (summary.rows > 0) {
    console.log(
      `[RankSync] Quest XP: ${summary.rows} row(s), ${summary.credited.toLocaleString()} XP credited, ${summary.deferred} deferred.`
    );
  }
  return summary;
}

async function syncClanRanks(asOfDate = new Date()) {
  if (rankSyncInFlight) return;
  const supabase = getSupabase();
  if (!supabase) return;

  rankSyncInFlight = true;
  try {
    await processRosterUpload(supabase);

    const { data: members, error } = await supabase
      .from("clan_members")
      .select("*")
      .order("xp", { ascending: false });

    if (error || !members) {
      if (error) console.error("[RankSync] Could not read clan_members:", error.message);
      return;
    }

    // Pull any Honour Marks quest XP before we compute ranks, so a member who
    // just completed a quest ranks up in this same pass instead of the next one.
    await consumePendingRankXp(supabase, members);

    for (const member of members) {
      if (member.active !== false) {
        const parsedJoin = parseJoinedDate(member.joined_date);
        const effectiveJoinedDate =
          parsedJoin && parsedJoin.iso < CLAN_CREATION_DATE ? CLAN_CREATION_DATE : member.joined_date;
        const dateClamped = effectiveJoinedDate !== member.joined_date;
        if (dateClamped) {
          member.joined_date = effectiveJoinedDate;
        }

        // Active clan member: calculate tenure & award any new weekly/monthly/yearly milestones
        //
        // The tenure replay only ever sees the tenure stream — `calc.xp` is
        // tenure XP alone. Quest XP is `bonus_xp`, added on afterwards. The two
        // meet in exactly one place: the total written to `xp`.
        const calc = calculateTenureProgression(effectiveJoinedDate, asOfDate, member);
        const tenureXp = calc.xp;
        const bonusXp = Math.max(0, Number(member.bonus_xp) || 0);
        const totalXp = tenureXp + bonusXp;
        const combinedRank = getRankForXp(totalXp);

        const xpChanged = totalXp !== (Number(member.xp) || 0);
        const tenureChanged = tenureXp !== (Number(member.tenure_xp) || 0);
        const rankChanged = combinedRank.name !== member.eligible_rank;
        const countersChanged =
          calc.weeksAwarded !== (Number(member.weeks_awarded) || 0) ||
          calc.monthsAwarded !== (Number(member.months_awarded) || 0) ||
          calc.yearsAwarded !== (Number(member.years_awarded) || 0);

        if (xpChanged || tenureChanged || rankChanged || countersChanged || dateClamped) {
          const nowIso = new Date().toISOString();
          await supabase
            .from("clan_members")
            .update({
              joined_date: effectiveJoinedDate,
              tenure_xp: tenureXp,
              bonus_xp: bonusXp,
              xp: totalXp,
              eligible_rank: combinedRank.name,
              weeks_awarded: calc.weeksAwarded,
              months_awarded: calc.monthsAwarded,
              years_awarded: calc.yearsAwarded,
              updated_at: nowIso,
            })
            .eq("id", member.id);

          member.tenure_xp = tenureXp;
          member.bonus_xp = bonusXp;
          member.xp = totalXp;
          member.eligible_rank = combinedRank.name;
          member.weeks_awarded = calc.weeksAwarded;
          member.months_awarded = calc.monthsAwarded;
          member.years_awarded = calc.yearsAwarded;

          if (calc.newEvents.length > 0) {
            await logXpAwardToDiscord(member.rsn, calc.newEvents, totalXp, combinedRank.name);
          }
        }

        // Check if member is eligible for a rank-up above their confirmed in-game rank
        const eligibleIdx = getRankIndex(member.eligible_rank);
        const confirmedIdx = getRankIndex(member.confirmed_rank || "Bronze");
        if (eligibleIdx > confirmedIdx) {
          const payload = buildRankUpAlertStep1(member, member.eligible_rank);
          await ensureStaffAlertMessage(supabase, member, "rank_up", payload);
        }
      } else {
        // Member has left the clan
        if (!member.left_logged) {
          await logMemberLeftToDiscord(member, null);
          await supabase
            .from("clan_members")
            .update({ left_logged: true, updated_at: new Date().toISOString() })
            .eq("id", member.id);
          member.left_logged = true;
        }

        if (!member.left_confirmed) {
          const payload = buildMemberLeftAlertStep1(member);
          await ensureStaffAlertMessage(supabase, member, "member_left", payload);
        }
      }
    }

    await ensureRankListMessage(members);
  } finally {
    lastRankSyncFinishedAt = Date.now();
    rankSyncInFlight = false;
  }
}

let realtimeChannel = null;
let syncTimer = null;

function startRankingSyncLoop() {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn("[RankSync] SUPABASE_URL or SUPABASE_KEY not set — ranking sync disabled until configured.");
    return;
  }

  // Subscribe to Realtime changes on clan_members and roster_upload
  try {
    realtimeChannel = supabase
      .channel("heimdall-clan-ranks")
      .on("postgres_changes", { event: "*", schema: "public", table: "clan_members" }, () => {
        if (rankSyncInFlight || Date.now() - lastRankSyncFinishedAt < 5000) return;
        syncClanRanks().catch((e) => console.error("[RankSync] Realtime sync error:", e.message));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "roster_upload" }, () => {
        if (rankSyncInFlight) return;
        syncClanRanks().catch((e) => console.error("[RankSync] Roster upload sync error:", e.message));
      })
      // The HM bot appends quest XP here. Reacting to inserts means the member
      // list reflects a quest completion in seconds instead of waiting up to
      // 30 minutes for the next scheduled sync.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "pending_rank_xp" }, () => {
        if (rankSyncInFlight || Date.now() - lastRankSyncFinishedAt < 5000) return;
        syncClanRanks().catch((e) => console.error("[RankSync] Quest XP sync error:", e.message));
      })
      .subscribe();
  } catch (err) {
    console.warn("[RankSync] Realtime subscription warning:", err.message);
  }

  if (config.rankSyncIntervalMs > 0) {
    syncTimer = setInterval(() => {
      syncClanRanks().catch((e) => console.error("[RankSync] Scheduled sync error:", e.message));
    }, config.rankSyncIntervalMs);
    if (typeof syncTimer.unref === "function") syncTimer.unref();
  }
}

// Deletes every bot @ping aimed at this member (never the permanent embed).
async function deletePingsFor(userId) {
  const channel = await getOnboardingChannel();
  if (!channel) return 0;
  const recent = await fetchRecentMessages(channel, SCAN_PAGES_PINGS);
  let deleted = 0;
  for (const m of recent) {
    if (isPingFor(m, userId)) {
      const ok = await m.delete().then(() => true).catch(() => false);
      if (ok) deleted++;
    }
  }
  return deleted;
}

// ================= MEMBER EVENTS =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const completedOnboarding = (m) => !!m.flags?.has(GuildMemberFlags.CompletedOnboarding);

async function sendOnboardingPing(userId) {
  const channel = await getOnboardingChannel();
  if (!channel) return false;
  await channel.send({
    content:
      `Welcome <@${userId}>! Click the **Update Server Nickname** button in this channel ` +
      `and enter your exact in-game username to get started.`,
    allowedMentions: { users: [userId] },
  });
  return true;
}

async function hasPingFor(userId) {
  const channel = await getOnboardingChannel();
  if (!channel) return false;
  const recent = await fetchRecentMessages(channel, SCAN_PAGES_PINGS);
  return recent.some((m) => isPingFor(m, userId));
}

async function handleMemberAdd(member) {
  if (member.user?.bot) return;
  try {
    await member.roles.add(UNVERIFIED_ROLE_ID, "New member — Unverified");
  } catch (err) {
    console.error(`[Join] Could not give Unverified role to ${member.id}: ${err.message}`);
  }
}

// Runs once Discord says the member finished its onboarding.
const completionInFlight = new Set();
async function processOnboardingCompletion(guild, userId) {
  if (completionInFlight.has(userId)) return;
  completionInFlight.add(userId);
  try {
    if (config.settleMs > 0) await sleep(config.settleMs);
    const member = await guild.members.fetch({ user: userId, force: true });

    if (!completedOnboarding(member)) return;                 // not actually completed
    if (!member.roles.cache.has(UNVERIFIED_ROLE_ID)) return;  // already handled

    if (member.roles.cache.has(CLAN_MEMBER_ROLE_ID)) {
      if (await hasPingFor(userId)) return;                   // already pinged
      await sendOnboardingPing(userId);
      console.log(`[Onboarding] ${userId} finished Discord onboarding WITH clan role -> pinged.`);
    } else {
      await member.roles.remove(UNVERIFIED_ROLE_ID, "Finished Discord onboarding without Clan Member role");
      console.log(`[Onboarding] ${userId} finished Discord onboarding WITHOUT clan role -> Unverified removed, no ping.`);
    }
  } finally {
    completionInFlight.delete(userId);
  }
}

async function handleMemberUpdate(oldMember, newMember) {
  if (newMember.user?.bot) return;
  if (!completedOnboarding(newMember)) return;
  if (!newMember.roles.cache.has(UNVERIFIED_ROLE_ID)) return;
  await processOnboardingCompletion(newMember.guild, newMember.id);
}

async function handleMemberRemove(member) {
  // Left before finishing — clear their ping so the channel stays clean.
  if (member.user?.bot) return;
  await deletePingsFor(member.id).catch((e) => console.warn("[Leave] ping cleanup failed:", e.message));
}

// ================= INTERACTIONS =================
function confirmRow(confirmId, yesLabel, noLabel, name) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${confirmId}:${encodeName(name)}`)
      .setLabel(yesLabel)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(ID.CANCEL)
      .setLabel(noLabel)
      .setStyle(ButtonStyle.Danger)
  );
}

// Works for both a cached GuildMember and the raw interaction member (roles = array of IDs).
function memberHasRole(member, roleId) {
  if (!member) return false;
  const roles = member.roles;
  if (Array.isArray(roles)) return roles.includes(roleId);
  return !!roles?.cache?.has(roleId);
}

function notAllowedEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR.bad)
    .setTitle("This button isn't available to you")
    .setDescription(
      "Setting a server nickname here is only for members with the **Clan Member** role.\n\n" +
      "If you should have that role, please ask a staff member for help."
    );
}

async function onStartButton(interaction) {
  if (!memberHasRole(interaction.member, CLAN_MEMBER_ROLE_ID)) {
    return interaction.reply({ embeds: [notAllowedEmbed()], flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder().setCustomId(ID.MODAL).setTitle("Update Server Nickname");
  const input = new TextInputBuilder()
    .setCustomId(ID.INPUT)
    .setLabel("Your exact in-game username")
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(RSN_MAX_LENGTH)
    .setRequired(true)
    .setPlaceholder("Type it exactly as it appears in game");
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function onModalSubmit(interaction) {
  const result = validateRsn(interaction.fields.getTextInputValue(ID.INPUT));
  if (!result.ok) {
    const embed = new EmbedBuilder()
      .setColor(COLOR.bad)
      .setTitle("That username isn't valid")
      .setDescription(`${result.error}\n\nClick **Update Server Nickname** to try again.`);
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle("Confirmation 1 of 2")
    .setDescription(
      `You entered:\n# \`${result.name}\`\n\n` +
      "Is this your **exact** in-game username — spelled correctly, with no extra characters or spaces?"
    );
  return interaction.reply({
    embeds: [embed],
    components: [confirmRow(ID.CONFIRM1, "Yes, it's exact", "No, start over", result.name)],
    flags: MessageFlags.Ephemeral,
  });
}

async function onConfirm1(interaction, encoded) {
  const result = validateRsn(decodeName(encoded));
  if (!result.ok) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOR.bad).setTitle("Something went wrong").setDescription("Please click **Update Server Nickname** and try again.")],
      components: [],
    });
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR.bad)
    .setTitle("Confirmation 2 of 2 — Final check")
    .setDescription(
      `Your server nickname will be changed to:\n# \`${result.name}\`\n\n` +
      "Are you **absolutely sure** this matches your in-game username exactly? " +
      "No misspellings, no added or missing characters."
    );
  return interaction.update({
    embeds: [embed],
    components: [confirmRow(ID.CONFIRM2, "Yes, I'm absolutely sure", "No, go back", result.name)],
  });
}

async function onConfirm2(interaction, encoded) {
  const result = validateRsn(decodeName(encoded));
  if (!result.ok) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOR.bad).setTitle("Something went wrong").setDescription("Please click **Update Server Nickname** and try again.")],
      components: [],
    });
  }

  await interaction.deferUpdate();

  let member;
  try {
    member = await interaction.guild.members.fetch(interaction.user.id);
    // Re-check at the final step so the gate can't be skipped via an old confirmation message.
    if (!memberHasRole(member, CLAN_MEMBER_ROLE_ID)) {
      return interaction.editReply({ embeds: [notAllowedEmbed()], components: [] });
    }
    await member.setNickname(result.name, "Onboarding — member set their in-game username");
  } catch (err) {
    console.error(`[Nickname] Failed for ${interaction.user.id}: ${err.message}`);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.bad)
          .setTitle("I couldn't change your nickname")
          .setDescription(
            "Discord wouldn't let me change it (this usually means your role is above mine, or you own the server).\n\n" +
            "Please ask a staff member to set your nickname to your in-game username."
          ),
      ],
      components: [],
    });
  }

  // Nickname is changed — give the OSRS role first, then remove Unverified
  // (this order means a failure never leaves the member with neither role).
  try {
    await member.roles.add(OSRS_ROLE_ID, "Onboarding — nickname set via bot");
    await member.roles.remove(UNVERIFIED_ROLE_ID, "Onboarding — nickname set via bot");
  } catch (err) {
    console.error(`[Roles] Role update failed for ${interaction.user.id}: ${err.message}`);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.warn)
          .setTitle("Nickname updated — role needs a staff member")
          .setDescription(
            `Your server nickname is now **${result.name}**, but I couldn't update your roles.\n\n` +
            "Please ask a staff member for help."
          ),
      ],
      components: [],
    });
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR.ok)
        .setTitle("Nickname updated")
        .setDescription(`Your server nickname is now **${result.name}**.`),
    ],
    components: [],
  });

  // Clear the @ping so only the permanent embed remains.
  await deletePingsFor(interaction.user.id).catch((e) => console.warn("[Nickname] ping cleanup failed:", e.message));
}

// ---- Orientation acknowledgement buttons ----
// These handlers only ever ADD the verified role. There is intentionally no roles.remove() here.
const ORIENTATION_BUTTONS = {
  [ID.ORIENT_LEADER]: {
    label: "Leader",
    requiredRoleIds: [LEADER_ROLE_ID],
    grantRoleId: VERIFIED_LEADER_ROLE_ID,
  },
  [ID.ORIENT_STAFF]: {
    label: "Staff / Jr. Staff",
    requiredRoleIds: [STAFF_ROLE_ID, JR_STAFF_ROLE_ID],
    grantRoleId: VERIFIED_STAFF_ROLE_ID,
  },
};

const hasAnyRole = (member, roleIds) => roleIds.some((id) => memberHasRole(member, id));

function orientationDeniedEmbed(cfg) {
  return new EmbedBuilder()
    .setColor(COLOR.bad)
    .setTitle("This button isn't available to you")
    .setDescription(
      `This one is for members with the **${cfg.label}** role.\n\n` +
      "If you think that's a mistake, please reach out to a Leader or Owner."
    );
}

async function onOrientationAccept(interaction) {
  const cfg = ORIENTATION_BUTTONS[interaction.customId];
  if (!cfg) return;

  // 1) Quick check with the role data that came with the click.
  if (!hasAnyRole(interaction.member, cfg.requiredRoleIds)) {
    return interaction.reply({ embeds: [orientationDeniedEmbed(cfg)], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 2) Re-check on a fresh copy of the member right before assigning anything.
  let member;
  try {
    member = await interaction.guild.members.fetch(interaction.user.id);
  } catch (err) {
    console.error(`[Orientation] Could not fetch ${interaction.user.id}: ${err.message}`);
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.bad).setTitle("Something went wrong").setDescription("Please try the button again in a moment.")],
    });
  }

  if (!hasAnyRole(member, cfg.requiredRoleIds)) {
    return interaction.editReply({ embeds: [orientationDeniedEmbed(cfg)] });
  }

  if (memberHasRole(member, cfg.grantRoleId)) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR.ok).setTitle("Already accepted").setDescription(`You've already accepted the **${cfg.label}** role. Nothing more to do.`)],
    });
  }

  try {
    await member.roles.add(cfg.grantRoleId, `Orientation — accepted ${cfg.label} role`);
  } catch (err) {
    console.error(`[Orientation] Could not give role ${cfg.grantRoleId} to ${interaction.user.id}: ${err.message}`);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.bad)
          .setTitle("I couldn't assign your role")
          .setDescription("Discord wouldn't let me add it. Please ask a Leader or Owner to help."),
      ],
    });
  }

  console.log(`[Orientation] ${interaction.user.id} accepted ${cfg.label} role.`);
  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR.ok)
        .setTitle("Role accepted")
        .setDescription(`Thanks for confirming. You've accepted the **${cfg.label}** role, and your verified role has been added.`),
    ],
  });
}

async function onCancel(interaction) {
  return interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR.warn)
        .setTitle("Cancelled")
        .setDescription("No changes were made. Click **Update Server Nickname** whenever you're ready to try again."),
    ],
    components: [],
  });
}

// ---- Ranking System Alert & List Button Handlers ----
async function findMemberByRsn(supabase, rsn) {
  if (!supabase || !rsn) return null;
  const { data } = await supabase
    .from("clan_members")
    .select("*")
    .ilike("rsn", rsn)
    .maybeSingle();
  return data || null;
}

async function onRankListRefresh(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await syncClanRanks();
  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR.ok)
        .setTitle("Rank List Synced")
        .setDescription("The clan growth chart, rank list, and tenure milestones have been synced with Supabase."),
    ],
  });
}

async function onGrowthRangeButton(interaction, rangeKey) {
  config.growthChartRange = rangeKey;
  await interaction.deferUpdate();
  const supabase = getSupabase();
  let members = [];
  let snapshots = [];
  if (supabase) {
    const { data } = await supabase
      .from("clan_members")
      .select("*")
      .order("xp", { ascending: false });
    members = data || [];
    snapshots = await syncGrowthHistoryToSupabase(supabase, members);
  }
  const payload = buildRankListPayload(members, new Date(), {
    range: rangeKey,
    growthSnapshots: snapshots,
  });
  await interaction.editReply(payload).catch((e) => console.warn("[GrowthChart] Could not update range view:", e.message));
}

// ---- Roster Upload via Discord Button / File Drop / Modal / Slash Command ----
const pendingRosterUploads = new Map(); // userId -> { expiresAt, channelId, guildId }
const ROSTER_UPLOAD_WINDOW_MS = 2 * 60 * 1000;

function canUploadRoster(member) {
  return hasAnyRole(member, ROSTER_UPLOAD_ROLE_IDS);
}

function rosterUploadDeniedEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR.bad)
    .setTitle("This button isn't available to you")
    .setDescription(
      "Uploading the clan roster is restricted to **Leaders**, **Co-Owners**, and the **Owner**.\n\n" +
      "If you think that's a mistake, please reach out to an Owner."
    );
}

function buildRosterUploadResultEmbed(result) {
  if (!result.ok) {
    return new EmbedBuilder()
      .setColor(COLOR.bad)
      .setTitle("Roster Upload Failed")
      .setDescription(
        result.error ||
          "No valid `RSN,JoinedDate` rows were found. Make sure each line looks like `AztecSoul,Minion,17-Oct-2026` or `AztecSoul,2026-10-17`."
      );
  }

  const addedPreview =
    result.added.length > 0
      ? `${result.added.length} (${result.added.slice(0, 10).join(", ")}${result.added.length > 10 ? "…" : ""})`
      : "0";
  const leftPreview =
    result.markedLeft.length > 0
      ? `${result.markedLeft.length} (${result.markedLeft.slice(0, 10).join(", ")}${result.markedLeft.length > 10 ? "…" : ""})`
      : "0";

  return new EmbedBuilder()
    .setColor(COLOR.ok)
    .setTitle("Clan Roster Uploaded & Synced")
    .setDescription(
      "Your clan member list has been imported to Supabase, tenure XP has been calculated, and the Growth Chart & Rank List have been updated!"
    )
    .addFields(
      { name: "Active Members in Upload", value: `\`${result.totalUploaded}\``, inline: true },
      { name: "New Members Added", value: addedPreview, inline: true },
      { name: "Members Marked Left", value: leftPreview, inline: true }
    );
}

async function onRosterUploadButton(interaction) {
  if (!canUploadRoster(interaction.member)) {
    return interaction.reply({ embeds: [rosterUploadDeniedEmbed()], flags: MessageFlags.Ephemeral });
  }

  pendingRosterUploads.set(interaction.user.id, {
    expiresAt: Date.now() + ROSTER_UPLOAD_WINDOW_MS,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
  });

  const botMention = client.user ? `<@${client.user.id}>` : "@Heimdall";
  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle("Upload Clan Roster to Database")
    .setDescription(
      "Upload mode is active for the next **2 minutes**. Choose whichever method is easiest:\n\n" +
      `**Option 1 — Upload a \`.csv\` or \`.txt\` File (No Size Limit):**\n` +
      `• Drop your exported \`.csv\` or \`.txt\` file in this channel and mention ${botMention} in the message (or drop the file in a **DM to ${botMention}**, or use \`/upload-roster\`).\n` +
      `• I will automatically import the file into Supabase, update the chart & rank list, and **delete your upload message immediately**.\n\n` +
      `**Option 2 — Paste Roster Text:**\n` +
      `• Click **Paste Roster Text** below to paste lines like \`AztecSoul,Minion,17-Oct-2026\` directly.`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ID.ROSTER_PASTE_BTN)
      .setLabel("Paste Roster Text")
      .setStyle(ButtonStyle.Primary)
  );

  return interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function onRosterPasteButton(interaction) {
  if (!canUploadRoster(interaction.member)) {
    return interaction.reply({ embeds: [rosterUploadDeniedEmbed()], flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId(ID.ROSTER_MODAL)
    .setTitle("Upload Clan Roster");

  const input = new TextInputBuilder()
    .setCustomId(ID.ROSTER_INPUT)
    .setLabel("Paste clan list (RSN,Rank,Date or RSN,Date)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setPlaceholder("AztecSoul,Minion,17-Oct-2026\nEm Bri,Master,11-Oct-2026\nTorlokt,Owner,4-Mar-2024");

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

async function onRosterModalSubmit(interaction) {
  if (!canUploadRoster(interaction.member)) {
    return interaction.reply({ embeds: [rosterUploadDeniedEmbed()], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rawText = interaction.fields.getTextInputValue(ID.ROSTER_INPUT);
  const rows = parseRosterText(rawText);
  if (rows.length === 0) {
    return interaction.editReply({
      embeds: [buildRosterUploadResultEmbed({ ok: false })],
    });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.bad)
          .setTitle("Supabase Not Configured")
          .setDescription("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set."),
      ],
    });
  }

  const result = await importRosterRows(supabase, rows);
  pendingRosterUploads.delete(interaction.user.id);
  await syncClanRanks();
  return interaction.editReply({ embeds: [buildRosterUploadResultEmbed(result)] });
}

async function onUploadRosterSlashCommand(interaction) {
  if (!canUploadRoster(interaction.member)) {
    return interaction.reply({ embeds: [rosterUploadDeniedEmbed()], flags: MessageFlags.Ephemeral });
  }

  const attachment = interaction.options.getAttachment("file", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let rawText = "";
  try {
    const res = await fetch(attachment.url);
    rawText = await res.text();
  } catch (err) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.bad)
          .setTitle("Could Not Read File")
          .setDescription(`Failed to download attachment: ${err.message}`),
      ],
    });
  }

  const rows = parseRosterText(rawText);
  if (rows.length === 0) {
    return interaction.editReply({
      embeds: [buildRosterUploadResultEmbed({ ok: false })],
    });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.bad)
          .setTitle("Supabase Not Configured")
          .setDescription("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set."),
      ],
    });
  }

  const result = await importRosterRows(supabase, rows);
  pendingRosterUploads.delete(interaction.user.id);
  await syncClanRanks();
  return interaction.editReply({ embeds: [buildRosterUploadResultEmbed(result)] });
}

async function handleMessageCreate(message) {
  if (!message || message.author?.bot) return;
  if (!message.attachments || message.attachments.size === 0) return;

  const session = pendingRosterUploads.get(message.author.id);
  const hasActiveSession = session && session.expiresAt > Date.now();
  const isRankListChannel = message.channelId === RANK_LIST_CHANNEL_ID;
  const isDm = !message.guildId;

  if (!hasActiveSession && !isRankListChannel && !isDm) return;

  // Verify the uploader has Owner / Co-Owner / Leader role
  let allowed = false;
  if (message.member) {
    allowed = canUploadRoster(message.member);
  } else if (session?.guildId) {
    const guild = await client.guilds.fetch(session.guildId).catch(() => null);
    const member = guild ? await guild.members.fetch(message.author.id).catch(() => null) : null;
    allowed = canUploadRoster(member);
  } else {
    for (const guild of client.guilds.cache.values()) {
      const member = await guild.members.fetch(message.author.id).catch(() => null);
      if (canUploadRoster(member)) {
        allowed = true;
        break;
      }
    }
  }

  if (!allowed) return;

  const attachment = message.attachments.first();
  if (!attachment?.url) return;

  let rawText = "";
  try {
    const res = await fetch(attachment.url);
    rawText = await res.text();
  } catch (err) {
    console.error("[RosterUpload] Could not download file attachment:", err.message);
    return;
  }

  // Delete the uploaded file message from the guild channel so the channel stays clean
  if (message.guildId && message.deletable !== false) {
    await message.delete().catch(() => {});
  }

  const rows = parseRosterText(rawText);
  const supabase = getSupabase();
  if (!supabase || rows.length === 0) {
    const errEmbed = buildRosterUploadResultEmbed({ ok: false });
    if (isDm) {
      await message.reply({ embeds: [errEmbed] }).catch(() => {});
    } else if (message.channel?.isTextBased()) {
      const temp = await message.channel.send({ content: `<@${message.author.id}>`, embeds: [errEmbed] }).catch(() => null);
      if (temp) setTimeout(() => temp.delete().catch(() => {}), 15000);
    }
    return;
  }

  pendingRosterUploads.delete(message.author.id);
  const result = await importRosterRows(supabase, rows);
  await syncClanRanks();

  const summaryEmbed = buildRosterUploadResultEmbed(result);
  if (isDm) {
    await message.reply({ embeds: [summaryEmbed] }).catch(() => {});
  } else if (message.channel?.isTextBased()) {
    const temp = await message.channel
      .send({ content: `<@${message.author.id}>`, embeds: [summaryEmbed] })
      .catch(() => null);
    if (temp) setTimeout(() => temp.delete().catch(() => {}), 15000);
  }
}

async function registerUploadRosterCommand() {
  if (!client.application) return;
  const commandDef = {
    name: "upload-roster",
    description: "Upload a .csv or .txt clan member list to Supabase (Owner, Co-Owners & Leaders only)",
    options: [
      {
        name: "file",
        description: "Your exported .csv or .txt clan member list (RSN,Rank,JoinedDate or RSN,JoinedDate)",
        type: ApplicationCommandOptionType.Attachment,
        required: true,
      },
    ],
  };

  for (const guild of client.guilds.cache.values()) {
    await guild.commands.create(commandDef).catch((e) => {
      console.warn(`[RosterUpload] Could not register /upload-roster in guild ${guild.id}:`, e.message);
    });
  }
}

async function onRankUpConfirm1(interaction, encodedRsn, targetRank) {
  const rsn = decodeName(encodedRsn);
  const supabase = getSupabase();
  const member = await findMemberByRsn(supabase, rsn);
  const currentRank = member?.confirmed_rank || "Bronze";
  const xp = member?.xp ?? 0;
  const newRank = targetRank || member?.eligible_rank || getRankForXp(xp).name;

  return interaction.update(buildRankUpAlertStep2(rsn, currentRank, newRank, xp, interaction.user.id));
}

async function onRankUpCancel(interaction, encodedRsn, targetRank) {
  const rsn = decodeName(encodedRsn);
  const supabase = getSupabase();
  const member = (await findMemberByRsn(supabase, rsn)) || {
    rsn,
    confirmed_rank: "Bronze",
    eligible_rank: targetRank || "Steel",
    xp: 0,
    joined_date: new Date().toISOString().slice(0, 10),
  };
  return interaction.update(buildRankUpAlertStep1(member, targetRank || member.eligible_rank));
}

async function onRankUpConfirm2(interaction, encodedRsn, targetRank) {
  const rsn = decodeName(encodedRsn);
  await interaction.deferUpdate();

  const supabase = getSupabase();
  let oldRank = "Bronze";
  let xp = 0;
  let promotedTo = targetRank || "Steel";

  if (supabase) {
    const member = await findMemberByRsn(supabase, rsn);
    if (member) {
      oldRank = member.confirmed_rank || "Bronze";
      xp = Number(member.xp) || 0;
      promotedTo = targetRank || member.eligible_rank || getRankForXp(xp).name;

      await supabase
        .from("clan_members")
        .update({
          confirmed_rank: promotedTo,
          pending_alert_message_id: null,
          pending_alert_type: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", member.id);
    }
  }

  await logRankUpConfirmedToDiscord({
    rsn,
    oldRank,
    newRank: promotedTo,
    totalXp: xp,
    staffUser: interaction.user,
  });

  await ensureRankListMessage().catch((e) => console.warn("[RankList] refresh failed:", e.message));

  // Auto-delete the alert message once the 2nd confirmation is marked as confirmed
  if (interaction.message?.deletable !== false) {
    await interaction.message?.delete().catch((e) => console.warn("[StaffAlert] Could not delete rank-up alert:", e.message));
  }
}

async function onMemberLeftConfirm1(interaction, encodedRsn) {
  const rsn = decodeName(encodedRsn);
  const supabase = getSupabase();
  const member = await findMemberByRsn(supabase, rsn);
  const lastRank = member?.confirmed_rank || member?.eligible_rank || "Bronze";
  const xp = member?.xp ?? 0;

  return interaction.update(buildMemberLeftAlertStep2(rsn, lastRank, xp, interaction.user.id));
}

async function onMemberLeftCancel(interaction, encodedRsn) {
  const rsn = decodeName(encodedRsn);
  const supabase = getSupabase();
  const member = (await findMemberByRsn(supabase, rsn)) || {
    rsn,
    confirmed_rank: "Bronze",
    eligible_rank: "Bronze",
    xp: 0,
    joined_date: "Unknown",
  };
  return interaction.update(buildMemberLeftAlertStep1(member));
}

async function onMemberLeftConfirm2(interaction, encodedRsn) {
  const rsn = decodeName(encodedRsn);
  await interaction.deferUpdate();

  const supabase = getSupabase();
  let memberRecord = {
    rsn,
    confirmed_rank: "Bronze",
    eligible_rank: "Bronze",
    xp: 0,
  };

  if (supabase) {
    const member = await findMemberByRsn(supabase, rsn);
    if (member) {
      memberRecord = member;
      await supabase
        .from("clan_members")
        .update({
          left_confirmed: true,
          pending_alert_message_id: null,
          pending_alert_type: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", member.id);
    }
  }

  await logMemberLeftToDiscord(memberRecord, interaction.user);
  await ensureRankListMessage().catch((e) => console.warn("[RankList] refresh failed:", e.message));

  // Auto-delete the alert message once the 2nd confirmation is marked as confirmed
  if (interaction.message?.deletable !== false) {
    await interaction.message?.delete().catch((e) => console.warn("[StaffAlert] Could not delete departure alert:", e.message));
  }
}

// ---- Temporary Voice Channel Creator Interaction Handlers ----
async function onVoiceCategorySelect(interaction) {
  const selectedKey = interaction.values?.[0];
  const cfg = getVoiceCategoryConfig(selectedKey);
  if (cfg) {
    selectedVoiceCategoryByUser.set(interaction.user.id, cfg.key);
  }
  return interaction.deferUpdate();
}

async function onVoiceCreateConfirm(interaction, categoryKeyFromButton) {
  const categoryKey = categoryKeyFromButton || selectedVoiceCategoryByUser.get(interaction.user.id);
  const cfg = getVoiceCategoryConfig(categoryKey);

  await interaction.deferUpdate();
  if (!cfg) return;

  // Enforce 5-minute per-user cooldown
  if (getVoiceCreateCooldownRemainingMs(interaction.user.id) > 0) {
    return;
  }

  try {
    await createTemporaryVoiceChannel(
      interaction.guild,
      cfg.key,
      interaction.user
    );
    voiceCreateLastAtByUser.set(interaction.user.id, Date.now());
    selectedVoiceCategoryByUser.delete(interaction.user.id);

    // Reset the dropdown on the permanent message so the same category can be selected again later
    await interaction.message?.edit?.(buildVoiceCreatorMessage()).catch(() => {});
  } catch (err) {
    console.error(`[TempVoice] Failed to create voice channel for ${interaction.user.id}:`, err.message);
  }
}

async function onVoiceCreateCancel(interaction) {
  selectedVoiceCategoryByUser.delete(interaction.user.id);
  return interaction.deferUpdate();
}

async function handleInteraction(interaction) {
  if (!interaction.inGuild()) return;

  if (interaction.isChatInputCommand?.() && interaction.commandName === "upload-roster") {
    return onUploadRosterSlashCommand(interaction);
  }

  if (interaction.isStringSelectMenu?.() && interaction.customId === ID.VOICE_CATEGORY_SELECT) {
    return onVoiceCategorySelect(interaction);
  }

  if (interaction.isButton()) {
    const [base, payload, extra] = interaction.customId.split(":");
    switch (base) {
      case ID.START:                return onStartButton(interaction);
      case ID.CONFIRM1:             return onConfirm1(interaction, payload);
      case ID.CONFIRM2:             return onConfirm2(interaction, payload);
      case ID.CANCEL:               return onCancel(interaction);
      case ID.ORIENT_LEADER:
      case ID.ORIENT_STAFF:
        return onOrientationAccept(interaction);
      case ID.RANK_LIST_REFRESH:    return onRankListRefresh(interaction);
      case ID.ROSTER_UPLOAD_BTN:    return onRosterUploadButton(interaction);
      case ID.ROSTER_PASTE_BTN:     return onRosterPasteButton(interaction);
      case ID.GROWTH_RANGE_30D:     return onGrowthRangeButton(interaction, "30d");
      case ID.GROWTH_RANGE_6M:      return onGrowthRangeButton(interaction, "6m");
      case ID.GROWTH_RANGE_ALL:     return onGrowthRangeButton(interaction, "all");
      case ID.RANKUP_C1:            return onRankUpConfirm1(interaction, payload, extra);
      case ID.RANKUP_C2:            return onRankUpConfirm2(interaction, payload, extra);
      case ID.RANKUP_CANCEL:        return onRankUpCancel(interaction, payload, extra);
      case ID.LEFT_C1:              return onMemberLeftConfirm1(interaction, payload);
      case ID.LEFT_C2:              return onMemberLeftConfirm2(interaction, payload);
      case ID.LEFT_CANCEL:          return onMemberLeftCancel(interaction, payload);
      case ID.VOICE_CREATE_CONFIRM: return onVoiceCreateConfirm(interaction, payload);
      case ID.VOICE_CREATE_CANCEL:  return onVoiceCreateCancel(interaction);
      default:                      return;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === ID.MODAL) return onModalSubmit(interaction);
    if (interaction.customId === ID.ROSTER_MODAL) return onRosterModalSubmit(interaction);
  }
}

// ================= WIRING =================
client.once(Events.ClientReady, async () => {
  console.log(`[Heimdall] Logged in as ${client.user.tag}`);
  try {
    await registerUploadRosterCommand();
  } catch (err) {
    console.error("[RosterUpload] registerUploadRosterCommand failed:", err.message);
  }
  try {
    await ensurePermanentMessage();
  } catch (err) {
    console.error("[Onboarding] ensurePermanentMessage failed:", err.message);
  }
  try {
    await ensureOrientationMessage();
  } catch (err) {
    console.error("[Orientation] ensureOrientationMessage failed:", err.message);
  }
  try {
    await ensureVoiceCreatorMessage();
    await scanExistingTempVoiceChannels();
  } catch (err) {
    console.error("[TempVoice] ensureVoiceCreatorMessage failed:", err.message);
  }
  try {
    if (getSupabase()) {
      await syncClanRanks();
    } else {
      await ensureRankListMessage();
    }
  } catch (err) {
    console.error("[RankSync] Initial ranking sync failed:", err.message);
  }
  try {
    startRankingSyncLoop();
  } catch (err) {
    console.error("[RankSync] startRankingSyncLoop failed:", err.message);
  }
  try {
    await syncWeeklyEvents(new Date(), { forcePoll: true });
    startWeeklyEventsLoop();
  } catch (err) {
    console.error("[WeeklyEvents] Initial sync failed:", err.message);
  }
});

client.on(Events.GuildMemberAdd, (member) => {
  handleMemberAdd(member).catch((e) => console.error("[Join] handler error:", e.message));
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  handleMemberUpdate(oldMember, newMember).catch((e) => console.error("[Update] handler error:", e.message));
});

client.on(Events.GuildMemberRemove, (member) => {
  handleMemberRemove(member).catch((e) => console.error("[Leave] handler error:", e.message));
});

client.on(Events.MessageCreate, (message) => {
  handleMessageCreate(message).catch((e) => console.error("[Message] handler error:", e.message));
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  handleVoiceStateUpdate(oldState, newState).catch((e) => console.error("[TempVoice] VoiceStateUpdate error:", e.message));
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    console.error("[Interaction] error:", err);
    const msg = { content: "Something went wrong. Please try again.", flags: MessageFlags.Ephemeral };
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch {}
  }
});

client.on(Events.Error, (err) => console.error("[Client] error:", err.message));
process.on("unhandledRejection", (err) => console.error("[Process] unhandledRejection:", err));

// Only log in when run directly (lets the file be required for testing).
if (require.main === module) {
  if (!BOT_TOKEN) {
    console.error("[Heimdall] BOT_TOKEN is not set.");
    process.exit(1);
  }
  client.login(BOT_TOKEN).catch((err) => {
    console.error("[Heimdall] Login failed:", err.message);
    process.exit(1);
  });
}

module.exports = {
  client,
  validateRsn,
  encodeName,
  decodeName,
  handleMemberAdd,
  handleMemberUpdate,
  handleMemberRemove,
  config,
  handleInteraction,
  ensurePermanentMessage,
  ensureOrientationMessage,
  buildOrientationMessage,
  buildVoiceCreatorMessage,
  ensureVoiceCreatorMessage,
  isManagedTempVoiceChannel,
  getNextVoiceChannelNumber,
  createTemporaryVoiceChannel,
  handleVoiceStateUpdate,
  scheduleTempVoiceDeletion,
  clearTempVoiceTimer,
  getVoiceCreateCooldownRemainingMs,
  clearVoiceCreateCooldown,
  deletePingsFor,
  // Ranking system exports
  CLAN_CREATION_DATE,
  RANK_TIERS,
  WEEKLY_BASE_XP,
  MONTHLY_BASE_XP,
  YEARLY_BASE_XP,
  parseJoinedDate,
  getRankForXp,
  getRankIndex,
  getRankEmoji,
  formatRankName,
  getNextRankTier,
  getTotalRankXp,
  getTenureRankXp,
  buildRankProgressBar,
  formatRankProgress,
  consumePendingRankXp,
  calculateTenureProgression,
  buildGrowthSeries,
  filterAndDownsampleGrowth,
  renderGrowthChartPng,
  buildGrowthChartEmbedAndAttachment,
  syncGrowthHistoryToSupabase,
  buildRankListPayload,
  buildRankUpAlertStep1,
  buildRankUpAlertStep2,
  buildMemberLeftAlertStep1,
  buildMemberLeftAlertStep2,
  ensureRankListMessage,
  syncClanRanks,
  parseRosterText,
  importRosterRows,
  processRosterUpload,
  canUploadRoster,
  handleMessageCreate,
  ID,
  UNVERIFIED_ROLE_ID,
  CLAN_MEMBER_ROLE_ID,
  OSRS_ROLE_ID,
  ONBOARDING_CHANNEL_ID,
  ORIENTATION_CHANNEL_ID,
  OWNER_ROLE_ID,
  CO_OWNER_ROLE_ID,
  LEADER_ROLE_ID,
  ROSTER_UPLOAD_ROLE_IDS,
  STAFF_ROLE_ID,
  JR_STAFF_ROLE_ID,
  VERIFIED_LEADER_ROLE_ID,
  VERIFIED_STAFF_ROLE_ID,
  STAFF_ALERT_CHANNEL_ID,
  RANK_LIST_CHANNEL_ID,
  RANK_LOG_CHANNEL_ID,
  CREATE_VOICE_CHANNEL_ID,
  SOCIAL_HUB_CATEGORY_ID,
  OSRS_CATEGORY_ID,
  OTHER_GAMES_CATEGORY_ID,
  VOICE_CATEGORIES,
  VOICE_EMPTY_TIMEOUT_MS,
  VOICE_INITIAL_EMPTY_TIMEOUT_MS,
  VOICE_CREATE_COOLDOWN_MS,
  // Weekly Events exports
  WEEKLY_EVENTS_CHANNEL_ID,
  WEEKLY_EVENT_POLL_INTERVAL_MS,
  WEEKLY_EVENTS_ANCHOR_ISO,
  FRACTURED_ARCHIVES_UNLOCK_DATE,
  OSRS_SKILLS,
  OSRS_BOSSES,
  getEligibleBosses,
  pickWeeklyEventTarget,
  getWeeklyEventSchedule,
  fetchPlayerHiscores,
  extractHiscoreMetric,
  pollWeeklyEventHiscores,
  buildSotwEmbedPayload,
  buildBotwEmbedPayload,
  ensureWeeklyEventsMessages,
  syncWeeklyEvents,
  startWeeklyEventsLoop,
};
