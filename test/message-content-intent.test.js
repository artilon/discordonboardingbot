// Regression coverage for: the bot silently ignoring roster .csv/.txt file
// uploads (and, less visibly, Recruitment Drive screenshot uploads) dropped
// in a channel without an @-mention.
//
// Root cause: Discord strips `message.content`, `message.attachments`, and
// related fields from any guild message that doesn't @-mention the bot and
// isn't a DM, UNLESS the bot's Gateway connection declares the privileged
// `MESSAGE_CONTENT` intent. The client was missing that intent, so
// `handleMessageCreate`'s `message.attachments.first()` (roster upload) and
// `handleRecruitmentDriveMessage`'s `message.attachments?.first()`
// (Recruitment Drive screenshots) both saw an empty attachments collection
// and bailed out with no visible error — looking exactly like "the bot does
// nothing."
//
// This test locks in that the client's Gateway intents include
// MessageContent so this class of bug can't silently regress.
const assert = require("assert");
const path = require("path");
const { GatewayIntentBits } = require("discord.js");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

const intents = bot.client.options.intents;

check(
  "client declares the GuildMessages intent (needed to receive messageCreate at all)",
  intents.has(GatewayIntentBits.GuildMessages)
);

check(
  "client declares the privileged MessageContent intent (needed to actually see " +
    "attachments/content on guild messages that don't @-mention the bot)",
  intents.has(GatewayIntentBits.MessageContent)
);

check(
  "client still declares GuildMembers (needed for role checks / nickname matching)",
  intents.has(GatewayIntentBits.GuildMembers)
);

check(
  "client still declares DirectMessages (needed for DM roster uploads)",
  intents.has(GatewayIntentBits.DirectMessages)
);

console.log(`\n[message-content-intent] ${passed} checks passed.`);
