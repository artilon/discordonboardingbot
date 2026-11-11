// One-off maintenance script: force-deletes a single stuck Discord message
// by channel ID + message ID, using the bot's own token/permissions.
//
// Why this exists: occasionally a message a user uploaded (e.g. a clan
// roster file in the Rank List channel) doesn't get cleaned up by the bot's
// normal auto-delete step, and even Owner/Leader accounts can't remove it
// themselves from the channel's permission setup. The bot's own role can
// always manage its channels, so this script does the deletion directly
// through the same bot identity instead of relying on the live process to
// notice and clean it up.
//
// Usage (run from the project root, on the same host/env as the live bot):
//   node scripts/delete-stuck-message.js <channelId> <messageId>
//
// Example (the Rank List channel message reported stuck on 2026-10-18):
//   node scripts/delete-stuck-message.js 1561482413341679757 1569869006473658490
require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

const [, , channelId, messageId] = process.argv;

if (!channelId || !messageId) {
  console.error("Usage: node scripts/delete-stuck-message.js <channelId> <messageId>");
  process.exit(1);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is not set in the environment (.env). Run this from the same host/folder as the live bot.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}. Looking up channel ${channelId}...`);
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased?.()) {
      console.error(`Channel ${channelId} was not found, or isn't a text channel the bot can see.`);
      process.exit(1);
    }

    console.log(`Found #${channel.name || channelId}. Fetching message ${messageId}...`);
    const message = await channel.messages.fetch(messageId).catch((e) => {
      console.log(`Could not fetch the message (${e.message}). This usually means it's ALREADY gone server-side — ` +
        "just a stale/cached copy on your Discord client. Try a full reload of Discord (Ctrl+R on desktop/web, or fully close & reopen the mobile app) and it should disappear.");
      return null;
    });

    if (!message) {
      process.exit(0);
    }

    console.log(`Found the message (author: ${message.author?.tag || "unknown"}, posted ${message.createdAt.toISOString()}). Deleting...`);
    await message.delete();
    console.log("Deleted successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
  }
});

client.login(BOT_TOKEN).catch((err) => {
  console.error("Could not log in with BOT_TOKEN:", err.message);
  process.exit(1);
});
