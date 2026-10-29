"use strict";
const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { getSupabase, setConfigValue, getConfigJson } = require("./db");
const { config } = require("./config");
const {
  CHANNEL_SPECS, buildOverwrites, buildCategoryOverwrites, overwriteContext,
} = require("./permissions");

/**
 * Setup has two modes and both are re-runnable.
 *
 *   AUTOMATIC  creates a category + channels, then binds them.
 *   MANUAL     binds to channels the admin already has.
 *
 * Everything is written to `bot_config` under `setup`, so `/setup repair` can
 * reconcile later — channels get deleted, permissions get edited by hand, and a
 * bot that can only set itself up once is a bot you re-invite every few months.
 */

const SETUP_KEY = "setup";

async function readSetup(guildId) {
  return (await getConfigJson(guildId, SETUP_KEY)) || null;
}

async function writeSetup(guildId, data) {
  await setConfigValue(guildId, SETUP_KEY, JSON.stringify(data));
}

/**
 * Checks the two things that make role-granting fail silently in Discord:
 * the Manage Roles permission, and the bot's role sitting above the target role
 * in the hierarchy. Both are reported up front rather than failing on click.
 */
async function checkRoleGranting(guild, roleId) {
  const problems = [];
  if (!roleId) return { ok: true, problems };

  const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!me) return { ok: false, problems: ["Couldn't resolve my own guild member."] };

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    problems.push("I need the **Manage Roles** permission to hand out the Honour Marks role.");
  }

  const target = await guild.roles.fetch(roleId).catch(() => null);
  if (!target) {
    problems.push(`The Honour Marks role (\`${roleId}\`) doesn't exist in this server.`);
  } else if (me.roles.highest.comparePositionTo(target) <= 0) {
    problems.push(
      `My role (**${me.roles.highest.name}**) must be dragged **above** **${target.name}** ` +
      `in Server Settings → Roles, or I can't assign it.`
    );
  }

  return { ok: problems.length === 0, problems };
}

/** Creates the category and every channel, with the full permission matrix. */
async function createStructure(guild, { categoryName = "Honour Marks", ownerId = null } = {}) {
  const ctx = overwriteContext(guild, {}, ownerId);
  const created = {};

  const category = await guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
    permissionOverwrites: buildCategoryOverwrites(ctx),
    reason: "Honour Marks setup",
  });
  created.categoryId = category.id;

  for (const spec of CHANNEL_SPECS) {
    const channel = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildText,
      topic: spec.topic,
      parent: category.id,
      permissionOverwrites: buildOverwrites(ctx, spec.audience),
      reason: "Honour Marks setup",
    });
    created[spec.key] = channel.id;
  }

  return created;
}

/**
 * Re-applies the permission matrix to every bound channel. This is what makes
 * `/setup repair` useful after someone edits overwrites by hand, and what fixes
 * a guild set up before the claim channel existed.
 */
async function applyPermissions(guild, setup, ownerId = null) {
  const ctx = overwriteContext(guild, setup, ownerId);
  const applied = [];
  const missing = [];

  // The category first: children inherit from it.
  if (setup.categoryId) {
    const cat = await guild.channels.fetch(setup.categoryId).catch(() => null);
    if (cat) {
      await cat.permissionOverwrites.set(buildCategoryOverwrites(ctx)).catch(() => {});
      applied.push("category");
    }
  }

  for (const spec of CHANNEL_SPECS) {
    const channelId = setup.channels?.[spec.key];
    if (!channelId) continue;
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch) {
      missing.push(spec.key);
      continue;
    }
    await ch.permissionOverwrites.set(buildOverwrites(ctx, spec.audience)).catch(() => {});
    applied.push(spec.key);
  }

  return { applied, missing };
}

/**
 * Binds a guild to a set of channels. `channels` may be partial — anything
 * missing is treated as "not configured", and panels that need it are skipped
 * rather than crashing.
 */
async function bindGuild(guildId, {
  channels = {},
  mode = "manual",
  categoryId = null,
  staffRoleId = null,
  logUserId = null,
  honouredRoleId = null,
  clanMemberRoleId = null,
}) {
  const data = {
    mode,
    categoryId,
    staffRoleId: staffRoleId || config.roles.staff || null,
    logUserId: logUserId || config.logUserId || null,
    honourMarksRoleId: honouredRoleId || config.roles.honourMarks || null,
    clanMemberRoleId: clanMemberRoleId || config.roles.clanMember || null,
    channels: {
      claim: channels.claim || config.channels.claim || null,
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

/** Ensures a guild has its own copy of the default XP rules. */
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
  readSetup, writeSetup,
  createStructure, applyPermissions, bindGuild,
  verifyBindings, seedDefaults, checkRoleGranting,
};
