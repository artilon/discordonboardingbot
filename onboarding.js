// ================= FENRIR — ONBOARDING-ONLY BOT =================
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
// No database. No slash commands. State lives entirely in Discord (messages + custom IDs).

require("dotenv").config();
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

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;

const UNVERIFIED_ROLE_ID    = "1547278787815804928";
const CLAN_MEMBER_ROLE_ID   = "1546403975656505354";
const OSRS_ROLE_ID          = "1546412132822810744";
const ONBOARDING_CHANNEL_ID = "1546401367004811314";

// OSRS display names: max 12 characters (OSRS wiki, Account Management > Display name).
const RSN_MAX_LENGTH = 12;
const RSN_PATTERN    = /^[A-Za-z0-9 _-]+$/;

// How many recent channel messages to scan when looking for old messages.
const SCAN_PAGES_PERMANENT = 5; // 500 messages — finding the permanent embed
const SCAN_PAGES_PINGS     = 2; // 200 messages — finding a member's ping

// When Discord reports onboarding as completed, wait briefly and re-fetch the member so
// roles assigned by the onboarding have landed before deciding ping vs. no ping.
const config = { settleMs: 3000 };

// Component custom IDs
const ID = {
  START:    "nick_start",
  MODAL:    "nick_modal",
  INPUT:    "nick_input",
  CONFIRM1: "nick_c1",
  CONFIRM2: "nick_c2",
  CANCEL:   "nick_cancel",
};

const COLOR = { main: 0x2b6cb0, warn: 0xd69e2e, ok: 0x38a169, bad: 0xe53e3e };

// ================= CLIENT =================
const client = new Client({
  // GuildMembers is a privileged intent — it must be enabled in the Developer Portal
  // (Bot tab -> Privileged Gateway Intents -> Server Members Intent).
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

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

const encodeName = (name) => Buffer.from(name, "utf8").toString("base64url");
const decodeName = (b64) => Buffer.from(String(b64 ?? ""), "base64url").toString("utf8");

function messageHasStartButton(message) {
  return (message.components || []).some((row) =>
    (row.components || []).some((c) => c.customId === ID.START)
  );
}

function isPingFor(message, userId) {
  return (
    message.author?.id === client.user?.id &&
    typeof message.content === "string" &&
    message.content.includes(`<@${userId}>`) &&
    !messageHasStartButton(message)
  );
}

async function getOnboardingChannel() {
  const channel = await client.channels.fetch(ONBOARDING_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.error(`[Onboarding] Channel ${ONBOARDING_CHANNEL_ID} not found or not text-based.`);
    return null;
  }
  return channel;
}

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

// ================= PERMANENT EMBED =================
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

// Makes sure exactly one permanent embed exists. Stateless: finds it by its button.
async function ensurePermanentMessage() {
  const channel = await getOnboardingChannel();
  if (!channel) return;

  const recent = await fetchRecentMessages(channel, SCAN_PAGES_PERMANENT);
  const existing = recent.filter((m) => m.author?.id === client.user.id && messageHasStartButton(m));
  const payload = buildPermanentMessage();

  if (existing.length === 0) {
    await channel.send(payload);
    console.log("[Onboarding] Posted permanent nickname embed.");
    return;
  }

  // Keep the newest, refresh its content, remove any accidental duplicates.
  const [keep, ...dupes] = existing;
  await keep.edit(payload).catch((e) => console.warn("[Onboarding] Could not refresh permanent embed:", e.message));
  for (const d of dupes) {
    await d.delete().catch(() => {});
  }
  console.log(`[Onboarding] Permanent embed present${dupes.length ? ` (removed ${dupes.length} duplicate(s))` : ""}.`);
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

async function handleInteraction(interaction) {
  if (!interaction.inGuild()) return;

  if (interaction.isButton()) {
    const [base, payload] = interaction.customId.split(":");
    switch (base) {
      case ID.START:    return onStartButton(interaction);
      case ID.CONFIRM1: return onConfirm1(interaction, payload);
      case ID.CONFIRM2: return onConfirm2(interaction, payload);
      case ID.CANCEL:   return onCancel(interaction);
      default:          return;
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === ID.MODAL) {
    return onModalSubmit(interaction);
  }
}

// ================= WIRING =================
client.once(Events.ClientReady, async () => {
  console.log(`[Fenrir] Logged in as ${client.user.tag}`);
  try {
    await ensurePermanentMessage();
  } catch (err) {
    console.error("[Onboarding] ensurePermanentMessage failed:", err.message);
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
    console.error("[Fenrir] BOT_TOKEN is not set.");
    process.exit(1);
  }
  client.login(BOT_TOKEN).catch((err) => {
    console.error("[Fenrir] Login failed:", err.message);
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
  deletePingsFor,
  ID,
  UNVERIFIED_ROLE_ID,
  CLAN_MEMBER_ROLE_ID,
  OSRS_ROLE_ID,
  ONBOARDING_CHANNEL_ID,
};
