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
  OverwriteType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
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

// ================= SERVER PRIVACY (channel/category visibility) =================
// Roles granted during Discord's own native onboarding flow (not by the bot).
const CLAN_FRIEND_ROLE_ID    = "1559320122223493151";
const SOCIAL_CHATTER_ROLE_ID = "1546419961638035477";

// Categories this bot manages access to. OSRS_VOICE_CATEGORY_ID (defined further
// below) doubles as the "Clan Chat" category — the OSRS temp voice channels live
// in the same category as the rest of general clan chat.
const WELCOME_CATEGORY_ID     = "1546571345859575868";
const STAFF_AREA_CATEGORY_ID  = "1546415658458292394";
const SOCIAL_HUB_CATEGORY_ID  = "1546412771598532628";
const SERVER_LOGS_CATEGORY_ID = "1546419055064522812";

// Individual channels inside the categories above that need their own rule
// rather than the category's default.
const STAFF_CHAT_CHANNEL_ID   = "1546416935217139722";
const LEADER_CHANNEL_ID       = "1546416683684593724";
const OWNER_CHAT_CHANNEL_ID   = "1560000052435619901";
const CLAN_CHAT_CHANNEL_ID    = "1561154983120863303";

// #server-logs is restricted to this one Discord account specifically, not a
// role — so it stays private even if more people are ever given the Owner role.
const SERVER_LOGS_OWNER_USER_ID = "351190870416031744";

// ================= TICKETING SYSTEM =================
const TICKET_CONTACT_CHANNEL_ID    = "1546566171317506098"; // Permanent panel w/ the dropdown lives here
const TICKET_CATEGORY_ID           = "1546573889532993606"; // New ticket channels are created under this category
const TICKET_TRANSCRIPT_CHANNEL_ID = "1546574241909047406"; // Closed-ticket transcripts are posted here
// New-ticket alerts reuse the existing Staff Alert channel (STAFF_ALERT_CHANNEL_ID) —
// it's the same channel ID the clan already uses for rank-up/member-left alerts.
const TICKET_CLOSE_DELETE_DELAY_MS = 10 * 1000; // Ticket channel is deleted 10s after it's closed

const STAFF_APPLICATION_QUESTIONS = [
  "Why do you want to be on Staff?",
  "Do you have any issues with helping recruitment, events, or moderation?",
  "What new ideas/events could you come up with for us to do as a clan?",
  "Anything else you want to provide that may help your application?",
];

// Roles allowed to VIEW each ticket type's channel. The member who opened a
// ticket can always see their own channel regardless of this list.
//   - Co-Owners see every ticket type.
//   - Leaders see everything except reports made against a Leader/Staff member.
//   - Staff see member reports, help requests, and staff applications — not
//     reports made against a Leader/Staff member.
//   - Jr. Staff only see help requests and member reports.
const TICKET_TYPES = {
  help: {
    key: "help",
    label: "Need Help/Ask a Question",
    selectDescription: "General questions or need a hand with something",
    instructions: "Please detail your problem or question as much as you can. A staff member will be with you shortly.",
    allowedRoleIds: [CO_OWNER_ROLE_ID, LEADER_ROLE_ID, STAFF_ROLE_ID, JR_STAFF_ROLE_ID],
    isApplication: false,
  },
  report_member: {
    key: "report_member",
    label: "Report an Issue with Another Clan Member",
    selectDescription: "Report a problem involving a fellow clan member",
    instructions:
      "Please detail what the issue is, who it is about, and provide any screenshots or other evidence to support your report.",
    allowedRoleIds: [CO_OWNER_ROLE_ID, LEADER_ROLE_ID, STAFF_ROLE_ID, JR_STAFF_ROLE_ID],
    isApplication: false,
  },
  report_staff: {
    key: "report_staff",
    label: "Report an Issue with a Leader/Staff Member",
    selectDescription: "Report a problem involving a Leader or Staff member",
    instructions:
      "Please detail what the issue is, who it is about, and provide any screenshots or other evidence to support your report.\n\n" +
      "This ticket is only visible to Co-Owners.",
    allowedRoleIds: [CO_OWNER_ROLE_ID],
    isApplication: false,
  },
  apply_staff: {
    key: "apply_staff",
    label: "Apply for Staff",
    selectDescription: "Submit an application to join the Staff team",
    instructions: null, // Built separately from STAFF_APPLICATION_QUESTIONS
    allowedRoleIds: [CO_OWNER_ROLE_ID, LEADER_ROLE_ID, STAFF_ROLE_ID],
    isApplication: true,
  },
  compliment: {
    key: "compliment",
    label: "Give Compliment",
    selectDescription: "Say something nice about the clan or a specific clan member",
    instructions: null, // Built separately — see buildComplimentEmbed
    // NOTE: unlike the other types, compliments are visible to every Clan Member,
    // not just Leadership/Staff — see buildComplimentPermissionOverwrites, which
    // is used instead of buildTicketPermissionOverwrites for this type.
    allowedRoleIds: [CLAN_MEMBER_ROLE_ID],
    isApplication: false,
    isCompliment: true,
  },
};

const TICKET_TYPE_ORDER = ["help", "report_member", "report_staff", "apply_staff", "compliment"];

// OSRS Voice Hub — joining this channel immediately redirects the member into
// a brand-new temporary "OSRS Voice N" channel instead of letting them sit in the hub.
const OSRS_VOICE_HUB_CHANNEL_ID           = "1566285643200602123";
const OSRS_VOICE_CATEGORY_ID              = "1545654996928823377";
const OSRS_VOICE_PREFIX                   = "OSRS Voice";
const OSRS_VOICE_EMPTY_TIMEOUT_MS         = 2 * 60 * 1000; // Auto-delete 2 minutes after last person leaves
const OSRS_VOICE_INITIAL_EMPTY_TIMEOUT_MS = 60 * 1000;     // Safety net: delete if the member never actually joins

// Weekly Events (Skill of the Week & Boss of the Week)
const WEEKLY_EVENTS_CHANNEL_ID       = "1562600669796507760";
const WEEKLY_EVENT_POLL_INTERVAL_MS  = 2 * 60 * 60 * 1000; // Poll OSRS HiScores every 2 hours starting Friday 00:00 Central
const WEEKLY_EVENTS_TIMEZONE         = "America/Chicago";  // Central Time (CST/CDT)
const WEEKLY_EVENTS_ANCHOR_DATE      = { year: 2026, month: 10, day: 23 }; // Friday, Oct 23, 2026
const WEEKLY_EVENTS_ANCHOR_ISO       = "2026-10-23T00:00:00-05:00"; // First SOTW starts Friday, Oct 23, 2026 at 00:00 Central
const FRACTURED_ARCHIVES_UNLOCK_DATE = "2027-04-21"; // 6-month restriction from 2026-10-21

// Weekly HiScores Snapshot & Recap (posted every Sunday at 5:00 PM Central)
const WEEKLY_RECAP_CHANNEL_ID   = "1546413698979995678";
const WEEKLY_RECAP_HOUR         = 17; // 5:00 PM, 24h clock, America/Chicago
const WEEKLY_RECAP_ANCHOR_DATE  = { year: 2026, month: 11, day: 1 }; // First recap posts Sunday, Nov 1, 2026 at 17:00 Central

// Recruitment Drive Event — everything (announcement, leaderboard, per-member
// evidence threads) lives in this single channel.
const RECRUITMENT_DRIVE_CHANNEL_ID   = "1567981016642097324";
const RECRUITMENT_DRIVE_PRIZE_TEXT   = "2 Bonds";
const RECRUITMENT_UPLOAD_WINDOW_MS   = 10 * 60 * 1000; // 10 minutes to post a screenshot after clicking the button
const RECRUITMENT_THREAD_AUTO_ARCHIVE_MINUTES = 10080; // 1 week — the max; new posts keep un-archiving it
// Start/end instants (America/Chicago) are computed further down, right after
// centralTimeToUtcMs() is defined — see RECRUITMENT_DRIVE_START_MS / _END_MS.
const RECRUITMENT_STAFF_ROLE_IDS = [
  OWNER_ROLE_ID,
  CO_OWNER_ROLE_ID,
  LEADER_ROLE_ID,
  STAFF_ROLE_ID,
  JR_STAFF_ROLE_ID,
];

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

// ---- Weekly Recap boss/activity pools ----
// Raids get their own leaderboard category instead of being lumped in with regular PvM.
const RAID_NAMES = ["Chambers of Xeric", "Theatre of Blood", "Tombs of Amascut", "The Fractured Archives"];
const RAID_BOSS_ENTRIES = OSRS_BOSSES.filter((b) => RAID_NAMES.includes(b.name));

// The clan only tracks these three minigames for the "most popular minigame" category.
const OSRS_MINIGAMES = [
  { name: "Wintertodt",             hiscoreNames: ["Wintertodt"] },
  { name: "Guardians of the Rift",  hiscoreNames: ["Rifts closed", "Guardians of the Rift"] },
  { name: "Tempoross",              hiscoreNames: ["Tempoross"] },
];
const MINIGAME_NAMES = OSRS_MINIGAMES.map((m) => m.name);

// Regular PvM pool = every OSRS_BOSSES entry that isn't a raid or one of the tracked minigames.
const PVM_BOSS_ENTRIES = OSRS_BOSSES.filter(
  (b) => !RAID_NAMES.includes(b.name) && !MINIGAME_NAMES.includes(b.name)
);

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
  serverPrivacySyncIntervalMs: 30 * 60 * 1000, // Recheck channel/category permissions every 30 minutes
  weeklyEventPollIntervalMs: WEEKLY_EVENT_POLL_INTERVAL_MS,
  osrsVoiceEmptyTimeoutMs: OSRS_VOICE_EMPTY_TIMEOUT_MS,
  osrsVoiceInitialEmptyTimeoutMs: OSRS_VOICE_INITIAL_EMPTY_TIMEOUT_MS,
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
  // Ticketing system custom IDs
  TICKET_SELECT:        "ticket_select",
  TICKET_CONFIRM:       "ticket_confirm",
  TICKET_CANCEL:        "ticket_cancel",
  TICKET_CLOSE_C1:      "ticket_close_c1",
  TICKET_CLOSE_C2:      "ticket_close_c2",
  TICKET_CLOSE_CANCEL:  "ticket_close_cancel",
  TICKET_ACCEPT_C1:     "ticket_accept_c1",
  TICKET_ACCEPT_C2:     "ticket_accept_c2",
  TICKET_ACCEPT_CANCEL: "ticket_accept_cancel",
  TICKET_DENY_C1:       "ticket_deny_c1",
  TICKET_DENY_C2:       "ticket_deny_c2",
  TICKET_DENY_CANCEL:   "ticket_deny_cancel",
  TICKET_DENY_MODAL:        "ticket_deny_modal",
  TICKET_DENY_REASON_INPUT: "ticket_deny_reason_input",
  TICKET_ALERT_ACK:     "ticket_alert_ack",
  // Give Compliment sub-flow custom IDs
  TICKET_COMPLIMENT_TARGET:        "ticket_compliment_target",
  TICKET_COMPLIMENT_USER_SELECT:   "ticket_compliment_user_select",
  TICKET_COMPLIMENT_USER_CONFIRM:  "ticket_compliment_user_confirm",
  TICKET_COMPLIMENT_USER_CANCEL:   "ticket_compliment_user_cancel",
  TICKET_COMPLIMENT_MODAL_GENERAL: "ticket_compliment_modal_general",
  TICKET_COMPLIMENT_MODAL_MEMBER:  "ticket_compliment_modal_member",
  TICKET_COMPLIMENT_MESSAGE_INPUT: "ticket_compliment_message_input",
  // Recruitment Drive Event custom IDs
  RECRUITMENT_UPLOAD_BTN:    "recruitment_upload_btn",
  RECRUITMENT_CONFIRM_BONUS: "recruitment_confirm_bonus",
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

// Like getChannelById, but for categories/voice channels that aren't text-based
// (getChannelById intentionally rejects those so text-only code never gets one
// handed to it by mistake).
async function getAnyChannelById(channelId, label = "Channel") {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error(`[${label}] Channel ${channelId} not found.`);
    return null;
  }
  return channel;
}

const getOnboardingChannel = () => getChannelById(ONBOARDING_CHANNEL_ID, "Onboarding");
const getStaffAlertChannel = () => getChannelById(STAFF_ALERT_CHANNEL_ID, "StaffAlert");
const getRankListChannel   = () => getChannelById(RANK_LIST_CHANNEL_ID, "RankList");
const getRankLogChannel    = () => getChannelById(RANK_LOG_CHANNEL_ID, "RankLog");
const getWeeklyRecapChannel = () => getChannelById(WEEKLY_RECAP_CHANNEL_ID, "WeeklyRecap");

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

// ================= TICKETING SYSTEM =================
// A permanent dropdown panel in the Contact Us channel lets a member pick a
// reason to reach out. After they confirm their pick, a private ticket
// channel is created under TICKET_CATEGORY_ID, visible only to the member
// and whichever roles are allowed to see that ticket type (TICKET_TYPES).
//
// Ticket state (who opened it, which type, when) is stored in the channel's
// topic as a small JSON blob rather than in a database — the channel itself
// is the only place that state needs to live, and it disappears exactly when
// the ticket does.
const TICKET_TOPIC_PREFIX = "HEIMDALL_TICKET::";

function encodeTicketTopic(data) {
  return `${TICKET_TOPIC_PREFIX}${JSON.stringify(data)}`;
}

function decodeTicketTopic(topic) {
  if (typeof topic !== "string" || !topic.startsWith(TICKET_TOPIC_PREFIX)) return null;
  try {
    const parsed = JSON.parse(topic.slice(TICKET_TOPIC_PREFIX.length));
    if (!parsed || typeof parsed !== "object" || !parsed.type || !parsed.openerId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function slugifyForChannelName(text) {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return slug || "member";
}

const TICKET_CHANNEL_NAME_SLUGS = {
  help: "help",
  report_member: "member-report",
  report_staff: "staff-report",
  apply_staff: "staff-app",
};

function buildTicketChannelName(type, user) {
  const typeSlug = TICKET_CHANNEL_NAME_SLUGS[type.key] || "ticket";
  const userSlug = slugifyForChannelName(user?.username || user?.tag || user?.id);
  return `ticket-${typeSlug}-${userSlug}`.slice(0, 90);
}

async function findOpenTicketChannel(guild, openerId, typeKey) {
  const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
  for (const ch of channels.values()) {
    if (!ch || ch.parentId !== TICKET_CATEGORY_ID) continue;
    const meta = decodeTicketTopic(ch.topic);
    if (meta && meta.openerId === openerId && meta.type === typeKey) return ch;
  }
  return null;
}

function buildTicketPermissionOverwrites(guild, type, openerId) {
  const viewPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];

  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, // @everyone
    { id: openerId, allow: viewPerms },
  ];

  for (const roleId of type.allowedRoleIds) {
    overwrites.push({ id: roleId, allow: [...viewPerms, PermissionFlagsBits.ManageMessages] });
  }

  if (client.user?.id) {
    overwrites.push({
      id: client.user.id,
      allow: [...viewPerms, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages],
    });
  }

  return overwrites;
}

// ---- Permanent ticket panel (dropdown) ----
function buildTicketPanelMessage() {
  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle("Contact Us")
    .setDescription(
      "Need something from Leadership or Staff? Pick the option below that best matches why you're reaching out, " +
      "confirm your choice, and a private ticket channel will be created just for you.\n\n" +
      "Only you and the roles who need to see that type of ticket will be able to see the channel."
    )
    .addFields(
      TICKET_TYPE_ORDER.map((key) => ({
        name: TICKET_TYPES[key].label,
        value: TICKET_TYPES[key].selectDescription,
      }))
    )
    .setFooter({ text: "Odinheim • Contact Us" });

  const select = new StringSelectMenuBuilder()
    .setCustomId(ID.TICKET_SELECT)
    .setPlaceholder("Select a reason for contacting us...")
    .addOptions(
      TICKET_TYPE_ORDER.map((key) => ({
        label: TICKET_TYPES[key].label,
        description: TICKET_TYPES[key].selectDescription,
        value: key,
      }))
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

async function ensureTicketPanelMessage() {
  return ensureEmbedMessage({
    channelId: TICKET_CONTACT_CHANNEL_ID,
    label: "Tickets",
    buttonIds: [ID.TICKET_SELECT],
    payload: buildTicketPanelMessage(),
    what: "ticket panel embed",
  });
}

// ---- In-ticket opening message ----
function buildTicketOpeningMessage(type, openerId) {
  const lines = [`Opened by <@${openerId}>.`, ""];

  if (type.isApplication) {
    lines.push("Please answer the following questions. Try to be as honest and detailed as possible:", "");
    STAFF_APPLICATION_QUESTIONS.forEach((q, i) => lines.push(`**${i + 1}. ${q}**`));
  } else {
    lines.push(type.instructions);
  }

  const embed = new EmbedBuilder()
    .setColor(type.isApplication ? COLOR.gold : COLOR.main)
    .setTitle(type.label)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Odinheim Ticket System" })
    .setTimestamp();

  const components = [];
  if (type.isApplication) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(ID.TICKET_ACCEPT_C1).setLabel("Accept Application").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(ID.TICKET_DENY_C1).setLabel("Deny Application").setStyle(ButtonStyle.Secondary)
      )
    );
  }
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(ID.TICKET_CLOSE_C1).setLabel("Close Ticket").setStyle(ButtonStyle.Danger)
    )
  );

  return { embeds: [embed], components };
}

// ---- Ticket-open alert (single confirmation, auto-deletes on click) ----
async function sendTicketOpenAlert(type, user, channel) {
  const alertChannel = await getStaffAlertChannel();
  if (!alertChannel) return;

  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle("New Ticket Opened")
    .setDescription(`**${user.tag}** opened a **${type.label}** ticket: ${channel}`)
    .setFooter({ text: "Click Acknowledge to dismiss this alert." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID.TICKET_ALERT_ACK).setLabel("Acknowledge").setStyle(ButtonStyle.Primary)
  );

  await alertChannel.send({ embeds: [embed], components: [row] }).catch((e) =>
    console.warn("[Tickets] Could not send ticket-open alert:", e.message)
  );
}

async function onTicketAlertAck(interaction) {
  await interaction.deferUpdate().catch(() => {});
  await interaction.message?.delete().catch((e) => console.warn("[Tickets] Could not delete ticket alert:", e.message));
}

// ---- Dropdown selection -> single confirmation -> channel creation ----
async function onTicketSelect(interaction) {
  const typeKey = interaction.values?.[0];
  const type = TICKET_TYPES[typeKey];
  if (!type) {
    return interaction.reply({ content: "That option isn't valid. Please try again.", flags: MessageFlags.Ephemeral });
  }

  // Compliments have their own multi-step flow (who it's for, then the
  // message) instead of the plain Confirm/Cancel used by the other types.
  if (type.isCompliment) {
    return onComplimentTypeSelected(interaction);
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle("Confirm Your Ticket")
    .setDescription(
      `You selected **${type.label}**.\n\n` +
      "Click **Confirm** to open a private ticket channel, or **Cancel** to pick something else."
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID.TICKET_CONFIRM}:${typeKey}`).setLabel("Confirm").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ID.TICKET_CANCEL).setLabel("Cancel").setStyle(ButtonStyle.Danger)
  );

  return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

// ---- Give Compliment sub-flow ----
// Give Compliment -> General Clan / Specific Member -> (Specific Member only:
// pick + confirm a member) -> a modal asking what the compliment is about ->
// the compliment is posted in a brand-new private channel, THEN (only once
// the message is already there) the Clan Member role (and, for a specific
// member, that member) are pinged.
function buildComplimentUserSelectMessage({ warning = null } = {}) {
  const embed = new EmbedBuilder()
    .setColor(warning ? COLOR.bad : COLOR.warn)
    .setTitle("Pick a Member to Compliment")
    .setDescription(
      (warning ? `${warning}\n\n` : "") +
      "Use the menu below to pick the member you'd like to compliment. They need to have the Clan Member role."
    );

  const select = new UserSelectMenuBuilder()
    .setCustomId(ID.TICKET_COMPLIMENT_USER_SELECT)
    .setPlaceholder("Select a clan member...");

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

async function onComplimentTypeSelected(interaction) {
  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle("Give a Compliment")
    .setDescription("Who would you like to compliment?");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID.TICKET_COMPLIMENT_TARGET}:general`).setLabel("General Clan").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${ID.TICKET_COMPLIMENT_TARGET}:member`).setLabel("Specific Member").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ID.TICKET_CANCEL).setLabel("Cancel").setStyle(ButtonStyle.Danger)
  );

  return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

function buildComplimentModal(kind, targetUserId = null) {
  const customId = kind === "general" ? ID.TICKET_COMPLIMENT_MODAL_GENERAL : `${ID.TICKET_COMPLIMENT_MODAL_MEMBER}:${targetUserId}`;
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(kind === "general" ? "Compliment the Clan" : "Compliment a Member");

  const input = new TextInputBuilder()
    .setCustomId(ID.TICKET_COMPLIMENT_MESSAGE_INPUT)
    .setLabel("What would you like to say?")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(1)
    .setMaxLength(1500)
    .setRequired(true)
    .setPlaceholder("Explain what the compliment is about and who it's for.");

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

async function onTicketComplimentTarget(interaction, kind) {
  if (kind === "general") {
    return interaction.showModal(buildComplimentModal("general"));
  }
  if (kind === "member") {
    return interaction.update(buildComplimentUserSelectMessage());
  }
  return interaction.reply({ content: "That option isn't valid. Please try again.", flags: MessageFlags.Ephemeral });
}

async function onTicketComplimentUserSelect(interaction) {
  const targetUserId = interaction.values?.[0];
  if (!targetUserId) {
    return interaction.update(buildComplimentUserSelectMessage({ warning: "Please pick a member." }));
  }

  const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  if (!targetMember || !memberHasRole(targetMember, CLAN_MEMBER_ROLE_ID)) {
    return interaction.update(buildComplimentUserSelectMessage({ warning: "That member doesn't have the Clan Member role." }));
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle("Confirm Your Selection")
    .setDescription(`You selected <@${targetUserId}>. Is this correct?`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID.TICKET_COMPLIMENT_USER_CONFIRM}:${targetUserId}`).setLabel("Confirm").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ID.TICKET_COMPLIMENT_USER_CANCEL).setLabel("Pick Someone Else").setStyle(ButtonStyle.Secondary)
  );

  return interaction.update({ embeds: [embed], components: [row] });
}

async function onTicketComplimentUserCancel(interaction) {
  return interaction.update(buildComplimentUserSelectMessage());
}

async function onTicketComplimentUserConfirm(interaction, targetUserId) {
  return interaction.showModal(buildComplimentModal("member", targetUserId));
}

function buildComplimentChannelName(kind, user) {
  const slug = slugifyForChannelName(user?.username || user?.tag || user?.id);
  return `compliment-${kind}-${slug}`.slice(0, 90);
}

function buildComplimentPermissionOverwrites(guild, extraUserIds = []) {
  const viewPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];

  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, // @everyone
    { id: CLAN_MEMBER_ROLE_ID, allow: viewPerms }, // Visible to every Clan Member, not just staff
  ];

  for (const userId of extraUserIds) {
    if (!overwrites.some((o) => o.id === userId)) {
      overwrites.push({ id: userId, allow: viewPerms });
    }
  }

  if (client.user?.id) {
    overwrites.push({
      id: client.user.id,
      allow: [...viewPerms, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages],
    });
  }

  return overwrites;
}

function buildComplimentEmbed({ giverId, kind, targetId, message }) {
  const isGeneral = kind === "general";
  return new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle(isGeneral ? "A Compliment for the Whole Clan" : "A Compliment for a Clan Member")
    .addFields(
      { name: "From", value: `<@${giverId}>`, inline: true },
      { name: "About", value: isGeneral ? "The whole clan" : `<@${targetId}>`, inline: true }
    )
    .addFields({ name: "Message", value: message.slice(0, 1024) })
    .addFields({
      name: "Thank You",
      value: `Thank you <@${giverId}> for taking the time to share this — we appreciate you just as much!`,
    })
    .setFooter({ text: "Odinheim Ticket System" })
    .setTimestamp();
}

async function createComplimentTicket(interaction, { kind, targetId, message }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const extraUserIds = [interaction.user.id];
  if (targetId) extraUserIds.push(targetId);

  let channel;
  try {
    channel = await guild.channels.create({
      name: buildComplimentChannelName(kind, interaction.user),
      type: ChannelType.GuildText,
      parent: TICKET_CATEGORY_ID,
      topic: encodeTicketTopic({
        type: "compliment",
        complimentKind: kind,
        openerId: interaction.user.id,
        openerTag: interaction.user.tag,
        targetId: targetId || null,
        openedAt: Date.now(),
      }),
      permissionOverwrites: buildComplimentPermissionOverwrites(guild, extraUserIds),
      reason: `Compliment ticket opened by ${interaction.user.tag}`,
    });
  } catch (err) {
    console.error(`[Tickets] Could not create compliment channel for ${interaction.user.id}:`, err.message);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.bad)
          .setTitle("I couldn't share this")
          .setDescription("Something went wrong creating the channel. Please try again."),
      ],
    });
  }

  // Post the compliment itself first — no pings yet, so the content is
  // already there by the time anyone's notification brings them in.
  await channel
    .send({
      embeds: [buildComplimentEmbed({ giverId: interaction.user.id, kind, targetId, message })],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(ID.TICKET_CLOSE_C1).setLabel("Close Ticket").setStyle(ButtonStyle.Danger)
        ),
      ],
    })
    .catch((e) => console.warn("[Tickets] Could not post compliment message:", e.message));

  const pingContent =
    kind === "general"
      ? `<@&${CLAN_MEMBER_ROLE_ID}> a new compliment for the clan was just shared above!`
      : `<@&${CLAN_MEMBER_ROLE_ID}> <@${targetId}> you just received a compliment above!`;
  await channel.send({ content: pingContent }).catch((e) => console.warn("[Tickets] Could not send compliment ping:", e.message));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR.ok)
        .setTitle("Compliment Shared")
        .setDescription(`Thank you for sharing that — it's posted here: ${channel}`),
    ],
  });
}

async function onTicketComplimentModalGeneral(interaction) {
  const message = interaction.fields.getTextInputValue(ID.TICKET_COMPLIMENT_MESSAGE_INPUT);
  await createComplimentTicket(interaction, { kind: "general", targetId: null, message });
}

async function onTicketComplimentModalMember(interaction, targetUserId) {
  const message = interaction.fields.getTextInputValue(ID.TICKET_COMPLIMENT_MESSAGE_INPUT);

  // Re-check at submit time in case the role changed between confirming and submitting.
  const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  if (!targetMember || !memberHasRole(targetMember, CLAN_MEMBER_ROLE_ID)) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.bad)
          .setTitle("Couldn't Create Compliment")
          .setDescription("That member no longer has the Clan Member role. Please start over from the ticket panel."),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  await createComplimentTicket(interaction, { kind: "member", targetId: targetUserId, message });
}

async function onTicketCancel(interaction) {
  return interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR.warn)
        .setTitle("Cancelled")
        .setDescription("No ticket was created. Use the dropdown in the ticket panel whenever you're ready."),
    ],
    components: [],
  });
}

async function onTicketConfirm(interaction, typeKey) {
  const type = TICKET_TYPES[typeKey];
  if (!type) {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.bad)
          .setTitle("Something went wrong")
          .setDescription("That ticket type is no longer valid. Please pick again from the ticket panel."),
      ],
      components: [],
    });
  }

  await interaction.deferUpdate();

  const guild = interaction.guild;
  const existing = await findOpenTicketChannel(guild, interaction.user.id, typeKey).catch(() => null);
  if (existing) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.warn)
          .setTitle("You already have a ticket open")
          .setDescription(`You already have an open **${type.label}** ticket: ${existing}.`),
      ],
      components: [],
    });
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name: buildTicketChannelName(type, interaction.user),
      type: ChannelType.GuildText,
      parent: TICKET_CATEGORY_ID,
      topic: encodeTicketTopic({
        type: typeKey,
        openerId: interaction.user.id,
        openerTag: interaction.user.tag,
        openedAt: Date.now(),
      }),
      permissionOverwrites: buildTicketPermissionOverwrites(guild, type, interaction.user.id),
      reason: `Ticket opened by ${interaction.user.tag} (${type.label})`,
    });
  } catch (err) {
    console.error(`[Tickets] Could not create ticket channel for ${interaction.user.id}:`, err.message);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.bad)
          .setTitle("I couldn't open your ticket")
          .setDescription("Something went wrong creating the channel. Please try again, or reach out to a staff member directly."),
      ],
      components: [],
    });
  }

  await channel
    .send({ content: `<@${interaction.user.id}>`, ...buildTicketOpeningMessage(type, interaction.user.id) })
    .catch((e) => console.warn("[Tickets] Could not post ticket opening message:", e.message));

  await sendTicketOpenAlert(type, interaction.user, channel);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR.ok)
        .setTitle("Ticket Created")
        .setDescription(`Your ticket has been created: ${channel}`),
    ],
    components: [],
  });
}

// ---- Close / Accept / Deny authorization ----
function isTicketParticipant(member, meta) {
  if (!member || !meta) return false;
  if (member.id === meta.openerId) return true;
  return hasAnyRole(member, [CO_OWNER_ROLE_ID, LEADER_ROLE_ID, STAFF_ROLE_ID, JR_STAFF_ROLE_ID]);
}

function isTicketDecisionMaker(member, meta) {
  if (!member || !meta) return false;
  if (member.id === meta.openerId) return false; // Applicants can't decide their own application
  return hasAnyRole(member, [CO_OWNER_ROLE_ID, LEADER_ROLE_ID, STAFF_ROLE_ID, JR_STAFF_ROLE_ID]);
}

function ticketNotFoundEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR.bad)
    .setTitle("Something went wrong")
    .setDescription("This doesn't look like an active ticket channel anymore.");
}

function ticketNotAllowedEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR.bad)
    .setTitle("This isn't available to you")
    .setDescription("You don't have permission to do that in this ticket.");
}

// ---- Transcript generation & shared closing logic ----
async function buildChannelTranscript(channel) {
  const allMessages = [];
  let before;
  // Ticket channels are expected to be short-lived, but cap pagination at
  // 200 pages (20,000 messages) as a sane upper bound against an abused channel.
  for (let i = 0; i < 200; i++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch || batch.size === 0) break;
    allMessages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  allMessages.reverse(); // oldest first

  if (allMessages.length === 0) return "(No messages were sent in this ticket.)";

  return allMessages
    .map((m) => {
      const ts = new Date(m.createdTimestamp).toISOString().replace("T", " ").slice(0, 19);
      const author = m.author ? `${m.author.tag} (${m.author.id})` : "Unknown";
      const content = m.content || "";
      const attachments = m.attachments?.size
        ? [...m.attachments.values()].map((a) => `[attachment: ${a.url}]`).join(" ")
        : "";
      return `[${ts}] ${author}: ${content}${attachments ? ` ${attachments}` : ""}`.trim();
    })
    .join("\n");
}

async function finalizeTicketClosure(channel, meta, closerUser, options = {}) {
  const type = TICKET_TYPES[meta.type] || { label: "Ticket" };
  const transcriptBody = await buildChannelTranscript(channel).catch((e) => {
    console.warn("[Tickets] Could not build transcript:", e.message);
    return "(Could not generate transcript.)";
  });

  const header =
    `Ticket Transcript\n` +
    `Channel: #${channel.name} (${channel.id})\n` +
    `Type: ${type.label}\n` +
    `Opened by: ${meta.openerTag || meta.openerId} (${meta.openerId})\n` +
    `Opened at: ${meta.openedAt ? new Date(meta.openedAt).toISOString() : "unknown"}\n` +
    `Closed by: ${closerUser.tag} (${closerUser.id})\n` +
    `Closed at: ${new Date().toISOString()}\n` +
    (options.decision ? `Decision: ${options.decision}\n` : "") +
    (options.reason ? `Reason: ${options.reason}\n` : "") +
    `\n----------------------------------------\n\n`;

  const fullTranscript = header + transcriptBody;
  const fileName = `transcript-${channel.name}.txt`;

  // Post to the transcript log channel
  const transcriptChannel = await getChannelById(TICKET_TRANSCRIPT_CHANNEL_ID, "TicketTranscript");
  if (transcriptChannel) {
    const summaryEmbed = new EmbedBuilder()
      .setColor(COLOR.main)
      .setTitle(`Ticket Closed — ${type.label}`)
      .addFields(
        { name: "Opened By", value: `<@${meta.openerId}>`, inline: true },
        { name: "Closed By", value: `<@${closerUser.id}>`, inline: true },
        { name: "Channel", value: `#${channel.name}`, inline: true }
      );
    if (options.decision) summaryEmbed.addFields({ name: "Decision", value: options.decision, inline: true });
    if (options.reason) summaryEmbed.addFields({ name: "Reason", value: options.reason.slice(0, 1024), inline: false });

    await transcriptChannel
      .send({ embeds: [summaryEmbed], files: [new AttachmentBuilder(Buffer.from(fullTranscript, "utf8"), { name: fileName })] })
      .catch((e) => console.warn("[Tickets] Could not post transcript:", e.message));
  }

  // DM a copy to the member who opened the ticket
  try {
    const openerUser = await client.users.fetch(meta.openerId);
    const dmEmbed = new EmbedBuilder()
      .setColor(COLOR.main)
      .setTitle(`Your Ticket Has Been Closed — ${type.label}`)
      .setDescription(
        `Your **${type.label}** ticket has been closed by **${closerUser.tag}**.` +
        (options.decision ? `\n\n**Decision:** ${options.decision}` : "") +
        (options.reason ? `\n**Reason:** ${options.reason}` : "") +
        `\n\nA full transcript is attached.`
      );
    await openerUser.send({
      embeds: [dmEmbed],
      files: [new AttachmentBuilder(Buffer.from(fullTranscript, "utf8"), { name: fileName })],
    });
  } catch (err) {
    console.warn(`[Tickets] Could not DM transcript to ${meta.openerId}:`, err.message);
  }

  await channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.warn)
          .setTitle("Ticket Closed")
          .setDescription("This channel will be deleted in 10 seconds."),
      ],
    })
    .catch(() => {});

  const deleteTimer = setTimeout(async () => {
    await channel.delete("Ticket closed").catch((e) =>
      console.warn(`[Tickets] Could not delete ticket channel ${channel.id}:`, e.message)
    );
  }, TICKET_CLOSE_DELETE_DELAY_MS);
  if (typeof deleteTimer.unref === "function") deleteTimer.unref();
}

// ---- Close Ticket (2-step confirmation) ----
async function onTicketCloseC1(interaction) {
  const meta = decodeTicketTopic(interaction.channel?.topic);
  if (!meta) return interaction.reply({ embeds: [ticketNotFoundEmbed()], flags: MessageFlags.Ephemeral });
  if (!isTicketParticipant(interaction.member, meta)) {
    return interaction.reply({ embeds: [ticketNotAllowedEmbed()], flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle("Confirmation 1 of 2 — Close Ticket")
    .setDescription(
      "Are you sure you want to close this ticket? This will save a transcript, DM it to the member who opened it, " +
      "and delete this channel shortly after."
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID.TICKET_CLOSE_C2).setLabel("Yes, Close Ticket (2/2)").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(ID.TICKET_CLOSE_CANCEL).setLabel("No, Go Back").setStyle(ButtonStyle.Secondary)
  );

  return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

async function onTicketCloseCancel(interaction) {
  return interaction.update({
    embeds: [new EmbedBuilder().setColor(COLOR.warn).setTitle("Cancelled").setDescription("The ticket was not closed.")],
    components: [],
  });
}

async function onTicketCloseC2(interaction) {
  const meta = decodeTicketTopic(interaction.channel?.topic);
  if (!meta) return interaction.update({ embeds: [ticketNotFoundEmbed()], components: [] });
  if (!isTicketParticipant(interaction.member, meta)) {
    return interaction.update({ embeds: [ticketNotAllowedEmbed()], components: [] });
  }

  await interaction.update({
    embeds: [
      new EmbedBuilder().setColor(COLOR.ok).setTitle("Closing Ticket").setDescription("Saving the transcript and closing this ticket..."),
    ],
    components: [],
  });

  await finalizeTicketClosure(interaction.channel, meta, interaction.user, {});
}

// ---- Staff Application: Accept (2-step confirmation) ----
async function onTicketAcceptC1(interaction) {
  const meta = decodeTicketTopic(interaction.channel?.topic);
  if (!meta || meta.type !== "apply_staff") return interaction.reply({ embeds: [ticketNotFoundEmbed()], flags: MessageFlags.Ephemeral });
  if (!isTicketDecisionMaker(interaction.member, meta)) {
    return interaction.reply({ embeds: [ticketNotAllowedEmbed()], flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR.ok)
    .setTitle("Confirmation 1 of 2 — Accept Application")
    .setDescription(`Are you sure you want to accept <@${meta.openerId}>'s staff application? This will grant them the Jr. Staff role.`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID.TICKET_ACCEPT_C2).setLabel("Yes, Accept (2/2)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ID.TICKET_ACCEPT_CANCEL).setLabel("No, Go Back").setStyle(ButtonStyle.Secondary)
  );

  return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

async function onTicketAcceptCancel(interaction) {
  return interaction.update({
    embeds: [new EmbedBuilder().setColor(COLOR.warn).setTitle("Cancelled").setDescription("No decision was made on this application.")],
    components: [],
  });
}

async function onTicketAcceptC2(interaction) {
  const meta = decodeTicketTopic(interaction.channel?.topic);
  if (!meta || meta.type !== "apply_staff") return interaction.update({ embeds: [ticketNotFoundEmbed()], components: [] });
  if (!isTicketDecisionMaker(interaction.member, meta)) {
    return interaction.update({ embeds: [ticketNotAllowedEmbed()], components: [] });
  }

  await interaction.update({
    embeds: [
      new EmbedBuilder().setColor(COLOR.ok).setTitle("Accepting Application").setDescription("Granting the Jr. Staff role and closing this ticket..."),
    ],
    components: [],
  });

  let roleGranted = true;
  try {
    const member = await interaction.guild.members.fetch(meta.openerId);
    await member.roles.add(JR_STAFF_ROLE_ID, `Staff application accepted by ${interaction.user.tag}`);
  } catch (err) {
    roleGranted = false;
    console.warn(`[Tickets] Could not grant Jr. Staff role to ${meta.openerId}:`, err.message);
    await interaction.channel
      .send({ content: "I couldn't automatically grant the Jr. Staff role (they may have left the server). Please add it manually." })
      .catch(() => {});
  }

  await finalizeTicketClosure(interaction.channel, meta, interaction.user, {
    decision: roleGranted ? "Accepted — Jr. Staff role granted" : "Accepted — role grant failed, add manually",
  });
}

// ---- Staff Application: Deny (2-step confirmation + reason modal) ----
async function onTicketDenyC1(interaction) {
  const meta = decodeTicketTopic(interaction.channel?.topic);
  if (!meta || meta.type !== "apply_staff") return interaction.reply({ embeds: [ticketNotFoundEmbed()], flags: MessageFlags.Ephemeral });
  if (!isTicketDecisionMaker(interaction.member, meta)) {
    return interaction.reply({ embeds: [ticketNotAllowedEmbed()], flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR.bad)
    .setTitle("Confirmation 1 of 2 — Deny Application")
    .setDescription(`Are you sure you want to deny <@${meta.openerId}>'s staff application?`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID.TICKET_DENY_C2).setLabel("Yes, Deny (2/2)").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(ID.TICKET_DENY_CANCEL).setLabel("No, Go Back").setStyle(ButtonStyle.Secondary)
  );

  return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

async function onTicketDenyCancel(interaction) {
  return interaction.update({
    embeds: [new EmbedBuilder().setColor(COLOR.warn).setTitle("Cancelled").setDescription("No decision was made on this application.")],
    components: [],
  });
}

async function onTicketDenyC2(interaction) {
  const meta = decodeTicketTopic(interaction.channel?.topic);
  if (!meta || meta.type !== "apply_staff") return interaction.update({ embeds: [ticketNotFoundEmbed()], components: [] });
  if (!isTicketDecisionMaker(interaction.member, meta)) {
    return interaction.update({ embeds: [ticketNotAllowedEmbed()], components: [] });
  }

  // The final confirmation opens a modal asking for the denial reason — a
  // modal must be the direct response to this click, so the ephemeral
  // confirmation message itself is simply left as-is behind it.
  const modal = new ModalBuilder().setCustomId(ID.TICKET_DENY_MODAL).setTitle("Denial Reason");
  const input = new TextInputBuilder()
    .setCustomId(ID.TICKET_DENY_REASON_INPUT)
    .setLabel("Why is this application being denied?")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(1)
    .setMaxLength(1000)
    .setRequired(true)
    .setPlaceholder("This will be included in the DM sent to the applicant.");
  modal.addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function onTicketDenyModalSubmit(interaction) {
  const reason = interaction.fields.getTextInputValue(ID.TICKET_DENY_REASON_INPUT);
  const meta = decodeTicketTopic(interaction.channel?.topic);
  if (!meta || meta.type !== "apply_staff") {
    return interaction.reply({ embeds: [ticketNotFoundEmbed()], flags: MessageFlags.Ephemeral });
  }
  if (!isTicketDecisionMaker(interaction.member, meta)) {
    return interaction.reply({ embeds: [ticketNotAllowedEmbed()], flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder().setColor(COLOR.bad).setTitle("Denying Application").setDescription("Recording the denial reason and closing this ticket..."),
    ],
    flags: MessageFlags.Ephemeral,
  });

  await interaction.channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.bad)
          .setTitle("Application Denied")
          .setDescription(`<@${meta.openerId}>'s staff application was denied by <@${interaction.user.id}>.`)
          .addFields({ name: "Reason", value: reason.slice(0, 1024) }),
      ],
    })
    .catch(() => {});

  await finalizeTicketClosure(interaction.channel, meta, interaction.user, { decision: "Denied", reason });
}

// ================= OSRS VOICE HUB (JOIN-TO-CREATE) =================
const tempVoiceDeleteTimers = new Map(); // channelId -> Timeout

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isManagedTempVoiceChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  if (channel.parentId !== OSRS_VOICE_CATEGORY_ID) return false;
  const pattern = new RegExp(`^${escapeRegex(OSRS_VOICE_PREFIX)} \\d+$`, "i");
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

  const timeoutMs = customTimeoutMs ?? (config.osrsVoiceEmptyTimeoutMs ?? OSRS_VOICE_EMPTY_TIMEOUT_MS);
  const timer = setTimeout(async () => {
    tempVoiceDeleteTimers.delete(channel.id);
    try {
      const fresh =
        (await channel.guild?.channels?.fetch?.(channel.id).catch(() => null)) ||
        (await client.channels.fetch(channel.id).catch(() => null));
      if (!fresh || !isManagedTempVoiceChannel(fresh)) return;
      if (getNonBotVoiceMemberCount(fresh) === 0) {
        await fresh.delete("Temporary OSRS voice channel empty timeout reached");
        console.log(`[OsrsVoice] Deleted empty temporary voice channel ${fresh.name} (${fresh.id}).`);
      }
    } catch (err) {
      console.warn(`[OsrsVoice] Could not auto-delete voice channel ${channel.id}:`, err.message);
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

async function getNextOsrsVoiceChannelNumber(guild) {
  const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
  const usedNumbers = new Set();
  const pattern = new RegExp(`^${escapeRegex(OSRS_VOICE_PREFIX)} (\\d+)$`, "i");

  for (const ch of channels.values()) {
    if (!ch || ch.type !== ChannelType.GuildVoice) continue;
    if (ch.parentId !== OSRS_VOICE_CATEGORY_ID) continue;
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

async function createOsrsVoiceChannel(guild, creatorUser) {
  const nextNum = await getNextOsrsVoiceChannelNumber(guild);
  const channelName = `${OSRS_VOICE_PREFIX} ${nextNum}`;

  const created = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: OSRS_VOICE_CATEGORY_ID,
    reason: `Temporary OSRS voice channel created for ${creatorUser?.tag || creatorUser?.id || "member"}`,
  });

  // Explicitly sync permissions with the parent category
  if (typeof created.lockPermissions === "function") {
    await created.lockPermissions().catch((e) => {
      console.warn(`[OsrsVoice] Could not lockPermissions on ${created.id}:`, e.message);
    });
  }

  // Safety net: delete it if the member never actually ends up joining
  const initialTimeoutMs = config.osrsVoiceInitialEmptyTimeoutMs ?? OSRS_VOICE_INITIAL_EMPTY_TIMEOUT_MS;
  scheduleTempVoiceDeletion(created, initialTimeoutMs);
  console.log(`[OsrsVoice] Created ${channelName} (${created.id}).`);
  return created;
}

async function handleVoiceStateUpdate(oldState, newState) {
  const joinedChannel = newState?.channel;
  const leftChannel = oldState?.channel;

  // Joining the OSRS Voice hub instantly creates a brand-new temporary
  // "OSRS Voice N" channel and moves the member straight into it — they
  // never actually end up sitting in the hub channel itself.
  if (joinedChannel && joinedChannel.id === OSRS_VOICE_HUB_CHANNEL_ID) {
    try {
      const created = await createOsrsVoiceChannel(joinedChannel.guild, newState.member?.user);
      await newState.setChannel(created, "Redirected from the OSRS Voice hub into a new temporary channel");
    } catch (err) {
      console.error(`[OsrsVoice] Could not redirect ${newState.member?.id} out of the OSRS Voice hub:`, err.message);
    }
    return;
  }

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

// Recruitment Drive Event window — Nov 10, 2026 12:00 PM Central through
// Jan 10, 2027 12:00 PM Central.
const RECRUITMENT_DRIVE_START_MS = centralTimeToUtcMs(2026, 11, 10, 12, 0, 0);
const RECRUITMENT_DRIVE_END_MS   = centralTimeToUtcMs(2027, 1, 10, 12, 0, 0);

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

// ================= WEEKLY HISCORES SNAPSHOT & RECAP =================
// Every Sunday at 5:00 PM Central, Heimdall snapshots every active member's OSRS
// hiscores (skills + bosses/raids/minigames) plus their current Rank XP, diffs
// that snapshot against the one taken the previous Sunday, and posts a recap
// embed summarizing the week's top performers to WEEKLY_RECAP_CHANNEL_ID.

function getRecapWindowByIndex(weekIndex) {
  const endCal = addCalendarDays(
    WEEKLY_RECAP_ANCHOR_DATE.year,
    WEEKLY_RECAP_ANCHOR_DATE.month,
    WEEKLY_RECAP_ANCHOR_DATE.day,
    weekIndex * 7
  );
  const startCal = addCalendarDays(
    WEEKLY_RECAP_ANCHOR_DATE.year,
    WEEKLY_RECAP_ANCHOR_DATE.month,
    WEEKLY_RECAP_ANCHOR_DATE.day,
    weekIndex * 7 - 7
  );

  const startsAtMs = centralTimeToUtcMs(startCal.year, startCal.month, startCal.day, WEEKLY_RECAP_HOUR, 0, 0);
  const endsAtMs = centralTimeToUtcMs(endCal.year, endCal.month, endCal.day, WEEKLY_RECAP_HOUR, 0, 0);

  return {
    weekIndex,
    weekKey: endCal.isoDate, // the Sunday this recap covers, e.g. "2026-11-01"
    startsAtMs,
    endsAtMs,
    startsAtIso: new Date(startsAtMs).toISOString(),
    endsAtIso: new Date(endsAtMs).toISOString(),
  };
}

// Finds the most recently completed recap window (the latest Sunday 5pm Central
// boundary that has already passed, relative to `asOfDate`), or null if the very
// first recap window hasn't happened yet.
function findMostRecentCompletedRecapWindow(asOfDate = new Date()) {
  const nowMs = (asOfDate instanceof Date ? asOfDate : new Date(asOfDate)).getTime();
  const week0 = getRecapWindowByIndex(0);
  if (nowMs < week0.endsAtMs) return null;

  const approxWeekMs = 7 * 24 * 60 * 60 * 1000;
  let idx = Math.max(0, Math.floor((nowMs - week0.endsAtMs) / approxWeekMs));
  while (getRecapWindowByIndex(idx + 1).endsAtMs <= nowMs) idx++;
  while (idx > 0 && getRecapWindowByIndex(idx).endsAtMs > nowMs) idx--;
  return getRecapWindowByIndex(idx);
}

function extractMemberHiscoreSnapshot(hiscoreData) {
  const skills = {};
  const activities = {};
  if (hiscoreData && typeof hiscoreData === "object") {
    for (const s of Array.isArray(hiscoreData.skills) ? hiscoreData.skills : []) {
      if (!s || !s.name) continue;
      const xp = Number(s.xp);
      skills[s.name] = Number.isFinite(xp) && xp > 0 ? xp : 0;
    }
    for (const a of Array.isArray(hiscoreData.activities) ? hiscoreData.activities : []) {
      if (!a || !a.name) continue;
      const score = Number(a.score);
      activities[a.name] = Number.isFinite(score) && score > 0 ? score : 0;
    }
  }
  return { skills, activities };
}

function sumSkillGain(prevSkills, currSkills, skillName) {
  const prevXp = Number(prevSkills?.[skillName]) || 0;
  const currXp = Number(currSkills?.[skillName]) || 0;
  return Math.max(0, currXp - prevXp);
}

// Sums the gain across every raw hiscores entry that matches `hiscoreNames`
// (handles grouped bosses like "Dagannoth Kings" that span multiple hiscores rows).
function sumActivityGain(prevActivities, currActivities, hiscoreNames) {
  const matchNames = new Set((hiscoreNames || []).map(normalizeHiscoreName));
  const rawNames = new Set([
    ...Object.keys(prevActivities || {}),
    ...Object.keys(currActivities || {}),
  ]);
  let gained = 0;
  for (const rawName of rawNames) {
    if (!matchNames.has(normalizeHiscoreName(rawName))) continue;
    const prevVal = Number(prevActivities?.[rawName]) || 0;
    const currVal = Number(currActivities?.[rawName]) || 0;
    gained += Math.max(0, currVal - prevVal);
  }
  return gained;
}

function topN(entries, n = 5) {
  return entries
    .filter((e) => e.amount > 0)
    .sort((a, b) => (b.amount !== a.amount ? b.amount - a.amount : a.name.localeCompare(b.name)))
    .slice(0, n);
}

function formatLeaderboardLines(entries, unitLabel) {
  if (!entries || entries.length === 0) {
    return `*No clan members gained ${unitLabel} this week.*`;
  }
  const medals = ["🥇", "🥈", "🥉"];
  return entries
    .map((e, idx) => {
      const prefix = idx < 3 ? `${medals[idx]} ` : `\`#${idx + 1}\` `;
      return `${prefix}**${e.name}** — **+${e.amount.toLocaleString()} ${unitLabel}**`;
    })
    .join("\n");
}

async function loadPreviousRecapSnapshots(supabase, beforeWeekKey) {
  const byRsn = new Map();
  if (!supabase) return byRsn;
  try {
    const { data, error } = await supabase
      .from("weekly_recap_snapshots")
      .select("*")
      .lt("week_key", beforeWeekKey)
      .order("week_key", { ascending: false })
      .limit(2000);
    if (error || !data || data.length === 0) return byRsn;

    const latestWeekKey = data[0].week_key;
    for (const row of data) {
      if (row.week_key !== latestWeekKey) continue;
      byRsn.set(String(row.rsn).trim().toLowerCase(), row);
    }
  } catch (e) {
    console.error("[WeeklyRecap] Could not load previous snapshots:", e.message);
  }
  return byRsn;
}

async function saveRecapSnapshots(supabase, rows) {
  if (!supabase || !rows || rows.length === 0) return;
  try {
    await supabase.from("weekly_recap_snapshots").upsert(rows, { onConflict: "week_key,rsn" });
  } catch (e) {
    console.error("[WeeklyRecap] Could not save snapshots:", e.message);
  }
}

// Top 5 Honour Marks earned this week, read straight from the Honour Marks
// ledger (`hm_transactions`) and resolved to a display name via `hm_members`.
async function computeHonourMarksLeaderboard(supabase, window) {
  if (!supabase) return [];
  try {
    const { data: txRows, error: txErr } = await supabase
      .from("hm_transactions")
      .select("user_id, delta")
      .gte("created_at", window.startsAtIso)
      .lt("created_at", window.endsAtIso)
      .gt("delta", 0);
    if (txErr || !txRows || txRows.length === 0) return [];

    const totals = new Map();
    for (const row of txRows) {
      const uid = String(row.user_id);
      totals.set(uid, (totals.get(uid) || 0) + (Number(row.delta) || 0));
    }

    const userIds = [...totals.keys()];
    const { data: memberRows } = await supabase
      .from("hm_members")
      .select("user_id, rsn, display_name")
      .in("user_id", userIds);
    const nameByUserId = new Map((memberRows || []).map((m) => [String(m.user_id), m]));

    const entries = userIds.map((uid) => {
      const m = nameByUserId.get(uid);
      const name = (m && (m.display_name || m.rsn)) || `User ${uid}`;
      return { name, amount: totals.get(uid) };
    });

    return topN(entries, 5);
  } catch (e) {
    console.error("[WeeklyRecap] Could not compute Honour Marks leaderboard:", e.message);
    return [];
  }
}

function buildWeeklyRecapEmbed(window, data) {
  const dateLabel = window.weekKey;
  const embed = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle("📊 Weekly Clan Recap")
    .setDescription(`Highlights from the week ending **${dateLabel}** (Sunday 5:00 PM Central).`)
    .addFields(
      { name: "🏆 Top 5 XP Gainers", value: formatLeaderboardLines(data.xpGainers, "XP"), inline: false },
      { name: "⚔️ Top 5 PvMers", value: formatLeaderboardLines(data.pvmers, "Kills"), inline: false },
      { name: "🛡️ Top 5 Raiders", value: formatLeaderboardLines(data.raiders, "Completions"), inline: false },
      { name: "📈 Top 5 Rank XP Earners", value: formatLeaderboardLines(data.rankXpEarners, "Rank XP"), inline: false },
      { name: "🪙 Top 5 Honour Marks Earners", value: formatLeaderboardLines(data.hmEarners, "Honour Marks"), inline: false },
      {
        name: "💪 Most Trained Skill",
        value: data.mostTrainedSkill
          ? `**${data.mostTrainedSkill.name}** — +${data.mostTrainedSkill.amount.toLocaleString()} XP clan-wide`
          : "*No skill XP was gained this week.*",
        inline: true,
      },
      {
        name: "💀 Most Killed Boss",
        value: data.mostKilledBoss
          ? `**${data.mostKilledBoss.name}** — +${data.mostKilledBoss.amount.toLocaleString()} KC clan-wide`
          : "*No boss kills were recorded this week.*",
        inline: true,
      },
      {
        name: "🗿 Most Popular Raid",
        value: data.mostPopularRaid
          ? `**${data.mostPopularRaid.name}** — +${data.mostPopularRaid.amount.toLocaleString()} completions clan-wide`
          : "*No raids were completed this week.*",
        inline: true,
      },
      {
        name: "🎮 Most Popular Minigame",
        value: data.mostPopularMinigame
          ? `**${data.mostPopularMinigame.name}** — +${data.mostPopularMinigame.amount.toLocaleString()} completions clan-wide`
          : "*No minigames were completed this week.*",
        inline: true,
      }
    )
    .setFooter({ text: "Odinheim Heimdall — Weekly Recap" })
    .setTimestamp(new Date());

  return { embeds: [embed] };
}

async function runWeeklyRecap(window, now = new Date()) {
  const supabase = getSupabase();
  if (!supabase) return null;

  // Idempotency guard: if this week's snapshot already exists, it was already
  // processed (e.g. the bot restarted right after posting). Don't post twice.
  try {
    const { data: already } = await supabase
      .from("weekly_recap_snapshots")
      .select("rsn")
      .eq("week_key", window.weekKey)
      .limit(1);
    if (already && already.length > 0) return null;
  } catch (e) {
    console.error("[WeeklyRecap] Idempotency check failed:", e.message);
  }

  const { data: memberRows, error } = await supabase
    .from("clan_members")
    .select("*")
    .eq("active", true);
  if (error) {
    console.error("[WeeklyRecap] Could not read clan_members:", error.message);
    return null;
  }
  const members = (memberRows || []).filter((m) => m && String(m.rsn || "").trim());
  if (members.length === 0) return null;

  const prevByRsn = await loadPreviousRecapSnapshots(supabase, window.weekKey);
  const isFirstRun = prevByRsn.size === 0;

  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const snapshotRows = [];

  const xpGainers = [];
  const pvmers = [];
  const raiders = [];
  const rankXpEarners = [];
  const skillTotals = new Map(OSRS_SKILLS.map((s) => [s.name, 0]));
  const bossTotals = new Map(PVM_BOSS_ENTRIES.map((b) => [b.name, 0]));
  const raidTotals = new Map(RAID_BOSS_ENTRIES.map((b) => [b.name, 0]));
  const minigameTotals = new Map(OSRS_MINIGAMES.map((m) => [m.name, 0]));

  for (const member of members) {
    const rsn = String(member.rsn).trim();
    const key = rsn.toLowerCase();
    const hiscoreData = await fetchPlayerHiscores(rsn);
    const snapshot = extractMemberHiscoreSnapshot(hiscoreData);

    snapshotRows.push({
      week_key: window.weekKey,
      rsn,
      skills: snapshot.skills,
      activities: snapshot.activities,
      rank_xp: Number(member.xp) || 0,
      captured_at: nowIso,
    });

    const prev = prevByRsn.get(key);
    if (!prev) continue; // no baseline yet for this member; it'll start counting next week

    const prevSkills = prev.skills || {};
    const prevActivities = prev.activities || {};

    let memberXpGained = 0;
    for (const s of OSRS_SKILLS) {
      const gained = sumSkillGain(prevSkills, snapshot.skills, s.name);
      memberXpGained += gained;
      if (gained > 0) skillTotals.set(s.name, (skillTotals.get(s.name) || 0) + gained);
    }
    if (memberXpGained > 0) xpGainers.push({ name: rsn, amount: memberXpGained });

    let memberPvmGained = 0;
    for (const b of PVM_BOSS_ENTRIES) {
      const gained = sumActivityGain(prevActivities, snapshot.activities, b.hiscoreNames);
      memberPvmGained += gained;
      if (gained > 0) bossTotals.set(b.name, (bossTotals.get(b.name) || 0) + gained);
    }
    if (memberPvmGained > 0) pvmers.push({ name: rsn, amount: memberPvmGained });

    let memberRaidGained = 0;
    for (const r of RAID_BOSS_ENTRIES) {
      const gained = sumActivityGain(prevActivities, snapshot.activities, r.hiscoreNames);
      memberRaidGained += gained;
      if (gained > 0) raidTotals.set(r.name, (raidTotals.get(r.name) || 0) + gained);
    }
    if (memberRaidGained > 0) raiders.push({ name: rsn, amount: memberRaidGained });

    for (const mg of OSRS_MINIGAMES) {
      const gained = sumActivityGain(prevActivities, snapshot.activities, mg.hiscoreNames);
      if (gained > 0) minigameTotals.set(mg.name, (minigameTotals.get(mg.name) || 0) + gained);
    }

    const prevRankXp = Number(prev.rank_xp) || 0;
    const currRankXp = Number(member.xp) || 0;
    const rankXpGained = Math.max(0, currRankXp - prevRankXp);
    if (rankXpGained > 0) rankXpEarners.push({ name: rsn, amount: rankXpGained });
  }

  await saveRecapSnapshots(supabase, snapshotRows);

  if (isFirstRun) {
    console.log(`[WeeklyRecap] Baseline captured for week ${window.weekKey}; first full recap will post next week.`);
    return null;
  }

  const hmEarners = await computeHonourMarksLeaderboard(supabase, window);

  const toEntryList = (map) => [...map.entries()].map(([name, amount]) => ({ name, amount }));
  const pickTop1 = (map) => topN(toEntryList(map), 1)[0] || null;

  const data = {
    xpGainers: topN(xpGainers, 5),
    pvmers: topN(pvmers, 5),
    raiders: topN(raiders, 5),
    rankXpEarners: topN(rankXpEarners, 5),
    hmEarners,
    mostTrainedSkill: pickTop1(skillTotals),
    mostKilledBoss: pickTop1(bossTotals),
    mostPopularRaid: pickTop1(raidTotals),
    mostPopularMinigame: pickTop1(minigameTotals),
  };

  const payload = buildWeeklyRecapEmbed(window, data);
  const channel = await getWeeklyRecapChannel();
  if (channel) {
    await channel.send(payload).catch((e) => console.error("[WeeklyRecap] Failed to post recap:", e.message));
  }

  return { window, data };
}

let weeklyRecapTimer = null;
let lastFiredRecapWeekKey = null;

function startWeeklyRecapLoop() {
  if (weeklyRecapTimer) clearInterval(weeklyRecapTimer);

  // Check every 60 seconds for whether the most recently completed Sunday
  // 5:00 PM Central recap window has changed since the last time we posted.
  weeklyRecapTimer = setInterval(async () => {
    try {
      const now = new Date();
      const window = findMostRecentCompletedRecapWindow(now);
      if (!window || window.weekKey === lastFiredRecapWeekKey) return;
      lastFiredRecapWeekKey = window.weekKey;
      await runWeeklyRecap(window, now);
    } catch (err) {
      console.error("[WeeklyRecap] Loop error:", err.message);
    }
  }, 60 * 1000);

  if (typeof weeklyRecapTimer.unref === "function") weeklyRecapTimer.unref();
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
const RANK_SYNC_HEARTBEAT_MS = 60 * 1000; // how often we check whether a sync is due

/**
 * Pure/testable "is it time to run another tenure sync" check. Tenure XP
 * (time in the clan) is recomputed as a full replay from each member's
 * joined_date every time syncClanRanks() runs — it is NOT something that
 * only advances when a roster CSV is re-uploaded. The only thing that was
 * ever supposed to gate it is: don't overlap a sync already in flight, and
 * don't run more often than config.rankSyncIntervalMs.
 *
 * Pulled out of the old single setInterval(…, 30 minutes) into a 60-second
 * heartbeat check (same pattern as the Weekly Recap / Weekly Events /
 * Recruitment Drive loops elsewhere in this file) so a sync is guaranteed to
 * fire within a minute of becoming due, rather than depending on one
 * long-lived timer surviving uninterrupted for the full 30 minutes.
 */
// `lastSyncAt`/`inFlight` default to the live module state so the heartbeat
// loop below can call isRankSyncDue() with no arguments, but both are
// accepted as explicit params too so this decision logic is unit-testable
// without needing a real Supabase connection or an actual sync to happen.
function isRankSyncDue(now = Date.now(), lastSyncAt = lastRankSyncFinishedAt, inFlight = rankSyncInFlight) {
  if (inFlight) return false;
  if (!lastSyncAt) return true; // never synced yet this process — do it now
  return now - lastSyncAt >= config.rankSyncIntervalMs;
}

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
      .subscribe((status, err) => {
        // Realtime failing to (re)connect is silent otherwise — if this never
        // logs SUBSCRIBED, tenure/XP updates are relying on the heartbeat
        // loop below alone, which is still fine, but worth knowing about.
        if (status === "SUBSCRIBED") {
          console.log("[RankSync] Realtime subscription active (clan_members / roster_upload / pending_rank_xp).");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          console.warn(`[RankSync] Realtime subscription status: ${status}${err ? ` (${err.message})` : ""}. Falling back to the ${config.rankSyncIntervalMs / 60000}-minute heartbeat sync.`);
        }
      });
  } catch (err) {
    console.warn("[RankSync] Realtime subscription warning:", err.message);
  }

  if (syncTimer) clearInterval(syncTimer);
  if (config.rankSyncIntervalMs > 0) {
    console.log(`[RankSync] Heartbeat sync loop started — tenure XP and ranks recompute automatically at least every ${config.rankSyncIntervalMs / 60000} minutes.`);
    syncTimer = setInterval(() => {
      if (!isRankSyncDue()) return;
      syncClanRanks().catch((e) => console.error("[RankSync] Scheduled sync error:", e.message));
    }, RANK_SYNC_HEARTBEAT_MS);
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

// ---- Channel/category access rules ----
//
// The goal: new members only ever see the Welcome category until they're a
// nickname-verified Clan Member, and the rest of the server's access tiers
// (Clan Chat, Staff Area, Social Hub, Server Logs) are each locked to the
// right roles. Honour Marks' own category is intentionally NOT managed here —
// that bot already runs its own /setup system for hm-role / hm-guide /
// hm-quests / hm-shop / hm-database / hm-staff / hm-log.
//
// Why this can't be plain role-based overwrites alone: Discord's permission
// engine lets an explicit ALLOW from one of a member's roles beat an explicit
// DENY from another of their roles. A member who just picked "Clan Member" in
// Discord's own onboarding flow has BOTH the Clan Member role AND the
// Unverified role at the same time until they set their nickname with the
// bot — so "Clan Member can view Clan Chat" would already let them in
// immediately, before they've done anything. Same shape for the Leader/Staff
// orientation channel: accepting orientation only ever ADDS the Verified
// role, it never removes the base Staff/Jr. Staff/Leader role (see the
// comment above ORIENTATION_BUTTONS), so "visible until verified" needs the
// same trick. The fix is a per-member permission override the bot adds and
// removes itself as a member's relevant roles change — those overrides win
// over any role-based result, in either direction.
//
// Static, role-based rules below are reconciled on a heartbeat (self-healing
// — corrects anything changed by hand, and automatically locks down any new
// channel someone adds to a managed category). Per-member overrides are
// applied instantly at the moment a relevant role changes, with that same
// heartbeat as a safety net in case an event is ever missed.

const EVERYONE_OPEN = "open"; // @everyone can view this channel
const EVERYONE_DENY = "deny"; // @everyone cannot view; only the listed roles/users can

const CLAN_MEMBER_AND_ABOVE_ROLE_IDS = [
  CLAN_MEMBER_ROLE_ID,
  JR_STAFF_ROLE_ID,
  STAFF_ROLE_ID,
  LEADER_ROLE_ID,
  VERIFIED_STAFF_ROLE_ID,
  VERIFIED_LEADER_ROLE_ID,
  CO_OWNER_ROLE_ID,
  OWNER_ROLE_ID,
];
const VERIFIED_STAFF_AND_ABOVE_ROLE_IDS = [VERIFIED_STAFF_ROLE_ID, VERIFIED_LEADER_ROLE_ID, CO_OWNER_ROLE_ID, OWNER_ROLE_ID];
const VERIFIED_LEADER_AND_ABOVE_ROLE_IDS = [VERIFIED_LEADER_ROLE_ID, CO_OWNER_ROLE_ID, OWNER_ROLE_ID];
const OWNER_AND_CO_OWNER_ROLE_IDS = [CO_OWNER_ROLE_ID, OWNER_ROLE_ID];

/**
 * One entry per category this bot manages. `default` applies to every channel
 * Discord currently lists under that category — fetched live, so a brand new
 * channel dragged into it is automatically covered without a code change.
 * `channels` overrides specific channel IDs with their own rule.
 * `dynamicUnverifiedGate` / `dynamicOrientationGate` mark the spots that
 * additionally get the per-member logic described above layered on top.
 */
const SERVER_PRIVACY_CATEGORIES = {
  [WELCOME_CATEGORY_ID]: {
    label: "Welcome",
    default: { everyone: EVERYONE_OPEN, allowRoleIds: [] },
    channels: {
      // Only Clan Member — Clan Friends and anyone who hasn't picked a role
      // yet never see the nickname-setup channel.
      [ONBOARDING_CHANNEL_ID]: { everyone: EVERYONE_DENY, allowRoleIds: [CLAN_MEMBER_ROLE_ID] },
    },
  },
  [OSRS_VOICE_CATEGORY_ID]: {
    label: "Clan Chat",
    // The OSRS role is what gives Clan Friends (and anyone else who isn't
    // yet a full Clan Member) visibility into the general OSRS category —
    // but ONLY the general category default. Clan Chat itself, the
    // Recruitment Drive, and the Rank List are each listed explicitly below
    // WITHOUT the OSRS role, specifically so holding the OSRS role never
    // unlocks those three — they stay Clan-Member-and-above only.
    default: { everyone: EVERYONE_DENY, allowRoleIds: [...CLAN_MEMBER_AND_ABOVE_ROLE_IDS, OSRS_ROLE_ID], dynamicUnverifiedGate: true },
    channels: {
      // Named explicitly (rather than relying solely on category-child
      // discovery) because these three live outside what the bot can assume
      // is this category's live child list in every server configuration —
      // see the comment on applyServerPrivacyCategory for why that matters.
      [CLAN_CHAT_CHANNEL_ID]: { everyone: EVERYONE_DENY, allowRoleIds: CLAN_MEMBER_AND_ABOVE_ROLE_IDS, dynamicUnverifiedGate: true },
      [RECRUITMENT_DRIVE_CHANNEL_ID]: { everyone: EVERYONE_DENY, allowRoleIds: CLAN_MEMBER_AND_ABOVE_ROLE_IDS, dynamicUnverifiedGate: true },
      [RANK_LIST_CHANNEL_ID]: { everyone: EVERYONE_DENY, allowRoleIds: CLAN_MEMBER_AND_ABOVE_ROLE_IDS, dynamicUnverifiedGate: true },
    },
  },
  [STAFF_AREA_CATEGORY_ID]: {
    label: "Staff Area",
    default: { everyone: EVERYONE_DENY, allowRoleIds: VERIFIED_STAFF_AND_ABOVE_ROLE_IDS },
    channels: {
      [ORIENTATION_CHANNEL_ID]: { everyone: EVERYONE_DENY, allowRoleIds: OWNER_AND_CO_OWNER_ROLE_IDS, dynamicOrientationGate: true },
      [STAFF_CHAT_CHANNEL_ID]: { everyone: EVERYONE_DENY, allowRoleIds: VERIFIED_STAFF_AND_ABOVE_ROLE_IDS },
      [STAFF_ALERT_CHANNEL_ID]: { everyone: EVERYONE_DENY, allowRoleIds: VERIFIED_STAFF_AND_ABOVE_ROLE_IDS },
      [LEADER_CHANNEL_ID]: { everyone: EVERYONE_DENY, allowRoleIds: VERIFIED_LEADER_AND_ABOVE_ROLE_IDS },
      [OWNER_CHAT_CHANNEL_ID]: { everyone: EVERYONE_DENY, allowRoleIds: OWNER_AND_CO_OWNER_ROLE_IDS },
    },
  },
  [SOCIAL_HUB_CATEGORY_ID]: {
    label: "Social Hub",
    default: { everyone: EVERYONE_DENY, allowRoleIds: [SOCIAL_CHATTER_ROLE_ID] },
    channels: {},
  },
  [SERVER_LOGS_CATEGORY_ID]: {
    label: "Server Logs",
    default: { everyone: EVERYONE_DENY, allowRoleIds: [], allowUserIds: [SERVER_LOGS_OWNER_USER_ID] },
    channels: {},
  },
};

/** Builds the role/user overwrite rows for one static rule. */
function buildStaticOverwriteRows(guild, rule) {
  const rows = [];
  const everyoneId = guild.roles.everyone.id;
  const botId = guild.members.me?.id || client.user?.id;

  rows.push({
    id: everyoneId,
    type: OverwriteType.Role,
    ...(rule.everyone === EVERYONE_OPEN
      ? { allow: [PermissionFlagsBits.ViewChannel] }
      : { deny: [PermissionFlagsBits.ViewChannel] }),
  });

  if (botId) rows.push({ id: botId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel] });

  for (const roleId of rule.allowRoleIds || []) {
    if (roleId) rows.push({ id: roleId, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] });
  }
  for (const userId of rule.allowUserIds || []) {
    if (userId) rows.push({ id: userId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel] });
  }
  return rows;
}

/**
 * Applies a static rule to one channel, replacing its role/bot overwrites
 * wholesale (so drift always gets corrected) while leaving any OTHER
 * per-member overwrite already on the channel untouched — those belong to the
 * dynamic verification gates managed elsewhere and must survive this reset.
 */
async function applyStaticRuleToChannel(channel, rule) {
  const staticRows = buildStaticOverwriteRows(channel.guild, rule);
  const staticIds = new Set(staticRows.map((r) => r.id));

  const preserved = channel.permissionOverwrites.cache
    .filter((ow) => ow.type === OverwriteType.Member && !staticIds.has(ow.id))
    .map((ow) => ({ id: ow.id, type: OverwriteType.Member, allow: ow.allow.bitfield, deny: ow.deny.bitfield }));

  await channel.permissionOverwrites.set([...staticRows, ...preserved], "Automatic server privacy sync");
}

/**
 * Applies one category's rules. Two passes, deliberately not relying on
 * category-child discovery alone:
 *
 *   1. Every channel explicitly named in `rule.channels` is fetched and
 *      corrected DIRECTLY by its own ID first. A channel can be listed here
 *      without actually turning up in `category.children.cache` — Discord's
 *      own permission-sync state for a channel, or it simply living under a
 *      different parent than assumed, both mean it would otherwise never get
 *      touched and would keep whatever permissions it already had forever.
 *      That silent gap is exactly what let a handful of named channels keep
 *      their old, wrong permissions even after this system went live.
 *   2. The category itself plus any of its current children that AREN'T
 *      already covered by step 1 gets the category's `default` rule — this
 *      is what automatically locks down a brand new channel someone adds.
 */
async function applyServerPrivacyCategory(guild, categoryId, rule) {
  const handled = new Set();

  for (const [channelId, channelRule] of Object.entries(rule.channels)) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn(`[ServerPrivacy] Channel ${channelId} (${rule.label}) not found — skipping.`);
      continue;
    }
    handled.add(channel.id);
    try {
      await applyStaticRuleToChannel(channel, channelRule);
    } catch (err) {
      console.error(`[ServerPrivacy] Could not update #${channel.name || channel.id}: ${err.message}`);
    }
  }

  const category = await guild.channels.fetch(categoryId).catch(() => null);
  if (!category) {
    console.warn(`[ServerPrivacy] Category ${categoryId} (${rule.label}) not found — skipping.`);
    return;
  }
  const children = category.children?.cache ? [...category.children.cache.values()] : [];
  const targets = [category, ...children];
  for (const channel of targets) {
    if (handled.has(channel.id)) continue;
    try {
      await applyStaticRuleToChannel(channel, rule.default);
    } catch (err) {
      console.error(`[ServerPrivacy] Could not update #${channel.name || channel.id}: ${err.message}`);
    }
  }
}

async function applyServerPrivacyConfig(guild) {
  for (const [categoryId, rule] of Object.entries(SERVER_PRIVACY_CATEGORIES)) {
    await applyServerPrivacyCategory(guild, categoryId, rule);
  }
}

// ---- Dynamic per-member overrides ----

function isPendingNicknameVerification(member) {
  return memberHasRole(member, CLAN_MEMBER_ROLE_ID) && memberHasRole(member, UNVERIFIED_ROLE_ID);
}

function isPendingOrientation(member) {
  const pendingLeader = memberHasRole(member, LEADER_ROLE_ID) && !memberHasRole(member, VERIFIED_LEADER_ROLE_ID);
  const pendingStaff =
    (memberHasRole(member, STAFF_ROLE_ID) || memberHasRole(member, JR_STAFF_ROLE_ID)) &&
    !memberHasRole(member, VERIFIED_STAFF_ROLE_ID);
  return pendingLeader || pendingStaff;
}

/**
 * Whether a member should hold the OSRS role — the role that gives
 * visibility into the general OSRS category (NOT Clan Chat/Recruitment
 * Drive/Rank List, which stay Clan-Member-and-above only regardless):
 *   - a Clan Friend, as soon as they are one, or
 *   - a Clan Member who has finished nickname verification (no longer
 *     Unverified) — this mirrors what onConfirm2 already grants directly
 *     at the moment nickname verification completes; this check exists so
 *     the same outcome is also reachable via the role-change listener and
 *     the heartbeat reconciler, for members whose state drifts or who
 *     existed before this rule did.
 */
function isEligibleForOsrsRole(member) {
  if (memberHasRole(member, CLAN_FRIEND_ROLE_ID)) return true;
  if (memberHasRole(member, CLAN_MEMBER_ROLE_ID) && !memberHasRole(member, UNVERIFIED_ROLE_ID)) return true;
  return false;
}

/**
 * Additive only — never removes the OSRS role. The ask is "grant it once
 * eligible", not "revoke it the moment some other role changes", so a Clan
 * Friend who later becomes a (still-eligible) Clan Member, or any other
 * edge case, is never stripped of access it already had.
 */
async function syncOsrsRoleForMember(member) {
  if (!isEligibleForOsrsRole(member)) return;
  if (memberHasRole(member, OSRS_ROLE_ID)) return;
  await member.roles
    .add(OSRS_ROLE_ID, "OSRS role — eligible via Clan Friend or verified Clan Member")
    .catch((e) => console.error(`[ServerPrivacy] Could not grant OSRS role to ${member.id}: ${e.message}`));
}

/**
 * Grants/revokes ONE member's personal View Channel ALLOW override. For
 * gates where the baseline (no override at all) is already hidden, and the
 * override's only job is to temporarily REVEAL the channel — e.g. the
 * orientation channel, which has no static allow for the base Staff/Jr.
 * Staff/Leader roles at all. Skips the API call if it's already correct.
 */
async function setMemberChannelAllow(channel, memberId, allowed, reason) {
  const current = channel.permissionOverwrites.cache.get(memberId);
  if (allowed) {
    if (current && current.allow.has(PermissionFlagsBits.ViewChannel) && !current.deny.has(PermissionFlagsBits.ViewChannel)) return;
    await channel.permissionOverwrites
      .edit(memberId, { ViewChannel: true }, { reason })
      .catch((e) => console.error(`[ServerPrivacy] Could not grant ${memberId} access to #${channel.name || channel.id}: ${e.message}`));
  } else {
    if (!current) return;
    await channel.permissionOverwrites
      .delete(memberId, reason)
      .catch((e) => console.error(`[ServerPrivacy] Could not clear ${memberId}'s override on #${channel.name || channel.id}: ${e.message}`));
  }
}

/**
 * Grants/revokes ONE member's personal View Channel DENY override. For gates
 * where the baseline role-level result would otherwise ALLOW them — e.g.
 * Clan Chat, which statically allows the Clan Member role itself — so the
 * override's job is to explicitly BLOCK this one member despite that
 * role-level allow. This must be an explicit deny, not just the absence of
 * an override: a member with no override at all simply inherits their
 * role's allow, which is exactly the case for someone who just got the
 * Clan Member role but hasn't set their nickname yet. Skips the API call if
 * it's already correct.
 */
async function setMemberChannelBlock(channel, memberId, blocked, reason) {
  const current = channel.permissionOverwrites.cache.get(memberId);
  if (blocked) {
    if (current && current.deny.has(PermissionFlagsBits.ViewChannel) && !current.allow.has(PermissionFlagsBits.ViewChannel)) return;
    await channel.permissionOverwrites
      .edit(memberId, { ViewChannel: false }, { reason })
      .catch((e) => console.error(`[ServerPrivacy] Could not block ${memberId} from #${channel.name || channel.id}: ${e.message}`));
  } else {
    if (!current) return;
    await channel.permissionOverwrites
      .delete(memberId, reason)
      .catch((e) => console.error(`[ServerPrivacy] Could not clear ${memberId}'s override on #${channel.name || channel.id}: ${e.message}`));
  }
}

async function syncClanChatAccessForMember(member) {
  const rule = SERVER_PRIVACY_CATEGORIES[OSRS_VOICE_CATEGORY_ID];
  const shouldBlock = isPendingNicknameVerification(member);
  const reason = "Clan Chat unlocks once the nickname step is complete";
  const seen = new Set();
  const targets = [];

  const category = await member.guild.channels.fetch(OSRS_VOICE_CATEGORY_ID).catch(() => null);
  if (category) {
    targets.push(category);
    seen.add(category.id);
    const children = category.children?.cache ? [...category.children.cache.values()] : [];
    for (const child of children) {
      targets.push(child);
      seen.add(child.id);
    }
  }

  // Same reasoning as applyServerPrivacyCategory: a channel explicitly marked
  // for this gate must get it even if it doesn't actually turn up as a live
  // child of the category.
  for (const [channelId, channelRule] of Object.entries(rule.channels)) {
    if (seen.has(channelId) || !channelRule.dynamicUnverifiedGate) continue;
    const channel = await getAnyChannelById(channelId, "ServerPrivacy");
    if (channel) targets.push(channel);
  }

  for (const channel of targets) {
    await setMemberChannelBlock(channel, member.id, shouldBlock, reason);
  }
}

async function syncOrientationAccessForMember(member) {
  const channel = await getAnyChannelById(ORIENTATION_CHANNEL_ID, "ServerPrivacy");
  if (!channel) return;
  await setMemberChannelAllow(channel, member.id, isPendingOrientation(member), "Orientation channel stays visible until the role is accepted");
}

/** Corrects every current member's dynamic overrides — the drift-safety-net half of the heartbeat sync. */
async function reconcileAllMembersChannelAccess(guild) {
  let members;
  try {
    members = await guild.members.fetch();
  } catch (err) {
    console.error("[ServerPrivacy] Could not fetch guild members for reconciliation:", err.message);
    return;
  }
  for (const member of members.values()) {
    if (member.user?.bot) continue;
    try {
      await syncClanChatAccessForMember(member);
      await syncOrientationAccessForMember(member);
      await syncOsrsRoleForMember(member);
    } catch (err) {
      console.error(`[ServerPrivacy] Could not reconcile ${member.id}: ${err.message}`);
    }
  }
}

const SERVER_PRIVACY_SYNC_HEARTBEAT_MS = 60 * 1000;
let serverPrivacySyncInFlight = false;
let lastServerPrivacySyncFinishedAt = 0;
let serverPrivacySyncTimer = null;

// Same pure/testable "is it time to run another sync" shape as isRankSyncDue.
function isServerPrivacySyncDue(now = Date.now(), lastSyncAt = lastServerPrivacySyncFinishedAt, inFlight = serverPrivacySyncInFlight) {
  if (inFlight) return false;
  if (!lastSyncAt) return true;
  return now - lastSyncAt >= config.serverPrivacySyncIntervalMs;
}

async function runServerPrivacySync() {
  if (serverPrivacySyncInFlight) return;
  serverPrivacySyncInFlight = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      await applyServerPrivacyConfig(guild);
      await reconcileAllMembersChannelAccess(guild);
    }
  } catch (err) {
    console.error("[ServerPrivacy] Sync failed:", err.message);
  } finally {
    lastServerPrivacySyncFinishedAt = Date.now();
    serverPrivacySyncInFlight = false;
  }
}

function startServerPrivacyLoop() {
  if (serverPrivacySyncTimer) clearInterval(serverPrivacySyncTimer);
  if (config.serverPrivacySyncIntervalMs > 0) {
    console.log(
      `[ServerPrivacy] Heartbeat sync loop started — channel permissions recheck automatically at least every ${config.serverPrivacySyncIntervalMs / 60000} minutes.`
    );
    serverPrivacySyncTimer = setInterval(() => {
      if (!isServerPrivacySyncDue()) return;
      runServerPrivacySync().catch((e) => console.error("[ServerPrivacy] Scheduled sync error:", e.message));
    }, SERVER_PRIVACY_SYNC_HEARTBEAT_MS);
    if (typeof serverPrivacySyncTimer.unref === "function") serverPrivacySyncTimer.unref();
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

    // A Clan Friend who just finished onboarding gets the OSRS role right
    // away — that's what unlocks the general OSRS category for them (Clan
    // Chat/Recruitment Drive/Rank List stay off-limits regardless).
    await syncOsrsRoleForMember(member);

    // Lock Clan Chat for a fresh Unverified Clan Member right away rather than
    // waiting for the next heartbeat — they shouldn't see it for even a moment.
    await syncClanChatAccessForMember(member).catch((e) =>
      console.error(`[ServerPrivacy] Could not sync Clan Chat access for ${userId}: ${e.message}`)
    );
  } finally {
    completionInFlight.delete(userId);
  }
}

async function handleMemberUpdate(oldMember, newMember) {
  if (newMember.user?.bot) return;

  if (completedOnboarding(newMember) && newMember.roles.cache.has(UNVERIFIED_ROLE_ID)) {
    await processOnboardingCompletion(newMember.guild, newMember.id);
  }

  // Keep the dynamic per-member channel overrides in sync with any role
  // change — covers a staff member manually editing roles in Discord, not
  // just the bot's own flows above.
  const relevantChanged = (roleIds) => roleIds.some((id) => oldMember.roles.cache.has(id) !== newMember.roles.cache.has(id));
  try {
    if (relevantChanged([CLAN_MEMBER_ROLE_ID, UNVERIFIED_ROLE_ID])) {
      await syncClanChatAccessForMember(newMember);
    }
    if (relevantChanged([STAFF_ROLE_ID, JR_STAFF_ROLE_ID, LEADER_ROLE_ID, VERIFIED_STAFF_ROLE_ID, VERIFIED_LEADER_ROLE_ID])) {
      await syncOrientationAccessForMember(newMember);
    }
    if (relevantChanged([CLAN_FRIEND_ROLE_ID, CLAN_MEMBER_ROLE_ID, UNVERIFIED_ROLE_ID])) {
      await syncOsrsRoleForMember(newMember);
    }
  } catch (err) {
    console.error(`[ServerPrivacy] reconcile on role change failed for ${newMember.id}:`, err.message);
  }
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
    // Unlock Clan Chat immediately — don't make them wait for the next heartbeat.
    await syncClanChatAccessForMember(member).catch((e) =>
      console.error(`[ServerPrivacy] Could not unlock Clan Chat for ${interaction.user.id}: ${e.message}`)
    );
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
    // Hide the orientation channel for them right away — no need to wait for the heartbeat.
    await syncOrientationAccessForMember(member).catch((e) =>
      console.error(`[ServerPrivacy] Could not hide orientation channel for ${interaction.user.id}: ${e.message}`)
    );
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

// ================= RECRUITMENT DRIVE EVENT =================
// One channel (RECRUITMENT_DRIVE_CHANNEL_ID) holds: a permanent announcement
// embed with an "Upload Screenshot" button, an auto-updating leaderboard
// embed beneath it, and a bot-created thread per recruiting member holding
// their numbered screenshot evidence.
//
// Discord buttons cannot open a native file-upload dialog, so the button
// just opens a 10-minute submission window: the member posts their
// screenshot (plus a short note) as a normal message in the channel, and the
// bot grabs it, files it into their thread, deletes the original message,
// and refreshes the leaderboard.
const pendingRecruitmentUploads = new Map(); // userId -> { expiresAt }
// In-memory fallback only used if Supabase isn't configured — nothing here
// survives a restart in that case.
const recruitmentMemoryStore = { threads: new Map(), submissions: [], nextId: 1 };
let recruitmentAnnouncementMessageId = null;
let recruitmentLeaderboardMessageId = null;
let recruitmentDriveTimer = null;
let lastRecruitmentPhase = null;

function getRecruitmentDrivePhase(now = Date.now()) {
  if (now < RECRUITMENT_DRIVE_START_MS) return "scheduled";
  if (now < RECRUITMENT_DRIVE_END_MS) return "active";
  return "ended";
}

function buildRecruitmentDriveEmbed(phase) {
  const startTs = Math.floor(RECRUITMENT_DRIVE_START_MS / 1000);
  const endTs = Math.floor(RECRUITMENT_DRIVE_END_MS / 1000);

  const embed = new EmbedBuilder()
    .setColor(phase === "ended" ? COLOR.bad : phase === "active" ? COLOR.ok : COLOR.main)
    .setTitle("Recruitment Drive Event")
    .setDescription(
      `**Starts:** <t:${startTs}:F> (<t:${startTs}:R>)\n` +
      `**Ends:** <t:${endTs}:F> (<t:${endTs}:R>)\n\n` +
      "Every member of the clan has an equal chance at winning. The point of this event is to find players in OSRS " +
      "who are interested in joining a clan and might want help with the game or learning PvM/Raids — and grow the clan while we do it. " +
      "We're a social/PvM clan, so when you're talking to potential recruits, it always helps to mention our Honour Marks system as a way " +
      "to help them level up their account and unlock more content once they join."
    )
    .addFields(
      {
        name: "Prize",
        value: `${RECRUITMENT_DRIVE_PRIZE_TEXT} go to whoever recruits the most new members to the clan during the event.`,
      },
      {
        name: "How Points Work",
        value:
          "**+1 point** for every person you recruit into the clan. They are not required to stay any length of time for this point to count.\n" +
          "**+1 additional point** if that same recruit also joins our Discord and completes onboarding, including the server nickname update.",
      },
      {
        name: "What You Need To Submit",
        value:
          "A screenshot of the clan chatbox showing you inviting them into the clan **and** them accepting the invite. " +
          "This is required to receive your point.",
      },
      {
        name: "How To Submit A Screenshot",
        value:
          `Press **Upload Screenshot** below, then post your screenshot as a message in <#${RECRUITMENT_DRIVE_CHANNEL_ID}>, ` +
          "including the recruited player's name and whether they've joined our Discord yet (yes/no) in that same message. " +
          "Heimdall will automatically move it into your own thread in this channel and remove your original message.",
      }
    )
    .setFooter({
      text:
        phase === "ended"
          ? "This event has ended."
          : phase === "active"
          ? "Submissions are open."
          : "Submissions open at the start date above.",
    });

  const button = new ButtonBuilder()
    .setCustomId(ID.RECRUITMENT_UPLOAD_BTN)
    .setStyle(phase === "active" ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(phase !== "active")
    .setLabel(phase === "ended" ? "Event Ended" : phase === "scheduled" ? "Not Started Yet" : "Upload Screenshot");

  const row = new ActionRowBuilder().addComponents(button);
  return { embeds: [embed], components: [row] };
}

function buildRecruitmentLeaderboardEmbed(standings, opts = {}) {
  const embed = new EmbedBuilder()
    .setColor(opts.final ? COLOR.gold : COLOR.main)
    .setTitle(opts.final ? "Recruitment Drive — Final Leaderboard" : "Recruitment Drive Leaderboard");

  if (standings.length === 0) {
    embed.setDescription("No recruits logged yet. Be the first!");
  } else {
    const lines = standings.slice(0, 15).map((s, i) => {
      const rank = i + 1;
      const bonusNote = s.bonuses > 0 ? ` (+${s.bonuses} discord bonus${s.bonuses === 1 ? "" : "es"})` : "";
      return `**${rank}.** <@${s.recruiterId}> — **${s.points}** point${s.points === 1 ? "" : "s"} ` +
        `(${s.recruits} recruit${s.recruits === 1 ? "" : "s"}${bonusNote})`;
    });
    embed.setDescription(lines.join("\n"));
  }

  if (opts.final) {
    const topScore = standings[0]?.points ?? 0;
    const winners = standings.filter((s) => s.points === topScore && topScore > 0);
    if (winners.length === 1) {
      embed.addFields({ name: "Winner", value: `<@${winners[0].recruiterId}> takes home ${RECRUITMENT_DRIVE_PRIZE_TEXT}!` });
    } else if (winners.length > 1) {
      embed.addFields({
        name: "Tie For First",
        value: `${winners.map((w) => `<@${w.recruiterId}>`).join(", ")} are tied for first place with **${topScore}** points each.`,
      });
    }
  }

  embed.setFooter({
    text: `Last updated: ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} Central`,
  });
  return { embeds: [embed] };
}

function isRecruitmentAnnouncementMessage(m) {
  return m.author?.id === client.user.id && messageHasButton(m, [ID.RECRUITMENT_UPLOAD_BTN]);
}

function isRecruitmentLeaderboardMessage(m) {
  const title = m.author?.id === client.user.id ? m.embeds?.[0]?.title : null;
  return typeof title === "string" && title.startsWith("Recruitment Drive") && title.includes("Leaderboard");
}

async function getRecruitmentAnnouncementMessage(channel) {
  if (recruitmentAnnouncementMessageId) {
    const m = await channel.messages.fetch(recruitmentAnnouncementMessageId).catch(() => null);
    if (m) return m;
  }
  const recent = await fetchRecentMessages(channel, SCAN_PAGES_PERMANENT);
  const found = recent.find(isRecruitmentAnnouncementMessage) || null;
  if (found) recruitmentAnnouncementMessageId = found.id;
  return found;
}

async function getRecruitmentLeaderboardMessage(channel) {
  if (recruitmentLeaderboardMessageId) {
    const m = await channel.messages.fetch(recruitmentLeaderboardMessageId).catch(() => null);
    if (m) return m;
  }
  const recent = await fetchRecentMessages(channel, SCAN_PAGES_PERMANENT);
  const found = recent.find(isRecruitmentLeaderboardMessage) || null;
  if (found) recruitmentLeaderboardMessageId = found.id;
  return found;
}

async function getRecruitmentStandings() {
  const supabase = getSupabase();
  let submissions = [];
  if (supabase) {
    const { data, error } = await supabase.from("recruitment_drive_submissions").select("*");
    if (error) {
      console.error("[RecruitmentDrive] Could not load submissions:", error.message);
    } else if (data) {
      submissions = data;
    }
  } else {
    submissions = recruitmentMemoryStore.submissions;
  }

  const byRecruiter = new Map();
  for (const s of submissions) {
    const key = s.recruiter_id;
    if (!byRecruiter.has(key)) {
      byRecruiter.set(key, { recruiterId: key, recruiterTag: s.recruiter_tag, recruits: 0, bonuses: 0, firstAt: s.created_at });
    }
    const entry = byRecruiter.get(key);
    entry.recruits += 1;
    if (s.join_bonus_awarded) entry.bonuses += 1;
    if (new Date(s.created_at) < new Date(entry.firstAt)) entry.firstAt = s.created_at;
  }

  const standings = [...byRecruiter.values()].map((e) => ({ ...e, points: e.recruits + e.bonuses }));
  standings.sort((a, b) => b.points - a.points || new Date(a.firstAt) - new Date(b.firstAt));
  return standings;
}

async function refreshRecruitmentLeaderboard() {
  const channel = await getChannelById(RECRUITMENT_DRIVE_CHANNEL_ID, "RecruitmentDrive");
  if (!channel) return;
  const leaderboard = await getRecruitmentLeaderboardMessage(channel);
  const standings = await getRecruitmentStandings();
  const payload = buildRecruitmentLeaderboardEmbed(standings, { final: getRecruitmentDrivePhase() === "ended" });
  if (leaderboard) {
    await leaderboard.edit(payload).catch((e) => console.warn("[RecruitmentDrive] Could not refresh leaderboard:", e.message));
  } else {
    const sent = await channel.send(payload).catch(() => null);
    if (sent) recruitmentLeaderboardMessageId = sent.id;
  }
}

async function refreshRecruitmentAnnouncement(phase) {
  const channel = await getChannelById(RECRUITMENT_DRIVE_CHANNEL_ID, "RecruitmentDrive");
  if (!channel) return;
  const announcement = await getRecruitmentAnnouncementMessage(channel);
  if (!announcement) return;
  await announcement.edit(buildRecruitmentDriveEmbed(phase)).catch((e) => console.warn("[RecruitmentDrive] Could not refresh announcement:", e.message));
}

async function postRecruitmentDriveFinalResults() {
  const channel = await getChannelById(RECRUITMENT_DRIVE_CHANNEL_ID, "RecruitmentDrive");
  if (!channel) return;

  const leaderboardMsg = await getRecruitmentLeaderboardMessage(channel);
  if (leaderboardMsg?.embeds?.[0]?.title?.includes("Final")) return; // already finalized

  const standings = await getRecruitmentStandings();
  const payload = buildRecruitmentLeaderboardEmbed(standings, { final: true });
  if (leaderboardMsg) {
    await leaderboardMsg.edit(payload).catch((e) => console.warn("[RecruitmentDrive] Could not finalize leaderboard:", e.message));
  } else {
    const sent = await channel.send(payload).catch(() => null);
    if (sent) recruitmentLeaderboardMessageId = sent.id;
  }

  const topScore = standings[0]?.points ?? 0;
  const winners = standings.filter((s) => s.points === topScore && topScore > 0);
  if (winners.length > 1) {
    await channel
      .send({
        content:
          `The Recruitment Drive has ended and it's a tie for first place between ${winners.map((w) => `<@${w.recruiterId}>`).join(", ")} ` +
          `at **${topScore}** points each. <@&${LEADER_ROLE_ID}> <@&${CO_OWNER_ROLE_ID}> please decide how the ${RECRUITMENT_DRIVE_PRIZE_TEXT} prize should be handled.`,
      })
      .catch(() => {});
  } else if (winners.length === 1) {
    await channel
      .send({
        content: `The Recruitment Drive has ended! Congratulations to <@${winners[0].recruiterId}> for recruiting the most members and winning ${RECRUITMENT_DRIVE_PRIZE_TEXT}!`,
      })
      .catch(() => {});
  }
}

async function ensureRecruitmentDriveMessages() {
  const channel = await getChannelById(RECRUITMENT_DRIVE_CHANNEL_ID, "RecruitmentDrive");
  if (!channel) return;

  const phase = getRecruitmentDrivePhase();
  const announcementPayload = buildRecruitmentDriveEmbed(phase);

  let announcement = await getRecruitmentAnnouncementMessage(channel);
  if (!announcement) {
    announcement = await channel.send(announcementPayload).catch((e) => {
      console.error("[RecruitmentDrive] Could not post announcement:", e.message);
      return null;
    });
    if (announcement) {
      recruitmentAnnouncementMessageId = announcement.id;
      console.log("[RecruitmentDrive] Posted event announcement.");
    }
  } else {
    await announcement.edit(announcementPayload).catch((e) => console.warn("[RecruitmentDrive] Could not refresh announcement:", e.message));
  }

  let leaderboard = await getRecruitmentLeaderboardMessage(channel);
  if (!leaderboard) {
    const standings = await getRecruitmentStandings();
    leaderboard = await channel.send(buildRecruitmentLeaderboardEmbed(standings, { final: phase === "ended" })).catch((e) => {
      console.error("[RecruitmentDrive] Could not post leaderboard:", e.message);
      return null;
    });
    if (leaderboard) {
      recruitmentLeaderboardMessageId = leaderboard.id;
      console.log("[RecruitmentDrive] Posted leaderboard.");
    }
  }

  lastRecruitmentPhase = phase;
  if (phase === "ended") {
    await postRecruitmentDriveFinalResults().catch((e) => console.error("[RecruitmentDrive] Final results check failed:", e.message));
  }
}

function startRecruitmentDriveLoop() {
  if (recruitmentDriveTimer) clearInterval(recruitmentDriveTimer);

  // Check every 60 seconds for whether the event has crossed its start or end
  // boundary so the button can be enabled/disabled right on schedule.
  recruitmentDriveTimer = setInterval(async () => {
    try {
      const phase = getRecruitmentDrivePhase();
      if (phase === lastRecruitmentPhase) return;
      lastRecruitmentPhase = phase;
      await refreshRecruitmentAnnouncement(phase);
      if (phase === "ended") {
        await postRecruitmentDriveFinalResults();
      }
    } catch (err) {
      console.error("[RecruitmentDrive] Loop error:", err.message);
    }
  }, 60 * 1000);

  if (typeof recruitmentDriveTimer.unref === "function") recruitmentDriveTimer.unref();
}

async function getOrCreateRecruitmentThread(channel, memberOrUser) {
  const recruiterId = memberOrUser.id;
  const supabase = getSupabase();

  let threadId = null;
  if (supabase) {
    const { data } = await supabase
      .from("recruitment_drive_threads")
      .select("thread_id")
      .eq("recruiter_id", recruiterId)
      .maybeSingle();
    threadId = data?.thread_id || null;
  } else {
    threadId = recruitmentMemoryStore.threads.get(recruiterId) || null;
  }

  if (threadId) {
    const existing = await channel.threads.fetch(threadId).catch(() => null);
    if (existing) return existing;
  }

  const displayName = (memberOrUser.displayName || memberOrUser.user?.username || memberOrUser.username || "Recruiter").slice(0, 90);

  const thread = await channel.threads
    .create({
      name: displayName,
      autoArchiveDuration: RECRUITMENT_THREAD_AUTO_ARCHIVE_MINUTES,
      reason: "Recruitment Drive screenshot evidence thread",
    })
    .catch((e) => {
      console.error("[RecruitmentDrive] Could not create thread:", e.message);
      return null;
    });
  if (!thread) return null;

  if (supabase) {
    const { error } = await supabase
      .from("recruitment_drive_threads")
      .upsert({ recruiter_id: recruiterId, thread_id: thread.id }, { onConflict: "recruiter_id" });
    if (error) console.error("[RecruitmentDrive] Could not persist thread mapping:", error.message);
  } else {
    recruitmentMemoryStore.threads.set(recruiterId, thread.id);
  }

  return thread;
}

async function getNextRecruitmentScreenshotNumber(recruiterId) {
  const supabase = getSupabase();
  if (supabase) {
    const { count, error } = await supabase
      .from("recruitment_drive_submissions")
      .select("id", { count: "exact", head: true })
      .eq("recruiter_id", recruiterId);
    if (error) {
      console.error("[RecruitmentDrive] Could not count submissions:", error.message);
      return 1;
    }
    return (count || 0) + 1;
  }
  return recruitmentMemoryStore.submissions.filter((s) => s.recruiter_id === recruiterId).length + 1;
}

async function recordRecruitmentSubmission({ recruiterId, recruiterTag, threadId, screenshotNumber, note }) {
  const supabase = getSupabase();
  const createdAt = new Date().toISOString();

  if (supabase) {
    const { data, error } = await supabase
      .from("recruitment_drive_submissions")
      .insert({
        recruiter_id: recruiterId,
        recruiter_tag: recruiterTag,
        thread_id: threadId,
        screenshot_number: screenshotNumber,
        note,
        created_at: createdAt,
      })
      .select("id")
      .single();
    if (error) {
      console.error("[RecruitmentDrive] Could not record submission:", error.message);
      return null;
    }
    return data.id;
  }

  const id = recruitmentMemoryStore.nextId++;
  recruitmentMemoryStore.submissions.push({
    id,
    recruiter_id: recruiterId,
    recruiter_tag: recruiterTag,
    thread_id: threadId,
    screenshot_number: screenshotNumber,
    note,
    join_bonus_awarded: false,
    created_at: createdAt,
  });
  return id;
}

async function attachRecruitmentSubmissionMessageId(submissionId, messageId) {
  if (submissionId == null) return;
  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase.from("recruitment_drive_submissions").update({ message_id: messageId }).eq("id", submissionId);
    if (error) console.warn("[RecruitmentDrive] Could not attach message id:", error.message);
    return;
  }
  const row = recruitmentMemoryStore.submissions.find((s) => s.id === submissionId);
  if (row) row.message_id = messageId;
}

async function getRecruitmentSubmissionById(submissionId) {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase.from("recruitment_drive_submissions").select("*").eq("id", submissionId).maybeSingle();
    if (error) {
      console.error("[RecruitmentDrive] Could not load submission:", error.message);
      return null;
    }
    return data;
  }
  return recruitmentMemoryStore.submissions.find((s) => String(s.id) === String(submissionId)) || null;
}

async function markRecruitmentBonusAwarded(submissionId, staffUserId) {
  const supabase = getSupabase();
  const awardedAt = new Date().toISOString();
  if (supabase) {
    const { error } = await supabase
      .from("recruitment_drive_submissions")
      .update({ join_bonus_awarded: true, join_bonus_awarded_by: staffUserId, join_bonus_awarded_at: awardedAt })
      .eq("id", submissionId);
    if (error) console.error("[RecruitmentDrive] Could not mark bonus awarded:", error.message);
    return;
  }
  const row = recruitmentMemoryStore.submissions.find((s) => String(s.id) === String(submissionId));
  if (row) {
    row.join_bonus_awarded = true;
    row.join_bonus_awarded_by = staffUserId;
    row.join_bonus_awarded_at = awardedAt;
  }
}

async function onRecruitmentUploadButton(interaction) {
  const phase = getRecruitmentDrivePhase();
  if (phase === "scheduled") {
    const startTs = Math.floor(RECRUITMENT_DRIVE_START_MS / 1000);
    return interaction.reply({
      content: `This event hasn't started yet — it opens <t:${startTs}:F> (<t:${startTs}:R>).`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (phase === "ended") {
    return interaction.reply({ content: "This event has ended. Thanks for taking part!", flags: MessageFlags.Ephemeral });
  }

  pendingRecruitmentUploads.set(interaction.user.id, { expiresAt: Date.now() + RECRUITMENT_UPLOAD_WINDOW_MS });

  return interaction.reply({
    content:
      `Post your screenshot as a message right here in <#${RECRUITMENT_DRIVE_CHANNEL_ID}> within the next 10 minutes.\n\n` +
      "In the **same message as the screenshot**, include:\n" +
      "1. The name of the player you recruited\n" +
      "2. Whether they've joined our Discord yet (yes/no)\n\n" +
      "Example: `PlayerName123 - no, not on Discord yet`\n\n" +
      "Heimdall will move it into your own thread in this channel and delete the original message automatically.",
    flags: MessageFlags.Ephemeral,
  });
}

async function onRecruitmentConfirmBonus(interaction, submissionId) {
  if (!hasAnyRole(interaction.member, RECRUITMENT_STAFF_ROLE_IDS)) {
    return interaction.reply({
      content: "Only Staff, Jr. Staff, Leaders, Co-Owners, or the Owner can confirm this bonus.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const submission = await getRecruitmentSubmissionById(submissionId);
  if (!submission) {
    return interaction.reply({ content: "Could not find this submission anymore.", flags: MessageFlags.Ephemeral });
  }
  if (submission.join_bonus_awarded) {
    return interaction.reply({ content: "This bonus has already been confirmed.", flags: MessageFlags.Ephemeral });
  }

  await markRecruitmentBonusAwarded(submissionId, interaction.user.id);

  const confirmedRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID.RECRUITMENT_CONFIRM_BONUS}:${submissionId}:done`)
      .setLabel(`Discord Join Bonus Confirmed — ${interaction.member?.displayName || interaction.user.username}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
  await interaction.message.edit({ components: [confirmedRow] }).catch((e) => console.warn("[RecruitmentDrive] Could not update thread message:", e.message));

  await refreshRecruitmentLeaderboard();

  return interaction.reply({ content: "Confirmed — the Discord join bonus point has been added to the leaderboard.", flags: MessageFlags.Ephemeral });
}

async function handleRecruitmentDriveMessage(message) {
  const phase = getRecruitmentDrivePhase();
  const session = pendingRecruitmentUploads.get(message.author.id);
  const hasActiveSession = !!session && session.expiresAt > Date.now();
  const attachment = message.attachments?.first();
  const isImage =
    !!attachment && (attachment.contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || ""));

  if (phase !== "active" || !hasActiveSession || !isImage) {
    await message.delete().catch(() => {});
    if (phase === "active") {
      const note = !hasActiveSession
        ? "Press **Upload Screenshot** on the event post above first, then post your screenshot here."
        : "That message needs an image screenshot attached.";
      const temp = await message.channel.send({ content: `<@${message.author.id}> ${note}` }).catch(() => null);
      if (temp) setTimeout(() => temp.delete().catch(() => {}), 15000);
    }
    return;
  }

  const note = (message.content || "").trim();
  if (!note) {
    await message.delete().catch(() => {});
    const temp = await message.channel
      .send({
        content: `<@${message.author.id}> Please include the recruited player's name and whether they've joined our Discord (yes/no) in the same message as your screenshot, then try again.`,
      })
      .catch(() => null);
    if (temp) setTimeout(() => temp.delete().catch(() => {}), 15000);
    return; // session stays open so they can retry within the window
  }

  pendingRecruitmentUploads.delete(message.author.id);

  let buffer;
  try {
    const res = await fetch(attachment.url);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("[RecruitmentDrive] Could not download screenshot:", err.message);
    const temp = await message.channel
      .send({ content: `<@${message.author.id}> Something went wrong downloading your screenshot. Please try again.` })
      .catch(() => null);
    if (temp) setTimeout(() => temp.delete().catch(() => {}), 15000);
    return;
  }

  const channel = await getChannelById(RECRUITMENT_DRIVE_CHANNEL_ID, "RecruitmentDrive");
  if (!channel) return;

  const thread = await getOrCreateRecruitmentThread(channel, message.member || message.author);
  if (!thread) return;

  const screenshotNumber = await getNextRecruitmentScreenshotNumber(message.author.id);
  const submissionId = await recordRecruitmentSubmission({
    recruiterId: message.author.id,
    recruiterTag: message.author.tag,
    threadId: thread.id,
    screenshotNumber,
    note,
  });

  const fileName = attachment.name || `screenshot-${screenshotNumber}.png`;
  const fileAttachment = new AttachmentBuilder(buffer, { name: fileName });
  const nowTs = Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle(`Screenshot #${screenshotNumber}`)
    .addFields(
      { name: "Submitted By", value: `<@${message.author.id}>`, inline: true },
      { name: "Uploaded", value: `<t:${nowTs}:F>`, inline: true },
      { name: "Details", value: note }
    )
    .setImage(`attachment://${fileName}`);

  const bonusRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID.RECRUITMENT_CONFIRM_BONUS}:${submissionId}`)
      .setLabel("Confirm Discord Join Bonus (Staff Only)")
      .setStyle(ButtonStyle.Success)
  );

  const sent = await thread.send({ embeds: [embed], files: [fileAttachment], components: [bonusRow] }).catch((e) => {
    console.error("[RecruitmentDrive] Could not post to thread:", e.message);
    return null;
  });

  if (sent) {
    await attachRecruitmentSubmissionMessageId(submissionId, sent.id);
  }

  await message.delete().catch(() => {});
  await refreshRecruitmentLeaderboard();
}

async function handleMessageCreate(message) {
  if (!message || message.author?.bot) return;

  if (message.guildId && message.channelId === RECRUITMENT_DRIVE_CHANNEL_ID) {
    await handleRecruitmentDriveMessage(message).catch((e) => console.error("[RecruitmentDrive] message handler error:", e.message));
    return; // this channel is fully bot-managed — nothing else should act on it
  }

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

async function handleInteraction(interaction) {
  if (!interaction.inGuild()) return;

  if (interaction.isChatInputCommand?.() && interaction.commandName === "upload-roster") {
    return onUploadRosterSlashCommand(interaction);
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
      case ID.TICKET_CONFIRM:       return onTicketConfirm(interaction, payload);
      case ID.TICKET_CANCEL:        return onTicketCancel(interaction);
      case ID.TICKET_CLOSE_C1:      return onTicketCloseC1(interaction);
      case ID.TICKET_CLOSE_C2:      return onTicketCloseC2(interaction);
      case ID.TICKET_CLOSE_CANCEL:  return onTicketCloseCancel(interaction);
      case ID.TICKET_ACCEPT_C1:     return onTicketAcceptC1(interaction);
      case ID.TICKET_ACCEPT_C2:     return onTicketAcceptC2(interaction);
      case ID.TICKET_ACCEPT_CANCEL: return onTicketAcceptCancel(interaction);
      case ID.TICKET_DENY_C1:       return onTicketDenyC1(interaction);
      case ID.TICKET_DENY_C2:       return onTicketDenyC2(interaction);
      case ID.TICKET_DENY_CANCEL:   return onTicketDenyCancel(interaction);
      case ID.TICKET_ALERT_ACK:     return onTicketAlertAck(interaction);
      case ID.TICKET_COMPLIMENT_TARGET:        return onTicketComplimentTarget(interaction, payload);
      case ID.TICKET_COMPLIMENT_USER_CONFIRM:  return onTicketComplimentUserConfirm(interaction, payload);
      case ID.TICKET_COMPLIMENT_USER_CANCEL:   return onTicketComplimentUserCancel(interaction);
      case ID.RECRUITMENT_UPLOAD_BTN:    return onRecruitmentUploadButton(interaction);
      case ID.RECRUITMENT_CONFIRM_BONUS: return onRecruitmentConfirmBonus(interaction, payload);
      default:                      return;
    }
  }

  if (interaction.isStringSelectMenu?.()) {
    if (interaction.customId === ID.TICKET_SELECT) return onTicketSelect(interaction);
    return;
  }

  if (interaction.isUserSelectMenu?.()) {
    if (interaction.customId === ID.TICKET_COMPLIMENT_USER_SELECT) return onTicketComplimentUserSelect(interaction);
    return;
  }

  if (interaction.isModalSubmit()) {
    const [modalBase, modalPayload] = interaction.customId.split(":");
    if (interaction.customId === ID.MODAL) return onModalSubmit(interaction);
    if (interaction.customId === ID.ROSTER_MODAL) return onRosterModalSubmit(interaction);
    if (interaction.customId === ID.TICKET_DENY_MODAL) return onTicketDenyModalSubmit(interaction);
    if (modalBase === ID.TICKET_COMPLIMENT_MODAL_GENERAL) return onTicketComplimentModalGeneral(interaction);
    if (modalBase === ID.TICKET_COMPLIMENT_MODAL_MEMBER) return onTicketComplimentModalMember(interaction, modalPayload);
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
    await ensureTicketPanelMessage();
  } catch (err) {
    console.error("[Tickets] ensureTicketPanelMessage failed:", err.message);
  }
  try {
    await scanExistingTempVoiceChannels();
  } catch (err) {
    console.error("[OsrsVoice] scanExistingTempVoiceChannels failed:", err.message);
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
  try {
    const initialRecapWindow = findMostRecentCompletedRecapWindow(new Date());
    if (initialRecapWindow) {
      lastFiredRecapWeekKey = initialRecapWindow.weekKey;
      await runWeeklyRecap(initialRecapWindow, new Date());
    }
    startWeeklyRecapLoop();
  } catch (err) {
    console.error("[WeeklyRecap] Initial check failed:", err.message);
  }
  try {
    await ensureRecruitmentDriveMessages();
    startRecruitmentDriveLoop();
  } catch (err) {
    console.error("[RecruitmentDrive] Initial setup failed:", err.message);
  }
  try {
    await runServerPrivacySync();
    startServerPrivacyLoop();
  } catch (err) {
    console.error("[ServerPrivacy] Initial sync failed:", err.message);
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
  handleVoiceStateUpdate(oldState, newState).catch((e) => console.error("[OsrsVoice] VoiceStateUpdate error:", e.message));
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
  isManagedTempVoiceChannel,
  getNextOsrsVoiceChannelNumber,
  createOsrsVoiceChannel,
  handleVoiceStateUpdate,
  scheduleTempVoiceDeletion,
  clearTempVoiceTimer,
  scanExistingTempVoiceChannels,
  deletePingsFor,
  // Ticketing system exports
  TICKET_CONTACT_CHANNEL_ID,
  TICKET_CATEGORY_ID,
  TICKET_TRANSCRIPT_CHANNEL_ID,
  TICKET_CLOSE_DELETE_DELAY_MS,
  TICKET_TYPES,
  TICKET_TYPE_ORDER,
  STAFF_APPLICATION_QUESTIONS,
  encodeTicketTopic,
  decodeTicketTopic,
  buildTicketChannelName,
  buildTicketPermissionOverwrites,
  buildTicketPanelMessage,
  ensureTicketPanelMessage,
  buildTicketOpeningMessage,
  buildChannelTranscript,
  finalizeTicketClosure,
  isTicketParticipant,
  isTicketDecisionMaker,
  findOpenTicketChannel,
  onTicketSelect,
  onTicketConfirm,
  onTicketCancel,
  onTicketCloseC1,
  onTicketCloseC2,
  onTicketCloseCancel,
  onTicketAcceptC1,
  onTicketAcceptC2,
  onTicketAcceptCancel,
  onTicketDenyC1,
  onTicketDenyC2,
  onTicketDenyCancel,
  onTicketDenyModalSubmit,
  onTicketAlertAck,
  // Give Compliment sub-flow exports
  onComplimentTypeSelected,
  buildComplimentModal,
  onTicketComplimentTarget,
  onTicketComplimentUserSelect,
  onTicketComplimentUserCancel,
  onTicketComplimentUserConfirm,
  onTicketComplimentModalGeneral,
  onTicketComplimentModalMember,
  buildComplimentChannelName,
  buildComplimentPermissionOverwrites,
  buildComplimentEmbed,
  createComplimentTicket,
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
  isRankSyncDue,
  startRankingSyncLoop,
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
  OSRS_VOICE_HUB_CHANNEL_ID,
  OSRS_VOICE_CATEGORY_ID,
  OSRS_VOICE_PREFIX,
  OSRS_VOICE_EMPTY_TIMEOUT_MS,
  OSRS_VOICE_INITIAL_EMPTY_TIMEOUT_MS,
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
  // Weekly Recap exports
  WEEKLY_RECAP_CHANNEL_ID,
  WEEKLY_RECAP_HOUR,
  WEEKLY_RECAP_ANCHOR_DATE,
  RAID_NAMES,
  RAID_BOSS_ENTRIES,
  OSRS_MINIGAMES,
  PVM_BOSS_ENTRIES,
  getRecapWindowByIndex,
  findMostRecentCompletedRecapWindow,
  extractMemberHiscoreSnapshot,
  sumSkillGain,
  sumActivityGain,
  computeHonourMarksLeaderboard,
  buildWeeklyRecapEmbed,
  runWeeklyRecap,
  startWeeklyRecapLoop,
  // Recruitment Drive exports
  RECRUITMENT_DRIVE_CHANNEL_ID,
  RECRUITMENT_DRIVE_PRIZE_TEXT,
  RECRUITMENT_DRIVE_START_MS,
  RECRUITMENT_DRIVE_END_MS,
  RECRUITMENT_UPLOAD_WINDOW_MS,
  RECRUITMENT_STAFF_ROLE_IDS,
  getRecruitmentDrivePhase,
  buildRecruitmentDriveEmbed,
  buildRecruitmentLeaderboardEmbed,
  getRecruitmentStandings,
  getOrCreateRecruitmentThread,
  getNextRecruitmentScreenshotNumber,
  recordRecruitmentSubmission,
  getRecruitmentSubmissionById,
  markRecruitmentBonusAwarded,
  ensureRecruitmentDriveMessages,
  refreshRecruitmentLeaderboard,
  postRecruitmentDriveFinalResults,
  onRecruitmentUploadButton,
  onRecruitmentConfirmBonus,
  handleRecruitmentDriveMessage,
  // Server Privacy exports
  CLAN_FRIEND_ROLE_ID,
  SOCIAL_CHATTER_ROLE_ID,
  WELCOME_CATEGORY_ID,
  STAFF_AREA_CATEGORY_ID,
  SOCIAL_HUB_CATEGORY_ID,
  SERVER_LOGS_CATEGORY_ID,
  STAFF_CHAT_CHANNEL_ID,
  LEADER_CHANNEL_ID,
  OWNER_CHAT_CHANNEL_ID,
  CLAN_CHAT_CHANNEL_ID,
  SERVER_LOGS_OWNER_USER_ID,
  SERVER_PRIVACY_CATEGORIES,
  EVERYONE_OPEN,
  EVERYONE_DENY,
  buildStaticOverwriteRows,
  applyStaticRuleToChannel,
  applyServerPrivacyCategory,
  isPendingNicknameVerification,
  isPendingOrientation,
  isEligibleForOsrsRole,
  syncOsrsRoleForMember,
  isServerPrivacySyncDue,
  applyServerPrivacyConfig,
  runServerPrivacySync,
  startServerPrivacyLoop,
  setMemberChannelAllow,
  setMemberChannelBlock,
  syncClanChatAccessForMember,
  syncOrientationAccessForMember,
  reconcileAllMembersChannelAccess,
  processOnboardingCompletion,
};
