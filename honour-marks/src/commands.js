"use strict";
const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

/**
 * Slash command definitions, kept in their own module so they can be validated
 * by a test without booting a Discord client.
 *
 * Discord rejects the ENTIRE registration payload if a single command is
 * malformed, which removes every command from the server while the bot still
 * appears online. `test/commands.test.js` asserts the ordering rules so that
 * can't ship again.
 *
 * Rule: within any one option list, required options must come before
 * optional ones.
 */
const raw = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set up Honour Marks (staff)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s.setName("auto").setDescription("Create the Honour Marks category and channels automatically")
    )
    .addSubcommand((s) =>
      s
        .setName("manual")
        .setDescription("Bind Honour Marks to channels you already have")
        // Required options MUST come before optional ones. Discord rejects the
        // entire command payload otherwise, which silently removes EVERY
        // command from the server — not just this subcommand.
        .addChannelOption((o) => o.setName("quests").setDescription("Quest board channel").setRequired(true))
        .addChannelOption((o) => o.setName("database").setDescription("Database channel").setRequired(true))
        .addChannelOption((o) => o.setName("shop").setDescription("Shop channel").setRequired(true))
        .addChannelOption((o) => o.setName("claim").setDescription("Channel with the Claim / Drop Role buttons"))
        .addChannelOption((o) => o.setName("guide").setDescription("Channel for the how-it-works guide (optional)"))
        .addChannelOption((o) => o.setName("staff").setDescription("Staff channel (optional)"))
        .addChannelOption((o) => o.setName("log").setDescription("Audit log channel (optional)"))
        .addRoleOption((o) => o.setName("staff_role").setDescription("Role allowed to adjust HM"))
    )
    .addSubcommand((s) => s.setName("repair").setDescription("Reconcile channels and repost any missing panels"))
    .addSubcommand((s) => s.setName("status").setDescription("Show the current Honour Marks setup")),

  new SlashCommandBuilder()
    .setName("register")
    .setDescription("Link your RuneScape name to your Discord account")
    .addStringOption((o) =>
      o.setName("rsn").setDescription("Your exact in-game name").setRequired(true)
    )
    .addUserOption((o) =>
      o.setName("member").setDescription("Register someone else (staff only)").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("hm")
    .setDescription("Honour Marks admin")
    .addSubcommand((s) =>
      s
        .setName("give")
        .setDescription("Award HM to a member (staff)")
        .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
        .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false))
    )
    .addSubcommand((s) =>
      s
        .setName("take")
        .setDescription("Remove HM from a member (staff)")
        .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
        .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false))
    )
    .addSubcommand((s) =>
      s
        .setName("balance")
        .setDescription("Show a member's HM")
        .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(false))
    )
    .addSubcommand((s) =>
      s.setName("refresh").setDescription("Force-refresh all Honour Marks panels")
    ),
];

module.exports = { commands: raw.map((c) => c.toJSON()) };
