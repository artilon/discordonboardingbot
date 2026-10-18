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
const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildMemberFlags,
  MessageFlags,
  ModalBuilder,
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

// Orientation acknowledgement
const ORIENTATION_CHANNEL_ID   = "1559995329825472542";
const LEADER_ROLE_ID           = "1546401937883402293";
const STAFF_ROLE_ID            = "1546402959049359360";
const JR_STAFF_ROLE_ID         = "1546403383752134656";
const VERIFIED_LEADER_ROLE_ID  = "1559994620442710097";
const VERIFIED_STAFF_ROLE_ID   = "1559997317325656094";

// Ranking system channels
const STAFF_ALERT_CHANNEL_ID = "1561481869197840504";
const RANK_LIST_CHANNEL_ID   = "1561482413341679757";
const RANK_LOG_CHANNEL_ID    = "1561484125016428605";

// Clan creation date floor (join dates earlier than this are clamped to 2026-10-11)
const CLAN_CREATION_DATE = "2026-10-11";

// Tenure XP award amounts
const WEEKLY_BASE_XP  = 2500;   // Multiplied by current rank multiplier every 7 days
const MONTHLY_BASE_XP = 10000;  // Awarded every 30 days
const YEARLY_BASE_XP  = 100000; // Awarded every 365 days

// Rank progression table (Bronze -> Legacy)
const RANK_TIERS = [
  { name: "Bronze",      multiplier: 1,    xpNeeded: 0 },
  { name: "Steel",       multiplier: 1,    xpNeeded: 2500 },
  { name: "Black",       multiplier: 1,    xpNeeded: 10000 },
  { name: "Mithril",     multiplier: 1.5,  xpNeeded: 20000 },
  { name: "Adamant",     multiplier: 1.5,  xpNeeded: 42500 },
  { name: "Rune",        multiplier: 2,    xpNeeded: 65000 },
  { name: "Dragon",      multiplier: 2,    xpNeeded: 105000 },
  { name: "Sapphire",    multiplier: 2.5,  xpNeeded: 155000 },
  { name: "Emerald",     multiplier: 2.5,  xpNeeded: 220000 },
  { name: "Ruby",        multiplier: 3,    xpNeeded: 295000 },
  { name: "Diamond",     multiplier: 3,    xpNeeded: 400000 },
  { name: "Dragonstone", multiplier: 3.5,  xpNeeded: 500000 },
  { name: "Onyx",        multiplier: 3.5,  xpNeeded: 655000 },
  { name: "Zenyte",      multiplier: 4,    xpNeeded: 780000 },
  { name: "Legacy",      multiplier: null, xpNeeded: 1045000 },
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
  rankSyncIntervalMs: 5 * 60 * 1000, // Check Supabase + tenure milestones every 5 minutes
  multiplyMonthlyYearly: false,      // Weekly uses rank multiplier; Monthly & Yearly are flat bonuses
  supabase: null,                    // Initialized on startup or injected for tests
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
  RANKUP_C1:         "rankup_c1",
  RANKUP_C2:         "rankup_c2",
  RANKUP_CANCEL:     "rankup_cancel",
  LEFT_C1:           "left_c1",
  LEFT_C2:           "left_c2",
  LEFT_CANCEL:       "left_cancel",
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
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

function formatMultiplier(mult) {
  return mult === null || mult === undefined ? "n/a" : `${mult}x`;
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
  return `${parts.join(" ")} (${d}d)`;
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
          reason: `Week #${weekIndex} clan tenure (${WEEKLY_BASE_XP.toLocaleString()} base × ${mult}x ${rankBefore.name})`,
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
            ? `Month #${monthIndex} clan tenure (${MONTHLY_BASE_XP.toLocaleString()} base × ${mult}x ${rankBefore.name})`
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
            ? `Year #${yearIndex} clan tenure (${YEARLY_BASE_XP.toLocaleString()} base × ${mult}x ${rankBefore.name})`
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

// ================= RANKING SYSTEM: PERMANENT RANK LIST, ALERTS & LOGS =================
function buildRankTableSummary() {
  return RANK_TIERS.map((t) => {
    const multText = t.multiplier ? `${t.multiplier}x` : "Max";
    return `**${t.name}** (${multText}) — \`${t.xpNeeded.toLocaleString()} XP\``;
  }).join(" • ");
}

function buildRankListPayload(members = [], asOfDate = new Date()) {
  const activeMembers = members
    .filter((m) => m.active !== false)
    .slice()
    .sort((a, b) => {
      const xpDiff = (Number(b.xp) || 0) - (Number(a.xp) || 0);
      if (xpDiff !== 0) return xpDiff;
      return String(a.rsn || "").localeCompare(String(b.rsn || ""));
    });

  const asOfParsed = parseJoinedDate(asOfDate) || parseJoinedDate(new Date());
  const nowUnix = Math.floor(Date.now() / 1000);

  const headerDesc =
    "** Clan Rank Progression & Member Standings**\n" +
    `Weekly: \`+${WEEKLY_BASE_XP.toLocaleString()} XP × Multiplier\` • ` +
    `Monthly: \`+${MONTHLY_BASE_XP.toLocaleString()} XP\` • ` +
    `Yearly: \`+${YEARLY_BASE_XP.toLocaleString()} XP\`\n\n` +
    `**Rank Tiers:**\n${buildRankTableSummary()}\n\n` +
    `**Active Clan Members:** \`${activeMembers.length}\` • **Last Synced:** <t:${nowUnix}:R>`;

  const lines = activeMembers.map((m, idx) => {
    const xp = Number(m.xp) || 0;
    const eligibleTier = getRankForXp(xp);
    const confirmedRank = m.confirmed_rank || "Bronze";
    const multStr = formatMultiplier(eligibleTier.multiplier);
    const joined = parseJoinedDate(m.joined_date);
    const days = joined && asOfParsed ? Math.max(0, Math.floor((asOfParsed.utcMs - joined.utcMs) / MS_PER_DAY)) : 0;
    const joinedStr = joined ? joined.iso : "Unknown";
    const pendingTag =
      getRankIndex(eligibleTier.name) > getRankIndex(confirmedRank)
        ? ` *(⏳ Rank-up to **${eligibleTier.name}** pending)*`
        : "";

    return (
      `**${idx + 1}. ${m.rsn}** — **${confirmedRank}** (${multStr}) • \`${xp.toLocaleString()} XP\`\n` +
      `┗ Joined: \`${joinedStr}\` (${formatTenureDuration(days)})${pendingTag}`
    );
  });

  const embeds = [];
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
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds, components: [row] };
}

async function ensureRankListMessage(members) {
  let list = members;
  if (!list) {
    const supabase = getSupabase();
    if (supabase) {
      const { data } = await supabase
        .from("clan_members")
        .select("*")
        .eq("active", true)
        .order("xp", { ascending: false });
      list = data || [];
    } else {
      list = [];
    }
  }

  return ensureEmbedMessage({
    channelId: RANK_LIST_CHANNEL_ID,
    label: "RankList",
    buttonIds: [ID.RANK_LIST_REFRESH],
    payload: buildRankListPayload(list),
    what: "permanent clan rank list",
  });
}

// ---- Staff Alert Builders (2-Step Confirmation) ----
function buildRankUpAlertStep1(member, targetRankName) {
  const xp = Number(member.xp) || 0;
  const currentRank = member.confirmed_rank || "Bronze";
  const targetTier = RANK_TIERS.find((t) => t.name === targetRankName) || getRankForXp(xp);
  const nextTier = getNextRankTier(targetTier.name);
  const joined = parseJoinedDate(member.joined_date);
  const days = joined ? Math.max(0, Math.floor((Date.now() - joined.utcMs) / MS_PER_DAY)) : 0;

  const embed = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle(`Rank-Up Alert — ${member.rsn}`)
    .setDescription(
      `**${member.rsn}** has earned enough Clan Rank XP to be promoted in-game!\n\n` +
      `Please rank them up in-game, then complete the double confirmation below.`
    )
    .addFields(
      { name: "Member (RSN)", value: `\`${member.rsn}\``, inline: true },
      { name: "Previous Rank", value: `**${currentRank}**`, inline: true },
      { name: "New Rank", value: `**${targetTier.name}** (${formatMultiplier(targetTier.multiplier)})`, inline: true },
      { name: "Total Rank XP", value: `\`${xp.toLocaleString()} XP\``, inline: true },
      { name: "Next Rank Goal", value: nextTier ? `${nextTier.name} (\`${nextTier.xpNeeded.toLocaleString()} XP\`)` : "Max Rank Reached", inline: true },
      { name: "Time in Clan", value: `${formatTenureDuration(days)} (Joined \`${joined ? joined.iso : member.joined_date}\`)`, inline: true }
    )
    .setFooter({ text: "Confirmation 1 of 2 • Alert auto-deletes after 2nd confirmation." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID.RANKUP_C1}:${encodeName(member.rsn)}:${targetTier.name}`)
      .setLabel(`Ranked Up to ${targetTier.name} In-Game (1/2)`)
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

function buildRankUpAlertStep2(rsn, currentRank, targetRankName, xp, clickedByUserId) {
  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle(`Confirmation 2 of 2 — Rank-Up for ${rsn}`)
    .setDescription(
      `<@${clickedByUserId}> marked **${rsn}** as ranked up.\n\n` +
      `Are you **absolutely sure** that **${rsn}** has been promoted from **${currentRank}** to **${targetRankName}** in-game?\n\n` +
      `Confirming will log the promotion in the XP & Rank Log channel, update the permanent rank list, and **auto-delete** this alert.`
    )
    .addFields(
      { name: "Member (RSN)", value: `\`${rsn}\``, inline: true },
      { name: "Promotion", value: `${currentRank} ➔ **${targetRankName}**`, inline: true },
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
      { name: "Last Rank", value: `**${lastRank}**`, inline: true },
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
      { name: "Final Rank", value: `**${lastRank}**`, inline: true },
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
        { name: "New Total XP", value: `\`${totalXp.toLocaleString()} XP\` (**${eligibleRankName}**)`, inline: true },
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
        { name: "New Total XP", value: `\`${totalXp.toLocaleString()} XP\` (**${eligibleRankName}**)`, inline: true },
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
      { name: "Rank Promotion", value: `${oldRank} ➔ **${newRank}**`, inline: true },
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
      { name: "Final Rank", value: `**${finalRank}**`, inline: true },
      { name: "Final Rank XP", value: `\`${xp.toLocaleString()} XP\``, inline: true },
      ...(staffUser
        ? [{ name: "Confirmed By (Staff)", value: `<@${staffUser.id}> (\`${staffUser.tag || staffUser.username}\`)`, inline: true }]
        : []),
      { name: "When", value: `<t:${nowUnix}:F>`, inline: true }
    );

  await channel.send({ embeds: [embed] }).catch((e) => console.warn("[RankLog] Failed to post departure log:", e.message));
}

// ---- Supabase Roster Upload & Sync Engine ----
async function processRosterUpload(supabase) {
  const { data: uploads, error: uploadErr } = await supabase
    .from("roster_upload")
    .select("*")
    .order("id", { ascending: true });

  if (uploadErr || !uploads || uploads.length === 0) return false;

  // Map latest uploaded entry per normalized RSN
  const uploadedByKey = new Map();
  for (const row of uploads) {
    const rsn = String(row.rsn || "").trim();
    const parsedDate = parseJoinedDate(row.joined_date);
    if (!rsn || !parsedDate) continue;
    const clampedIso = parsedDate.iso < CLAN_CREATION_DATE ? CLAN_CREATION_DATE : parsedDate.iso;
    uploadedByKey.set(rsn.toLowerCase(), {
      rsn,
      joined_date: clampedIso,
    });
  }

  if (uploadedByKey.size === 0) return false;

  const { data: existingMembers, error: existingErr } = await supabase
    .from("clan_members")
    .select("*");
  if (existingErr) {
    console.error("[RankSync] Could not fetch clan_members for roster upload:", existingErr.message);
    return false;
  }

  const existingByKey = new Map();
  for (const m of existingMembers || []) {
    existingByKey.set(String(m.rsn || "").trim().toLowerCase(), m);
  }

  const nowIso = new Date().toISOString();

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
    } else if (!existing.active || existing.joined_date !== uploaded.joined_date || existing.rsn !== uploaded.rsn) {
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

  // 3. Clear processed rows from roster_upload
  const uploadIds = uploads.map((u) => u.id).filter((id) => id !== undefined);
  if (uploadIds.length > 0) {
    await supabase.from("roster_upload").delete().in("id", uploadIds);
  }

  console.log(`[RankSync] Processed roster_upload (${uploadedByKey.size} member(s)).`);
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
        const calc = calculateTenureProgression(effectiveJoinedDate, asOfDate, member);
        const xpChanged = calc.xp !== (Number(member.xp) || 0);
        const rankChanged = calc.eligibleRank.name !== member.eligible_rank;
        const countersChanged =
          calc.weeksAwarded !== (Number(member.weeks_awarded) || 0) ||
          calc.monthsAwarded !== (Number(member.months_awarded) || 0) ||
          calc.yearsAwarded !== (Number(member.years_awarded) || 0);

        if (xpChanged || rankChanged || countersChanged || dateClamped) {
          const nowIso = new Date().toISOString();
          await supabase
            .from("clan_members")
            .update({
              joined_date: effectiveJoinedDate,
              xp: calc.xp,
              eligible_rank: calc.eligibleRank.name,
              weeks_awarded: calc.weeksAwarded,
              months_awarded: calc.monthsAwarded,
              years_awarded: calc.yearsAwarded,
              updated_at: nowIso,
            })
            .eq("id", member.id);

          member.xp = calc.xp;
          member.eligible_rank = calc.eligibleRank.name;
          member.weeks_awarded = calc.weeksAwarded;
          member.months_awarded = calc.monthsAwarded;
          member.years_awarded = calc.yearsAwarded;

          if (calc.newEvents.length > 0) {
            await logXpAwardToDiscord(member.rsn, calc.newEvents, calc.xp, calc.eligibleRank.name);
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
        syncClanRanks().catch((e) => console.error("[RankSync] Realtime sync error:", e.message));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "roster_upload" }, () => {
        syncClanRanks().catch((e) => console.error("[RankSync] Roster upload sync error:", e.message));
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
        .setDescription("The clan rank list and tenure milestones have been synced with Supabase."),
    ],
  });
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

  if (interaction.isButton()) {
    const [base, payload, extra] = interaction.customId.split(":");
    switch (base) {
      case ID.START:             return onStartButton(interaction);
      case ID.CONFIRM1:          return onConfirm1(interaction, payload);
      case ID.CONFIRM2:          return onConfirm2(interaction, payload);
      case ID.CANCEL:            return onCancel(interaction);
      case ID.ORIENT_LEADER:
      case ID.ORIENT_STAFF:
        return onOrientationAccept(interaction);
      case ID.RANK_LIST_REFRESH: return onRankListRefresh(interaction);
      case ID.RANKUP_C1:         return onRankUpConfirm1(interaction, payload, extra);
      case ID.RANKUP_C2:         return onRankUpConfirm2(interaction, payload, extra);
      case ID.RANKUP_CANCEL:     return onRankUpCancel(interaction, payload, extra);
      case ID.LEFT_C1:           return onMemberLeftConfirm1(interaction, payload);
      case ID.LEFT_C2:           return onMemberLeftConfirm2(interaction, payload);
      case ID.LEFT_CANCEL:       return onMemberLeftCancel(interaction, payload);
      default:                   return;
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === ID.MODAL) {
    return onModalSubmit(interaction);
  }
}

// ================= WIRING =================
client.once(Events.ClientReady, async () => {
  console.log(`[Heimdall] Logged in as ${client.user.tag}`);
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
    await ensureRankListMessage();
    await syncClanRanks();
  } catch (err) {
    console.error("[RankSync] Initial ranking sync failed:", err.message);
  }
  try {
    startRankingSyncLoop();
  } catch (err) {
    console.error("[RankSync] startRankingSyncLoop failed:", err.message);
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
  getNextRankTier,
  calculateTenureProgression,
  buildRankListPayload,
  buildRankUpAlertStep1,
  buildRankUpAlertStep2,
  buildMemberLeftAlertStep1,
  buildMemberLeftAlertStep2,
  ensureRankListMessage,
  syncClanRanks,
  processRosterUpload,
  ID,
  UNVERIFIED_ROLE_ID,
  CLAN_MEMBER_ROLE_ID,
  OSRS_ROLE_ID,
  ONBOARDING_CHANNEL_ID,
  ORIENTATION_CHANNEL_ID,
  LEADER_ROLE_ID,
  STAFF_ROLE_ID,
  JR_STAFF_ROLE_ID,
  VERIFIED_LEADER_ROLE_ID,
  VERIFIED_STAFF_ROLE_ID,
  STAFF_ALERT_CHANNEL_ID,
  RANK_LIST_CHANNEL_ID,
  RANK_LOG_CHANNEL_ID,
};
