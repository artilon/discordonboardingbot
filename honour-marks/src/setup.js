"use strict";
const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { getSupabase, setConfigValue, getConfigJson } = require("./db");
const { config } = require("./config");

/**
 * Setup has two modes and both are re-runnable.
 *
 *   AUTOMATIC  creates a category + channels + staff role, then binds them.
 *   MANUAL     binds to channels/roles the admin already has.
 *
 * Everything is written to `bot_config` under `setup`, so `/setup repair` can
 * reconcile later — channels get deleted, permissions get broken, and a bot
 * that can only set itself up once is a bot you re-invite every few months.
 */

const SETUP_KEY = "setup";

const CHANNEL_SPECS = [
  { key: "quests", name: "honour-marks", topic: "Quests, team quests, and the shop" },
  { key: "database", name: "hm-database", topic: "Honour Marks totals, quest counts, and HM held" },
  { key: "staff", name: "hm-staff", topic: "Staff only — manual HM adjustments", staffOnly: true },
  { key: "log", name: "hm-log", topic: "Honour Marks audit log", readOnly: true },
];

async function readSetup(guildId) {
  return (await getConfigJson(guildId, SETUP_KEY)) || null;
}

async function writeSetup(guildId, data) {
  await setConfigValue(guildId, SETUP_KEY, JSON.stringify(data));
}

/**
 * Creates the category and channels. Requires Manage Channels, and the bot's
 * role must sit above the channels it manages.
 */
async function createStructure(guild, { categoryName = "Honour Marks" } = {}) {
  const created = {};

  const category = await guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
    reason: "Honour Marks setup",
  });
  created.categoryId = category.id;

  for (const spec of CHANNEL_SPECS) {
    const overwrites = [];
    if (spec.staffOnly) {
      overwrites.push({
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      });
    }
    const channel = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildText,
      topic: spec.topic,
      parent: category.id,
      permissionOverwrites: overwrites,
      reason: "Honour Marks setup",
    });
    created[spec.key] = channel.id;
  }

  return created;
}

/**
 * Binds a guild to a set of channels. `channels` may be partial — anything
 * missing is treated as "not configured", and the panels that need it are
 * skipped rather than crashing.
 */
async function bindGuild(guildId, { channels = {}, mode = "manual", categoryId = null, staffRoleId = null }) {
  const data = {
    mode,
    categoryId,
    staffRoleId: staffRoleId || config.roles.staff || null,
    channels: {
      quests: channels.quests || config.channels.quests || null,
      shop: channels.shop || config.channels.shop || null,
      database: channels.database || config.channels.database || null,
      staff: channels.staff || config.channels.staff || null,
      log: channels.log || config.channels.log || null,
    },
    configuredAt: new Date().toISOString(),
  };
  await writeSetup(guildId, data);
  return data;
}

/** Validates that every bound channel still exists and is a text channel. */
async function verifyBindings(guild, setup) {
  const problems = [];
  if (!setup?.channels) {
    problems.push("No setup found. Run `/setup` first.");
    return { ok: false, problems };
  }

  for (const [key, id] of Object.entries(setup.channels)) {
    if (!id) continue;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch) {
      problems.push(`Channel \`${key}\` (${id}) is missing.`);
    } else if (!ch.isTextBased()) {
      problems.push(`Channel \`${key}\` (${id}) is not a text channel.`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Ensures a snapshot row exists so a brand-new guild renders something sane. */
async function seedDefaults(guildId) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { data } = await supabase
    .from("hm_rank_xp_rules")
    .select("event_key")
    .eq("guild_id", guildId)
    .limit(1);
  if (data?.length) return;

  const rows = Object.entries(config.rankXp).map(([eventKey, xp]) => ({
    guild_id: guildId,
    event_key: eventKey,
    xp,
    enabled: true,
    note: "copied from defaults on setup",
  }));
  await supabase.from("hm_rank_xp_rules").insert(rows);
}

module.exports = {
  SETUP_KEY, CHANNEL_SPECS,
  readSetup, writeSetup, createStructure, bindGuild, verifyBindings, seedDefaults,
};
