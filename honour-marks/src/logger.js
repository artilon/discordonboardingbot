"use strict";
/**
 * #hm-log audit logging. Every quest/bounty lifecycle event and every
 * HM / Rank XP award is posted to the guild's log channel as an embed.
 *
 * Fire-and-forget by design: logging must never break the flow that
 * triggered it, so logEvent never throws — failures only hit the
 * console. Without initLogger (e.g. in tests) it is a no-op.
 */
const { EmbedBuilder } = require("discord.js");
const { config } = require("./config");
const { readSetup } = require("./setup");

let client = null;

function initLogger(discordClient) {
  client = discordClient;
}

async function getLogChannel(guildId) {
  if (!client || !guildId) return null;
  const setup = await readSetup(guildId).catch(() => null);
  const channelId = setup?.channels?.log || config.channels.log;
  if (!channelId) return null;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  return guild ? guild.channels.fetch(channelId).catch(() => null) : null;
}

/**
 * Post one log embed to the guild's #hm-log channel. `fields` is an
 * array of { name, value, inline? }. Never throws.
 */
async function logEvent(guildId, { title, color = 0x5865f2, description = null, fields = [] }) {
  try {
    const channel = await getLogChannel(guildId);
    if (!channel) return;
    const embed = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp();
    if (description) embed.setDescription(description);
    if (fields.length) embed.addFields(fields);
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error("[Log]", e.message);
  }
}

module.exports = { initLogger, logEvent };
