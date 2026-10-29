"use strict";
const { PermissionFlagsBits: P } = require("discord.js");
const { config } = require("./config");

/**
 * Channel permission model.
 *
 * The trap this exists to avoid: category overwrites CASCADE to every child
 * channel. A single "Honour Marks role can view the category" would therefore
 * also expose #hm-staff and #hm-log. So the category denies @everyone, and each
 * child re-allows only the roles it specifically needs.
 *
 * Every human role is denied posting on the bot's channels. Members read the
 * quest board, the shop and the database; they never type in them.
 */

// Permissions that let a human write, react, or start a thread.
const NO_WRITE = [
  P.SendMessages,
  P.SendMessagesInThreads,
  P.CreatePublicThreads,
  P.CreatePrivateThreads,
  P.AddReactions,
];

// CreatePoll landed partway through discord.js v14. Filter rather than assume,
// so an older pinned version doesn't crash the whole setup with undefined.
if (typeof P.CreatePoll !== "undefined") NO_WRITE.push(P.CreatePoll);

// What the bot needs to post and later edit its own panels. ManageMessages is
// required to edit messages that have aged past the normal edit window.
const BOT_PERMS = [
  P.ViewChannel,
  P.SendMessages,
  P.EmbedLinks,
  P.ReadMessageHistory,
  P.ManageMessages,
  P.AttachFiles,
];

const CHANNEL_SPECS = [
  {
    key: "claim",
    name: "hm-role",
    topic: "Claim or drop the Honour Marks role to unlock the guide, quest board and shop",
    audience: "clanMember",
  },
  {
    key: "guide",
    name: "hm-guide",
    topic: "Start here — how Honour Marks works, read only",
    audience: "honourMarks",
  },
  {
    key: "quests",
    name: "hm-quests",
    topic: "Quest board — read only",
    audience: "honourMarks",
  },
  {
    key: "shop",
    name: "hm-shop",
    topic: "Spend your Honour Marks — read only",
    audience: "honourMarks",
  },
  {
    key: "database",
    name: "hm-database",
    topic: "Honour Marks totals and quest counts — read only",
    audience: "honourMarks",
  },
  {
    key: "staff",
    name: "hm-staff",
    topic: "Staff only — manual Honour Marks adjustments",
    audience: "staff",
  },
  {
    key: "log",
    name: "hm-log",
    topic: "Honour Marks audit log — owner only",
    audience: "owner",
  },
];

/**
 * Builds the permission overwrites for one channel.
 *
 * @param {object} ctx
 * @param {string} ctx.guildId
 * @param {string} ctx.everyoneId
 * @param {string} ctx.botId
 * @param {string|null} ctx.clanMemberRoleId
 * @param {string|null} ctx.honourMarksRoleId
 * @param {string|null} ctx.staffRoleId
 * @param {string|null} ctx.logUserId        the only human who sees #hm-log
 * @param {string[]}   ctx.manageRoleIds     roles that always retain access
 */
function buildOverwrites(ctx, audience) {
  const rows = [];
  const seen = new Set();

  const add = (id, allow, deny) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const row = { id };
    if (allow?.length) row.allow = allow;
    if (deny?.length) row.deny = deny;
    rows.push(row);
  };

  // 1. @everyone is denied the category outright. Children inherit this unless
  //    they explicitly re-allow, which is exactly what we want.
  add(ctx.everyoneId, [], [P.ViewChannel]);

  // 2. The bot always needs to reach its own channels.
  add(ctx.botId, BOT_PERMS, []);

  // 3. Roles that manage the system keep access everywhere.
  for (const roleId of ctx.manageRoleIds || []) {
    add(roleId, [P.ViewChannel], NO_WRITE);
  }

  // 4. Then the specific audience for this channel.
  switch (audience) {
    case "clanMember":
      // Everyone in the clan can SEE this and nothing else. No writing.
      add(ctx.clanMemberRoleId, [P.ViewChannel], NO_WRITE);
      add(ctx.honourMarksRoleId, [P.ViewChannel], NO_WRITE);
      break;

    case "honourMarks":
      // Only claimed members. Clan Member is explicitly denied, because
      // otherwise the role would inherit access once it's added.
      add(ctx.clanMemberRoleId, [], [P.ViewChannel]);
      add(ctx.honourMarksRoleId, [P.ViewChannel], NO_WRITE);
      break;

    case "staff":
      add(ctx.clanMemberRoleId, [], [P.ViewChannel]);
      add(ctx.honourMarksRoleId, [], [P.ViewChannel]);
      if (ctx.staffRoleId) add(ctx.staffRoleId, [P.ViewChannel], NO_WRITE);
      break;

    case "owner":
      // Strictly the setup runner (or HM_LOG_USER_ID) plus the bot. Staff are
      // denied even though they can see #hm-staff.
      add(ctx.clanMemberRoleId, [], [P.ViewChannel]);
      add(ctx.honourMarksRoleId, [], [P.ViewChannel]);
      if (ctx.staffRoleId) add(ctx.staffRoleId, [], [P.ViewChannel]);
      if (ctx.logUserId) add(ctx.logUserId, [P.ViewChannel], NO_WRITE);
      break;

    default:
      break;
  }

  return rows;
}

/** Category overwrite: hidden from everyone except the bot. */
function buildCategoryOverwrites(ctx) {
  const rows = [{ id: ctx.everyoneId, deny: [P.ViewChannel] }];
  rows.push({ id: ctx.botId, allow: [P.ViewChannel], deny: [] });
  for (const roleId of ctx.manageRoleIds || []) {
    if (roleId) rows.push({ id: roleId, allow: [P.ViewChannel], deny: [] });
  }
  return rows;
}

/** Turns the stored config into the context buildOverwrites needs. */
function overwriteContext(guild, setup = {}, fallbackOwnerId = null) {
  return {
    guildId: guild.id,
    everyoneId: guild.roles.everyone.id,
    botId: guild.members.me?.id || guild.client?.user?.id,
    clanMemberRoleId: setup.clanMemberRoleId || config.roles.clanMember || null,
    honourMarksRoleId: setup.honourMarksRoleId || config.roles.honourMarks || null,
    staffRoleId: setup.staffRoleId || config.roles.staff || null,
    logUserId: config.logUserId || setup.logUserId || fallbackOwnerId || null,
    manageRoleIds: setup.manageRoleIds || config.roles.manage || [],
  };
}

module.exports = {
  NO_WRITE,
  BOT_PERMS,
  CHANNEL_SPECS,
  buildOverwrites,
  buildCategoryOverwrites,
  overwriteContext,
};
