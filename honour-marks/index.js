"use strict";
/**
 * ODINHEIM — HONOUR MARKS
 * Quests, shop, and the HM database channel.
 *
 * Shares a Supabase project with Heimdall. This bot owns HM; Heimdall owns the
 * rank ladder. Rank XP leaves here only as inserts into `pending_rank_xp`.
 */

const {
  Client, GatewayIntentBits, Events, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, UserSelectMenuBuilder,
  MessageFlags, PermissionFlagsBits,
} = require("discord.js");

const { config, assertConfig } = require("./src/config");
const { getSupabase } = require("./src/db");
const { getRankForXp, formatRankProgress } = require("./src/ranks");
const {
  TREES, TREE_BY_KEY, QUEST_TREES,
  getMember, getMemberByRsn, getCounts,
  getActiveSoloQuests, getActivePartyQuestForUser,
  createSoloQuest, cancelSoloQuest, createPartyQuest, creditHm,
  diffProgress, fetchHiscores, cleanRsn, soloHmReward, partyHmReward,
  soloTargetPool,
} = require("./src/quests");
const { SKILL_LABELS, bossLabel } = require("./src/jagex");
const { checkSoloQuests, checkPartyQuest, completePartyQuest, sweepExpiredQuests } = require("./src/progress");
const {
  PERK_TIERS, BOOST_TIERS, CONSUMABLES, perkBonusPercent, boostBonusLabel,
  getBalance, getPerks, getPerkTier, getInventory, getActiveBoosts,
  buyPerk, buyBoost, buyConsumable, grantConsumable, consumeItem, activateBoost,
} = require("./src/shop");
const {
  COLOR, HM_EMOJI,
  renderClaimPanel, renderGuide,
  renderDatabase, renderQuestBoard, renderShop, syncPanel, emptyPage,
} = require("./src/panels");
const {
  readSetup, bindGuild, createStructure, verifyBindings, seedDefaults,
  applyPermissions, checkRoleGranting,
} = require("./src/setup");

assertConfig();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ── Commands ─────────────────────────────────────────────────────────────────
const { commands } = require("./src/commands");
const { syncCommands } = require("./src/register");

// ── Helpers ──────────────────────────────────────────────────────────────────
async function isStaff(interaction) {
  const setup = await readSetup(interaction.guildId);
  if (!setup?.staffRoleId) {
    // No staff role configured — fall back to Discord permissions so a fresh
    // install isn't unusable before /setup finishes.
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  }
  return interaction.member?.roles?.cache?.has(setup.staffRoleId) || false;
}

function formatPart(part) {
  if (part.kind === "skill") {
    return `${part.label}: \`${part.gained.toLocaleString()} / ${part.needed.toLocaleString()}\` XP`;
  }
  return `${part.label}: \`${part.gained.toLocaleString()} / ${part.needed.toLocaleString()}\` KC`;
}

function questProgressEmbed(quest, progress) {
  const isSkill = Object.keys(quest.targets?.skills || {}).length > 0;
  const lines = progress.parts.map((p) => `• ${formatPart(p)} — **${Math.floor(p.pct)}%**`);

  return new EmbedBuilder()
    .setColor(progress.totalPct >= 100 ? COLOR.ok : COLOR.main)
    .setTitle(`${quest.quest_type.toUpperCase()} • ${quest.tree}`)
    .setDescription(
      `**Progress: ${progress.totalPct}%**\n\n${lines.join("\n")}\n\n` +
      `Ends <t:${Math.floor(new Date(quest.expires_at).getTime() / 1000)}:R>`
    )
    .setFooter({ text: isSkill ? "Skill XP gained since the quest started" : "Kills gained since the quest started" });
}

// ── Panel refresh ────────────────────────────────────────────────────────────
let refreshTimer = null;
const pendingRefresh = new Set();

/** Coalesced refresh: many mutations in a burst become one render pass. */
function scheduleRefresh(guildId) {
  pendingRefresh.add(guildId);
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    const guilds = [...pendingRefresh];
    pendingRefresh.clear();
    refreshTimer = null;
    for (const id of guilds) {
      try {
        await refreshPanels(id);
      } catch (e) {
        console.error("[Panels] refresh failed:", e.message);
      }
    }
  }, config.panelRefreshDebounceMs);
}

async function refreshPanels(guildId) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const setup = await readSetup(guildId);
  if (!setup) return;

  const guideCh = setup.channels.guide
    ? await guild.channels.fetch(setup.channels.guide).catch(() => null)
    : null;
  const questsCh = setup.channels.quests
    ? await guild.channels.fetch(setup.channels.quests).catch(() => null)
    : null;
  const shopCh = setup.channels.shop
    ? await guild.channels.fetch(setup.channels.shop).catch(() => null)
    : null;
  const dbCh = setup.channels.database
    ? await guild.channels.fetch(setup.channels.database).catch(() => null)
    : null;
  const claimCh = setup.channels.claim
    ? await guild.channels.fetch(setup.channels.claim).catch(() => null)
    : null;

  if (claimCh) {
    await syncPanel(guildId, claimCh, "claim", renderClaimPanel(setup));
  }
  // Guide, quest board and shop are three separate channels now — each one
  // only has its own single panel, so there's no posting order to worry about.
  if (guideCh) {
    await syncPanel(guildId, guideCh, "guide", renderGuide(setup));
  }
  if (questsCh) {
    await syncPanel(guildId, questsCh, "quest_board", await renderQuestBoard(guildId, setup));
  }
  if (shopCh) {
    await syncPanel(guildId, shopCh, "shop", await renderShop(guildId));
  }
  if (dbCh) {
    await syncPanel(guildId, dbCh, "database", await renderDatabase(guildId));
  }
}

// ── Interaction: slash commands ──────────────────────────────────────────────
async function handleSetup(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;

  if (sub === "auto") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.editReply({
        content: "I need the **Manage Channels** permission to create the Honour Marks category.",
      });
    }

    try {
      // The setup runner is the only human who sees #hm-log.
      const ownerId = interaction.user.id;
      const created = await createStructure(guild, { ownerId });
      const setup = await bindGuild(guild.id, {
        mode: "auto",
        categoryId: created.categoryId,
        logUserId: ownerId,
        channels: {
          claim: created.claim,
          guide: created.guide,
          quests: created.quests,
          shop: created.shop,
          database: created.database,
          staff: created.staff,
          log: created.log,
        },
      });
      await seedDefaults(guild.id);
      await refreshPanels(guild.id);

      const roleCheck = await checkRoleGranting(guild, setup.honourMarksRoleId);
      const warn = roleCheck.ok
        ? ""
        : `\n\n⚠️ **Role assignment needs attention:**\n${roleCheck.problems.map((p) => `• ${p}`).join("\n")}`;

      return interaction.editReply({
        content:
          `✅ **Honour Marks is set up.**\n\n` +
          `• <#${setup.channels.claim}> — claim or drop the Honour Marks role\n` +
          `• <#${setup.channels.guide}> — how everything works\n` +
          `• <#${setup.channels.quests}> — quest board\n` +
          `• <#${setup.channels.shop}> — shop\n` +
          `• <#${setup.channels.database}> — member database\n` +
          `• <#${setup.channels.staff}> — staff channel\n` +
          `• <#${setup.channels.log}> — audit log (only you can see this)\n\n` +
          `Members can now run \`/register\` to link their RuneScape name.${warn}`,
      });
    } catch (e) {
      console.error("[Setup] auto failed:", e);
      return interaction.editReply({
        content: `Setup failed: \`${e.message}\`\n\nCheck that I have **Manage Channels**.`,
      });
    }
  }

  if (sub === "manual") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const claim = interaction.options.getChannel("claim");
    const guide = interaction.options.getChannel("guide");
    const quests = interaction.options.getChannel("quests");
    const shop = interaction.options.getChannel("shop");
    const database = interaction.options.getChannel("database");
    const staff = interaction.options.getChannel("staff");
    const log = interaction.options.getChannel("log");
    const staffRole = interaction.options.getRole("staff_role");

    const setup = await bindGuild(guild.id, {
      mode: "manual",
      staffRoleId: staffRole?.id || null,
      logUserId: interaction.user.id,
      channels: {
        claim: claim?.id || null,
        guide: guide?.id || null,
        quests: quests.id,
        shop: shop.id,
        database: database.id,
        staff: staff?.id || null,
        log: log?.id || null,
      },
    });
    await seedDefaults(guild.id);
    await applyPermissions(guild, setup, interaction.user.id);
    await refreshPanels(guild.id);

    return interaction.editReply({
      content:
        `✅ **Honour Marks bound to your channels.**\n\n` +
        (setup.channels.claim ? `• Claim / Drop role → <#${setup.channels.claim}>\n` : "• _No claim channel set — add one with `/setup manual claim:#channel`_\n") +
        (setup.channels.guide ? `• Guide → <#${setup.channels.guide}>\n` : "• _No guide channel set — add one with `/setup manual guide:#channel`_\n") +
        `• Quests → <#${setup.channels.quests}>\n` +
        `• Shop → <#${setup.channels.shop}>\n` +
        `• Database → <#${setup.channels.database}>\n` +
        (setup.channels.staff ? `• Staff → <#${setup.channels.staff}>\n` : "") +
        (setup.channels.log ? `• Log → <#${setup.channels.log}> (only you)\n` : "") +
        `\n⚠️ I replaced the permission overwrites on those channels with the Honour Marks matrix. ` +
        `If they had custom overwrites, re-add them or run \`/setup auto\` to use dedicated channels instead.`,
    });
  }

  if (sub === "repair") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const setup = await readSetup(guild.id);
    if (!setup) return interaction.editReply({ content: "Nothing to repair — run `/setup auto` first." });

    const check = await verifyBindings(guild, setup);
    const perms = await applyPermissions(guild, setup, setup.logUserId || interaction.user.id);
    await refreshPanels(guild.id);

    const lines = [];
    lines.push(`Permissions re-applied to: ${perms.applied.length ? perms.applied.join(", ") : "nothing"}`);
    if (perms.missing.length) lines.push(`⚠️ Missing channels: ${perms.missing.join(", ")}`);
    if (!setup.channels.claim) {
      lines.push("⚠️ No claim channel bound — run `/setup manual claim:#channel` to add one.");
    }
    if (!check.ok) lines.push(...check.problems.map((p) => `⚠️ ${p}`));

    return interaction.editReply({
      content:
        `✅ **Repair complete.** Panels reconciled and permissions re-applied.\n\n` +
        lines.join("\n"),
    });
  }

  if (sub === "status") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const setup = await readSetup(guild.id);
    if (!setup) return interaction.editReply({ content: "Honour Marks is not set up yet. Run `/setup auto`." });

    const check = await verifyBindings(guild, setup);
    const lines = Object.entries(setup.channels)
      .filter(([, id]) => id)
      .map(([k, id]) => `• **${k}** → <#${id}>`);
    if (setup.honourMarksRoleId) lines.push(`• **Honour Marks role** → <@&${setup.honourMarksRoleId}>`);
    if (setup.clanMemberRoleId) lines.push(`• **Clan Member role** → <@&${setup.clanMemberRoleId}>`);
    if (setup.logUserId) lines.push(`• **Log visible to** → <@${setup.logUserId}>`);

    const roleCheck = await checkRoleGranting(guild, setup.honourMarksRoleId);
    if (!roleCheck.ok) lines.push("", ...roleCheck.problems.map((p) => `⚠️ ${p}`));
    lines.push("", check.ok ? "✅ All channels reachable." : `⚠️ ${check.problems.join(" ")}`);

    return interaction.editReply({
      content: `**Honour Marks setup** (${setup.mode})\n\n${lines.join("\n")}`,
    });
  }
}

async function handleRegister(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser("member") || interaction.user;
  const rsn = cleanRsn(interaction.options.getString("rsn", true));

  if (target.id !== interaction.user.id && !(await isStaff(interaction))) {
    return interaction.editReply({ content: "Only staff can register another member." });
  }
  if (rsn.length < 1 || rsn.length > 12) {
    return interaction.editReply({ content: "That doesn't look like a RuneScape name (1–12 characters)." });
  }

  const existingName = await getMemberByRsn(interaction.guildId, rsn);
  if (existingName && existingName.user_id !== target.id) {
    return interaction.editReply({ content: `**${rsn}** is already registered to <@${existingName.user_id}>.` });
  }

  // Verify the name resolves before accepting it, so nobody ends up with a
  // dead registration they can't quest with.
  await interaction.editReply({ content: `Checking **${rsn}** on the hiscores…` });
  const snap = await fetchHiscores(rsn);
  if (!snap) {
    return interaction.editReply({
      content:
        `Couldn't find **${rsn}** on the OSRS hiscores.\n\n` +
        `• Check the spelling and capitalisation\n` +
        `• Make sure your profile isn't private\n` +
        `• New accounts don't appear until they have some XP`,
    });
  }

  const supabase = getSupabase();
  const { error } = await supabase.from("hm_members").upsert(
    {
      user_id: target.id,
      guild_id: interaction.guildId,
      rsn,
      display_name: target.username,
      active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) return interaction.editReply({ content: `Couldn't save that: \`${error.message}\`` });

  await supabase.from("hm_balances").upsert(
    { user_id: target.id, guild_id: interaction.guildId },
    { onConflict: "user_id" }
  );

  scheduleRefresh(interaction.guildId);

  return interaction.editReply({
    content:
      `✅ Linked **${rsn}** to ${target.id === interaction.user.id ? "your account" : `<@${target.id}>`}.\n\n` +
      `Open the quest board and press **Start a Solo Quest** to earn your first Honour Marks.`,
  });
}

async function handleHm(interaction) {
  const sub = interaction.options.getSubcommand();
  const target = interaction.options.getUser("member");

  if (sub === "balance") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = target || interaction.user;
    const member = await getMember(user.id);
    const bal = await getBalance(user.id);
    const perks = await getPerks(user.id);
    const boosts = await getActiveBoosts(user.id);

    if (!member?.rsn) {
      return interaction.editReply({ content: `<@${user.id}> hasn't registered yet.` });
    }

    const perkLines = perks.length
      ? perks.map((p) => `• ${TREE_BY_KEY[p.tree]?.emoji || ""} ${TREE_BY_KEY[p.tree]?.label || p.tree} — T${p.tier} (+${perkBonusPercent(p.tier)}%)`).join("\n")
      : "_None yet_";
    const boostLines = boosts.length
      ? boosts.map((b) => `• ${TREE_BY_KEY[b.tree]?.label || b.tree} — ${boostBonusLabel(b.multiplier)} quest-completion XP, ends <t:${Math.floor(new Date(b.expires_at).getTime() / 1000)}:R>`).join("\n")
      : "_None active_";

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.main)
          .setTitle(`${HM_EMOJI} ${member.rsn}`)
          .addFields(
            { name: "Held", value: `\`${bal.balance.toLocaleString()}\``, inline: true },
            { name: "Earned total", value: `\`${bal.total_earned.toLocaleString()}\``, inline: true },
            { name: "Spent total", value: `\`${bal.total_spent.toLocaleString()}\``, inline: true },
            { name: "Perks", value: perkLines },
            { name: "Active Boosts", value: boostLines }
          ),
      ],
    });
  }

  if (!(await isStaff(interaction))) {
    return interaction.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
  }

  if (sub === "give" || sub === "take") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const amount = interaction.options.getInteger("amount", true);
    const reason = interaction.options.getString("reason") || "Staff adjustment";
    const member = await getMember(target.id);

    if (!member?.rsn) {
      return interaction.editReply({ content: `<@${target.id}> hasn't registered a RuneScape name.` });
    }

    const supabase = getSupabase();
    if (sub === "give") {
      await creditHm({ guildId: interaction.guildId, userId: target.id, amount, kind: "staff_grant", reason });
    } else {
      const bal = await getBalance(target.id);
      const next = Math.max(0, bal.balance - amount);
      await supabase.from("hm_balances").update({
        balance: next,
        total_spent: bal.total_spent + Math.min(amount, bal.balance),
        updated_at: new Date().toISOString(),
      }).eq("user_id", target.id);
      await supabase.from("hm_transactions").insert({
        guild_id: interaction.guildId,
        user_id: target.id,
        delta: -Math.min(amount, bal.balance),
        balance_after: next,
        kind: "staff_remove",
        reason,
      });
    }

    await supabase.from("hm_audit_log").insert({
      guild_id: interaction.guildId,
      kind: sub === "give" ? "staff_grant" : "staff_remove",
      actor_id: interaction.user.id,
      subject_id: target.id,
      amount: sub === "give" ? amount : -amount,
      detail: { reason },
    });

    scheduleRefresh(interaction.guildId);
    return interaction.editReply({
      content: `${sub === "give" ? "Awarded" : "Removed"} \`${amount.toLocaleString()}\` ${HM_EMOJI} ${sub === "give" ? "to" : "from"} <@${target.id}>.`,
    });
  }

  if (sub === "refresh") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await refreshPanels(interaction.guildId);
    return interaction.editReply({ content: "Panels refreshed." });
  }
}

// ── Interaction: buttons and menus ───────────────────────────────────────────
async function handleQuestStart(interaction) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("hm_pick_type")
    .setPlaceholder("Select quest type…")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Daily").setValue("daily").setDescription("Short target, resets daily"),
      new StringSelectMenuOptionBuilder().setLabel("Weekly").setValue("weekly").setDescription("Bigger target, resets weekly"),
      new StringSelectMenuOptionBuilder().setLabel("Monthly").setValue("monthly").setDescription("Largest target, resets monthly")
    );

  return interaction.reply({
    embeds: [emptyPage("📋 Start a Solo Quest", "Pick a quest type. You can hold one Daily, one Weekly, and one Monthly at the same time.").embed],
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePickTree(interaction, questType) {
  const member = await getMember(interaction.user.id);
  if (!member?.rsn) {
    return interaction.update({
      embeds: [emptyPage("Not registered", "Run `/register` first so I know which RuneScape account to track.").embed],
      components: [],
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hm_pick_tree:${questType}`)
    .setPlaceholder("Select a category…")
    .addOptions(
      TREES.map((t) =>
        new StringSelectMenuOptionBuilder().setLabel(t.label).setValue(t.key).setEmoji(t.emoji)
      )
    );

  return interaction.update({
    embeds: [emptyPage("📋 Pick a Category", `Your **${questType}** quest will target something in this category.`).embed],
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

/** Pretty label for a solo-quest target pool entry (skill or boss key). */
function targetLabel(kind, key) {
  if (kind === "skill") return SKILL_LABELS[key] || key;
  return bossLabel(key);
}

/**
 * After a category is picked, a member who owns a Quest Choice Token gets
 * offered the chance to spend it hand-picking the exact target instead of
 * letting the bot roll one at random. Nothing changes for anyone who doesn't
 * own one — they go straight to a random quest, same as before.
 */
async function handleTreeChosen(interaction, questType, tree) {
  const inv = await getInventory(interaction.user.id);
  const hasChoiceToken = inv.some((i) => i.tree === "quest_choice_token" && i.boost_tier === 0 && i.quantity > 0);

  if (!hasChoiceToken) {
    return handleCreateSolo(interaction, questType, tree);
  }

  return interaction.update({
    embeds: [
      emptyPage(
        "🎯 You own a Quest Choice Token",
        "Spend it to hand-pick this quest's exact target, or skip it and let the bot roll one at random — " +
        "the token stays in your inventory either way if you skip it."
      ).embed,
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`hm_quest_choose:${questType}:${tree}`).setLabel("🎯 Hand-pick (uses token)").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`hm_quest_random:${questType}:${tree}`).setLabel("🎲 Random (keep token)").setStyle(ButtonStyle.Secondary)
      ),
    ],
  });
}

/** Shows the pool for this category so the member can pick their own target(s). */
async function handleQuestChoose(interaction, questType, tree) {
  const spec = soloTargetPool(tree, questType);
  if (!spec || !spec.pool.length) {
    return handleCreateSolo(interaction, questType, tree);
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hm_pick_target:${questType}:${tree}`)
    .setPlaceholder(`Pick ${spec.count === 1 ? "your target" : `${spec.count} targets`}…`)
    .setMinValues(spec.count)
    .setMaxValues(spec.count)
    .addOptions(
      spec.pool.slice(0, 25).map((key) =>
        new StringSelectMenuOptionBuilder().setLabel(targetLabel(spec.kind, key)).setValue(key)
      )
    );

  return interaction.update({
    embeds: [
      emptyPage(
        "🎯 Pick Your Target",
        spec.pool.length > 25
          ? `Showing the first 25 of ${spec.pool.length} options.`
          : `Select exactly ${spec.count}.`
      ).embed,
    ],
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function handlePickTarget(interaction, questType, tree, picks) {
  await interaction.deferUpdate();
  const used = await consumeItem(interaction.user.id, "quest_choice_token");
  // If the token is somehow already gone (e.g. spent in another tab a moment
  // ago), fall back to a random target rather than leaving the member with
  // nothing — the picks they made simply don't get honoured without payment.
  return handleCreateSolo(interaction, questType, tree, used ? picks : null);
}

async function handleCreateSolo(interaction, questType, tree, picks = null) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const member = await getMember(interaction.user.id);
  const result = await createSoloQuest({
    guildId: interaction.guildId,
    member,
    tree,
    questType,
    picks,
  });

  if (result.error) {
    return interaction.editReply({ embeds: [emptyPage("Couldn't start that quest", result.error).embed], components: [] });
  }

  const quests = await getActiveSoloQuests(interaction.user.id);
  const quest = quests.find((q) => q.quest_type === questType);
  const snap = await fetchHiscores(member.rsn);
  const progress = diffProgress(quest?.baseline, snap, quest?.targets || {});

  scheduleRefresh(interaction.guildId);
  return interaction.editReply({
    embeds: [questProgressEmbed(quest, progress)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("hm_check").setLabel("✅ Check Progress").setStyle(ButtonStyle.Success)
      ),
    ],
  });
}

async function handleCheck(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await getMember(interaction.user.id);
  if (!member?.rsn) {
    return interaction.editReply({ content: "Run `/register` first." });
  }

  const result = await checkSoloQuests({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    memberRsn: member.rsn,
  });

  if (result.error) return interaction.editReply({ content: result.error });

  const active = await getActiveSoloQuests(interaction.user.id);
  const team = await getActivePartyQuestForUser(interaction.user.id);

  const embeds = [];

  for (const r of result.results) {
    embeds.push(questProgressEmbed(r.quest, r.progress));
  }

  if (team) {
    const evaluated = await checkPartyQuest(team);
    if (evaluated?.progress) {
      embeds.push(
        new EmbedBuilder()
          .setColor(evaluated.finished ? COLOR.ok : COLOR.main)
          .setTitle(`👥 TEAM • ${team.size} • ${team.tree}`)
          .setDescription(
            `**Team progress: ${evaluated.progress.totalPct}%**\n\n` +
            evaluated.progress.parts.map((p) => `• ${formatPart(p)} — **${Math.floor(p.pct)}%**`).join("\n")
          )
      );
      if (evaluated.finished) {
        await completePartyQuest(team, evaluated.progress);
        scheduleRefresh(interaction.guildId);
      }
    }
  }

  if (!embeds.length) {
    embeds.push(
      emptyPage(
        "No active quests",
        "You don't have any quests in progress. Press **Start a Solo Quest** on the quest board."
      ).embed
    );
  }

  const summary = [];
  if (result.completed > 0) {
    summary.push(
      `✅ **${result.completed} quest${result.completed === 1 ? "" : "s"} completed** — ` +
      `+\`${result.awardedHm.toLocaleString()}\` ${HM_EMOJI} and +\`${result.awardedXp.toLocaleString()}\` Rank XP.`
    );
  }
  if (team && !embeds.find((e) => e.data.title?.includes("Team"))) {
    summary.push("Team quest progress shown above.");
  }

  if (summary.length) {
    embeds.unshift(
      new EmbedBuilder().setColor(COLOR.ok).setDescription(summary.join("\n"))
    );
  }

  if (result.completed > 0) scheduleRefresh(interaction.guildId);

  return interaction.editReply({ embeds: embeds.slice(0, 10) });
}

async function handleTeamStart(interaction) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("hm_pick_size")
    .setPlaceholder("Select team size…")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Duo (2)").setValue("duo"),
      new StringSelectMenuOptionBuilder().setLabel("Trio (3)").setValue("trio"),
      new StringSelectMenuOptionBuilder().setLabel("Quad (4)").setValue("quad")
    );

  return interaction.reply({
    embeds: [emptyPage("👥 Start a Team Quest", "Team progress combines from everyone toward one shared target. Everyone gets the full reward.").embed],
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

const PARTY_SIZES = { duo: 2, trio: 3, quad: 4 };

async function handlePickSize(interaction, size) {
  if (!PARTY_SIZES[size]) {
    return interaction.update({ embeds: [emptyPage("Unknown size", "Try again.").embed], components: [] });
  }
  return interaction.update({
    embeds: [
      emptyPage(
        "👥 Pick a Category",
        `Your **${size}** quest targets something in this category. Everyone on the team works toward one shared total.`
      ).embed,
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`hm_pick_team_tree:${size}`)
          .setPlaceholder("Select a category…")
          .addOptions(TREES.map((t) => new StringSelectMenuOptionBuilder().setLabel(t.label).setValue(t.key).setEmoji(t.emoji)))
      ),
    ],
  });
}

async function handlePickTeamMembers(interaction, size, tree) {
  const needed = PARTY_SIZES[size] - 1; // you count as the first member
  const picker = new UserSelectMenuBuilder()
    .setCustomId(`hm_team_members:${size}:${tree}`)
    .setPlaceholder(`Pick ${needed} teammate${needed === 1 ? "" : "s"}…`)
    .setMinValues(needed)
    .setMaxValues(needed);

  return interaction.update({
    embeds: [
      emptyPage(
        "👥 Pick Your Team",
        `A **${size}** needs ${PARTY_SIZES[size]} members total, so pick ${needed} more. ` +
        `Everyone must have run \`/register\` first.`
      ).embed,
    ],
    components: [new ActionRowBuilder().addComponents(picker)],
  });
}

async function handleCreateTeam(interaction, size, tree) {
  await interaction.deferUpdate();
  const picked = interaction.values.filter((id) => id !== interaction.user.id);
  const members = [interaction.user.id, ...picked];

  const result = await createPartyQuest({
    guildId: interaction.guildId,
    members,
    tree,
    size,
    difficulty: "easy",
  });

  if (result.error) {
    return interaction.editReply({ embeds: [emptyPage("Couldn't start that quest", result.error).embed], components: [] });
  }

  scheduleRefresh(interaction.guildId);
  return interaction.editReply({
    embeds: [
      emptyPage(
        "👥 Team quest started",
        `**${size} • ${TREE_BY_KEY[tree].label}**\n\n` +
        `${members.map((m) => `<@${m}>`).join(", ")}\n\n` +
        "Progress combines from everyone. Press **Check Quests & Collect** on the quest board when you think you've hit the target."
      ).embed,
    ],
    components: [],
  });
}

// ── Role self-service ────────────────────────────────────────────────────────
async function handleClaimRole(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const setup = await readSetup(interaction.guildId);
  const roleId = setup?.honourMarksRoleId || config.roles.honourMarks;

  if (!roleId) {
    return interaction.editReply({
      content: "The Honour Marks role isn't configured yet. Ask an admin to run `/setup`.",
    });
  }

  const check = await checkRoleGranting(interaction.guild, roleId);
  if (!check.ok) {
    return interaction.editReply({ content: `I can't assign that role yet:\n${check.problems.map((p) => `• ${p}`).join("\n")}` });
  }

  if (interaction.member.roles.cache.has(roleId)) {
    return interaction.editReply({ content: `You already have <@&${roleId}>.` });
  }

  try {
    await interaction.member.roles.add(roleId, "Honour Marks self-claim");
  } catch (e) {
    return interaction.editReply({ content: `Couldn't add the role: \`${e.message}\`` });
  }

  return interaction.editReply({
    content:
      `🎖️ **Honour Marks unlocked.**\n\n` +
      `You now have access to ` +
      [
        setup.channels.guide ? `<#${setup.channels.guide}>` : null,
        setup.channels.quests ? `<#${setup.channels.quests}>` : null,
        setup.channels.shop ? `<#${setup.channels.shop}>` : null,
        setup.channels.database ? `<#${setup.channels.database}>` : null,
      ].filter(Boolean).join(", ") +
      `.\n\n` +
      `New here? Start at ${setup.channels.guide ? `<#${setup.channels.guide}>` : "the guide channel"}. ` +
      `Ready to go? Head to <#${setup.channels.quests}> and press **Start a Solo Quest**. ` +
      `If you ever want to drop the role, it's still at <#${setup.channels.claim}>.`,
  });
}

async function handleDropRole(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const setup = await readSetup(interaction.guildId);
  const roleId = setup?.honourMarksRoleId || config.roles.honourMarks;

  if (!roleId) {
    return interaction.editReply({ content: "The Honour Marks role isn't configured yet." });
  }
  if (!interaction.member.roles.cache.has(roleId)) {
    return interaction.editReply({ content: `You don't have <@&${roleId}> right now.` });
  }

  try {
    await interaction.member.roles.remove(roleId, "Honour Marks self-drop");
  } catch (e) {
    return interaction.editReply({ content: `Couldn't remove the role: \`${e.message}\`` });
  }

  return interaction.editReply({
    content:
      `✅ **Honour Marks role removed.**\n\n` +
      `Your progress, Honour Marks and quest history are all kept — the role only controls access. ` +
      `Claim it again any time at <#${setup.channels.claim}>.`,
  });
}

async function handleShopOpen(interaction) {
  const bal = await getBalance(interaction.user.id);
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR.gold)
        .setTitle(`${HM_EMOJI} Shop`)
        .setDescription(`You hold **${bal.balance.toLocaleString()}** Honour Marks.\n\nChoose a section.`)
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("hm_shop_perks").setLabel("🎖️ Perks").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("hm_shop_boosts").setLabel("⚡ Boosts").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("hm_shop_consumables").setLabel("🎫 Consumables").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("hm_inventory").setLabel("🎒 Inventory").setStyle(ButtonStyle.Secondary)
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleShopPerks(interaction) {
  const member = await getMember(interaction.user.id);
  if (!member?.rsn) {
    return interaction.reply({ content: "Run `/register` first.", flags: MessageFlags.Ephemeral });
  }
  const options = [];
  for (const t of TREES) {
    const owned = await getPerkTier(interaction.user.id, t.key);
    if (owned >= PERK_TIERS.length) continue; // maxed — nothing to sell
    const next = PERK_TIERS[owned];
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(`${t.label} — Tier ${next.tier} (${next.cost.toLocaleString()} HM)`)
        .setValue(t.key)
        .setEmoji(t.emoji)
        .setDescription(
          owned > 0
            ? `You have T${owned} (+${perkBonusPercent(owned)}%) → buying this raises it to +${perkBonusPercent(next.tier)}%`
            : `+${perkBonusPercent(next.tier)}% HM from every ${t.label.toLowerCase()} quest you finish, forever`
        )
    );
  }

  if (!options.length) {
    return interaction.reply({
      embeds: [emptyPage("🎖️ Perks", "You already own every perk at maximum tier (+25% in every category).").embed],
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    embeds: [
      emptyPage(
        "🎖️ Perks — what these actually do",
        `A Perk is a **permanent** upgrade for one quest category. It never expires, is never used up, and can't ` +
        `be sold back — once you own it, every quest you finish in that category simply pays more ${HM_EMOJI} HM ` +
        `from then on.\n\n` +
        `Each category has **5 tiers** you buy in order (you can't skip ahead): +5% at T1, up to +25% at T5. ` +
        `Perks only affect ${HM_EMOJI} HM — they have no effect on Rank XP, and a perk in one category (say, ` +
        `Combat) does nothing for quests in any other category.\n\n` +
        `Prices: T1 1,750 • T2 10,062 • T3 24,150 • T4 48,300 • T5 100,625 ${HM_EMOJI}. Pick a category below to buy ` +
        `its next tier.`
      ).embed,
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("hm_buy_perk")
          .setPlaceholder("Buy a perk tier…")
          .addOptions(options.slice(0, 25))
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleBuyPerk(interaction, tree) {
  await interaction.deferUpdate();
  const result = await buyPerk({ guildId: interaction.guildId, userId: interaction.user.id, tree });

  if (result.error) {
    return interaction.editReply({ embeds: [emptyPage("Purchase failed", result.error).embed], components: [] });
  }
  scheduleRefresh(interaction.guildId);
  return interaction.editReply({
    embeds: [
      emptyPage(
        "🎖️ Perk upgraded",
        `**${TREE_BY_KEY[tree].label}** is now tier **${result.tier}** (+${perkBonusPercent(result.tier)}% HM).\n\n` +
        `Cost \`${result.cost.toLocaleString()}\` • Balance \`${result.balance.toLocaleString()}\``
      ).embed,
    ],
    components: [],
  });
}

async function handleShopBoosts(interaction) {
  const member = await getMember(interaction.user.id);
  if (!member?.rsn) {
    return interaction.reply({ content: "Run `/register` first.", flags: MessageFlags.Ephemeral });
  }
  const bal = await getBalance(interaction.user.id);

  const options = [];
  for (const t of TREES) {
    for (const spec of BOOST_TIERS) {
      options.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(`${t.label} — T${spec.tier} (${spec.cost.toLocaleString()} HM)`)
          .setDescription(`${boostBonusLabel(spec.multiplier)} quest-completion XP in ${t.label}, ${spec.weeks} week${spec.weeks === 1 ? "" : "s"}`)
          .setValue(`${t.key}:${spec.tier}`)
          .setEmoji(t.emoji)
      );
    }
  }

  return interaction.reply({
    embeds: [
      emptyPage(
        "⚡ Boosts — what these actually do",
        `You hold **${bal.balance.toLocaleString()}** ${HM_EMOJI}.\n\n` +
        `A Boost is a **temporary multiplier on quest-completion Rank XP** — nothing else. It does **not** touch ` +
        `${HM_EMOJI} HM, and it does **nothing** for a quest that expires instead of finishing. It only applies ` +
        `to quests in the one category you buy it for.\n\n` +
        `Buying one doesn't start the clock — it goes into your **Inventory** first. Open Inventory and activate ` +
        `it whenever you actually want it running, so you can buy ahead of a busy week without wasting time on it. ` +
        `Once active, every quest you FINISH in that category while it's running pays Rank XP multiplied by the ` +
        `number shown (e.g. a normal 250 Rank XP quest under a 2.0× boost pays 500). If you somehow have two active ` +
        `boosts for the same category, only the stronger one applies — they don't add together.\n\n` +
        `**T1** — 750 HM — 1.5× for 1 week\n**T2** — 2,250 HM — 2.0× for 2 weeks\n**T3** — 7,500 HM — 2.5× for 1 week\n\n` +
        `Pick one below to buy it.`
      ).embed,
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("hm_buy_boost")
          .setPlaceholder("Buy a boost…")
          .addOptions(options.slice(0, 25))
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleBuyBoost(interaction, value) {
  await interaction.deferUpdate();
  const [tree, tierRaw] = value.split(":");
  const result = await buyBoost({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    tree,
    tier: Number(tierRaw),
  });
  if (result.error) {
    return interaction.editReply({ embeds: [emptyPage("Purchase failed", result.error).embed], components: [] });
  }
  return interaction.editReply({
    embeds: [
      emptyPage(
        "⚡ Boost purchased",
        `**${TREE_BY_KEY[tree].label} T${tierRaw}** is in your inventory. ` +
        `Open **Inventory** to activate it when you're ready.\n\n` +
        `Cost \`${result.cost.toLocaleString()}\` • Balance \`${result.balance.toLocaleString()}\``
      ).embed,
    ],
    components: [],
  });
}

async function handleShopConsumables(interaction) {
  const bal = await getBalance(interaction.user.id);
  const options = Object.entries(CONSUMABLES).map(([key, spec]) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`${spec.label} (${spec.cost} HM)`)
      .setDescription(spec.desc.slice(0, 100))
      .setValue(key)
      .setEmoji(spec.emoji)
  );

  return interaction.reply({
    embeds: [
      emptyPage(
        "🎫 Consumables — what these actually do",
        `You hold **${bal.balance.toLocaleString()}** ${HM_EMOJI}.\n\n` +
        `Consumables are **one-time use**: buying one just adds it to your **Inventory**, and it's spent the ` +
        `moment you actually use it — buying it doesn't do anything by itself.\n\n` +
        Object.values(CONSUMABLES).map((c) => `${c.emoji} **${c.label}** — ${c.cost} ${HM_EMOJI}\n_${c.desc}_`).join("\n\n")
      ).embed,
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("hm_buy_consumable")
          .setPlaceholder("Buy a consumable…")
          .addOptions(options)
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleBuyConsumable(interaction, key) {
  await interaction.deferUpdate();
  const result = await buyConsumable({ guildId: interaction.guildId, userId: interaction.user.id, key });
  if (result.error) {
    return interaction.editReply({ embeds: [emptyPage("Purchase failed", result.error).embed], components: [] });
  }
  const spec = CONSUMABLES[key];
  return interaction.editReply({
    embeds: [
      emptyPage(
        `${spec.emoji} ${spec.label} purchased`,
        `Cost \`${result.cost.toLocaleString()}\` • Balance \`${result.balance.toLocaleString()}\``
      ).embed,
    ],
    components: [],
  });
}

async function handleGuideOpen(interaction) {
  const setup = await readSetup(interaction.guildId);
  const pages = renderGuide(setup || {});
  return interaction.reply({
    embeds: pages.map((p) => p.embed),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLfgOpen(interaction) {
  // Honest placeholder rather than a dead button: the board needs a join/leave
  // flow that isn't built yet, and a button that silently fails is worse than
  // one that explains itself.
  return interaction.reply({
    embeds: [
      emptyPage(
        "🔍 Looking For Group",
        "The public board isn't live yet. For now, start a team quest with **Start a Team Quest** " +
        "on the quest board and invite your members directly.\n\n" +
        "_An open LFG board is on the list._"
      ).embed,
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleInventory(interaction) {
  const bal = await getBalance(interaction.user.id);
  const inv = await getInventory(interaction.user.id);
  const boosts = await getActiveBoosts(interaction.user.id);
  const perks = await getPerks(interaction.user.id);

  const boostLines = inv.filter((i) => i.boost_tier > 0).map((i) => {
    const spec = BOOST_TIERS.find((t) => t.tier === i.boost_tier);
    return `• ${TREE_BY_KEY[i.tree]?.label || i.tree} — T${i.boost_tier}, ${boostBonusLabel(spec?.multiplier)} quest-completion XP for ${spec?.weeks || "?"} week(s) — not active yet ×${i.quantity}`;
  });
  const consumableLines = inv.filter((i) => i.boost_tier === 0).map((i) => {
    const spec = CONSUMABLES[i.tree];
    return `• ${spec?.emoji || "🎫"} ${spec?.label || i.tree} ×${i.quantity}`;
  });
  const activeLines = boosts.map(
    (b) => `• ${TREE_BY_KEY[b.tree]?.label || b.tree} — ${boostBonusLabel(b.multiplier)} quest-completion XP, ends <t:${Math.floor(new Date(b.expires_at).getTime() / 1000)}:R>`
  );
  const perkLines = perks.map(
    (p) => `• ${TREE_BY_KEY[p.tree]?.label || p.tree} — T${p.tier} (+${perkBonusPercent(p.tier)}%)`
  );

  const rows = [];
  const boostOptions = inv
    .filter((i) => i.boost_tier > 0)
    .map((i) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`Activate ${TREE_BY_KEY[i.tree]?.label || i.tree} T${i.boost_tier}`)
        .setValue(`${i.tree}:${i.boost_tier}`)
    );

  if (boostOptions.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("hm_activate_boost")
          .setPlaceholder("Activate a boost…")
          .addOptions(boostOptions.slice(0, 25))
      )
    );
  }

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR.main)
        .setTitle("🎒 Inventory")
        .setDescription(`You hold **${bal.balance.toLocaleString()}** ${HM_EMOJI}`)
        .addFields(
          { name: "Perks", value: perkLines.join("\n") || "_None_", inline: false },
          { name: "Boosts owned", value: boostLines.join("\n") || "_None_", inline: false },
          { name: "Consumables", value: consumableLines.join("\n") || "_None_", inline: false },
          { name: "Active boosts", value: activeLines.join("\n") || "_None_", inline: false }
        ),
    ],
    components: rows,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleActivateBoost(interaction, value) {
  await interaction.deferUpdate();
  const [tree, tierRaw] = value.split(":");
  const result = await activateBoost({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    tree,
    tier: Number(tierRaw),
  });
  if (result.error) {
    return interaction.editReply({ embeds: [emptyPage("Couldn't activate", result.error).embed], components: [] });
  }
  return interaction.editReply({
    embeds: [
      emptyPage(
        "⚡ Boost activated",
        `Your **${TREE_BY_KEY[tree]?.label || tree}** boost is live until <t:${Math.floor(result.expiresAt.getTime() / 1000)}:F>.`
      ).embed,
    ],
    components: [],
  });
}

async function handleMyQuests(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await getMember(interaction.user.id);
  if (!member?.rsn) return interaction.editReply({ content: "Run `/register` first." });

  const solo = await getActiveSoloQuests(interaction.user.id);
  const team = await getActivePartyQuestForUser(interaction.user.id);

  if (!solo.length && !team) {
    return interaction.editReply({ content: "You have no active quests. Open the quest board and press **Start a Solo Quest**." });
  }

  const snap = await fetchHiscores(member.rsn);
  const embeds = [];

  for (const q of solo) {
    const progress = diffProgress(q.baseline, snap, q.targets);
    embeds.push(questProgressEmbed(q, progress));
  }
  if (team) {
    const evaluated = await checkPartyQuest(team);
    if (evaluated?.progress) {
      embeds.push(
        new EmbedBuilder()
          .setColor(COLOR.main)
          .setTitle(`👥 TEAM • ${team.size} • ${team.tree}`)
          .setDescription(
            `**Team progress: ${evaluated.progress.totalPct}%**\n\n` +
            evaluated.progress.parts.map((p) => `• ${formatPart(p)} — **${Math.floor(p.pct)}%**`).join("\n") +
            `\n\nEnds <t:${Math.floor(new Date(team.expires_at).getTime() / 1000)}:R>`
          )
      );
    }
  }

  const components = [];
  const inv = await getInventory(interaction.user.id);
  const skipTokens = inv.find((i) => i.tree === "quest_skip_token" && i.boost_tier === 0)?.quantity || 0;
  if (skipTokens > 0 && solo.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        solo.slice(0, 5).map((q) =>
          new ButtonBuilder()
            .setCustomId(`hm_cancel_quest:${q.id}`)
            .setLabel(`❌ Cancel ${q.quest_type}`)
            .setStyle(ButtonStyle.Danger)
        )
      )
    );
  }

  return interaction.editReply({ embeds: embeds.slice(0, 10), components });
}

async function handleCancelQuest(interaction, questId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const used = await consumeItem(interaction.user.id, "quest_skip_token");
  if (!used) {
    return interaction.editReply({ content: "You don't have a Quest Skip Token. Buy one in the Shop under Consumables." });
  }

  const result = await cancelSoloQuest(interaction.user.id, questId);
  if (result.error) {
    // The quest it would have cancelled is already gone (finished or expired
    // a moment earlier) — refund the token since it was never actually used.
    await grantConsumable(interaction.user.id, interaction.guildId, "quest_skip_token");
    return interaction.editReply({ content: result.error });
  }

  scheduleRefresh(interaction.guildId);
  return interaction.editReply({
    content: "✅ Quest cancelled — no penalty, no reward, and that slot is free again. Press **My Quests** to start a new one.",
  });
}

// ── Router ───────────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case "setup": return await handleSetup(interaction);
        case "register": return await handleRegister(interaction);
        case "hm": return await handleHm(interaction);
        default: return;
      }
    }

    if (interaction.isButton()) {
      const btnId = interaction.customId;
      if (btnId.startsWith("hm_quest_choose:")) {
        const [, questType, tree] = btnId.split(":");
        return await handleQuestChoose(interaction, questType, tree);
      }
      if (btnId.startsWith("hm_quest_random:")) {
        const [, questType, tree] = btnId.split(":");
        return await handleCreateSolo(interaction, questType, tree);
      }
      if (btnId.startsWith("hm_cancel_quest:")) {
        const questId = btnId.split(":")[1];
        return await handleCancelQuest(interaction, questId);
      }

      switch (interaction.customId) {
        case "hm_quest_start": return await handleQuestStart(interaction);
        case "hm_team_start": return await handleTeamStart(interaction);
        case "hm_check": return await handleCheck(interaction);
        case "hm_my_quests": return await handleMyQuests(interaction);
        case "hm_claim_role": return await handleClaimRole(interaction);
        case "hm_drop_role": return await handleDropRole(interaction);
        case "hm_shop_open": return await handleShopOpen(interaction);
        case "hm_shop_perks": return await handleShopPerks(interaction);
        case "hm_shop_boosts": return await handleShopBoosts(interaction);
        case "hm_shop_consumables": return await handleShopConsumables(interaction);
        case "hm_lfg_open": return await handleLfgOpen(interaction);
        case "hm_inventory": return await handleInventory(interaction);
        case "hm_guide_open": return await handleGuideOpen(interaction);
        case "hm_db_page": // disabled label button; never fires, kept so a
                           // stray click can never leave an unacked interaction
        case "hm_db_refresh": {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await refreshPanels(interaction.guildId);
          return interaction.editReply({ content: "Database refreshed." });
        }
        default: return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;

      if (id === "hm_pick_type") {
        return await handlePickTree(interaction, interaction.values[0]);
      }
      if (id.startsWith("hm_pick_tree:")) {
        const questType = id.split(":")[1];
        return await handleTreeChosen(interaction, questType, interaction.values[0]);
      }
      if (id.startsWith("hm_pick_target:")) {
        const [, questType, tree] = id.split(":");
        return await handlePickTarget(interaction, questType, tree, interaction.values);
      }
      if (id === "hm_buy_perk") {
        return await handleBuyPerk(interaction, interaction.values[0]);
      }
      if (id === "hm_activate_boost") {
        return await handleActivateBoost(interaction, interaction.values[0]);
      }
      if (id === "hm_buy_boost") {
        return await handleBuyBoost(interaction, interaction.values[0]);
      }
      if (id === "hm_buy_consumable") {
        return await handleBuyConsumable(interaction, interaction.values[0]);
      }
      if (id === "hm_pick_size") {
        return await handlePickSize(interaction, interaction.values[0]);
      }
      if (id.startsWith("hm_pick_team_tree:")) {
        const size = id.split(":")[1];
        return await handlePickTeamMembers(interaction, size, interaction.values[0]);
      }
      return;
    }

    if (interaction.isUserSelectMenu()) {
      const id = interaction.customId;
      if (id.startsWith("hm_team_members:")) {
        const [, size, tree] = id.split(":");
        return await handleCreateTeam(interaction, size, tree);
      }
      return;
    }
  } catch (e) {
    console.error("[Interaction]", interaction.customId || interaction.commandName, e);
    const payload = { content: `Something went wrong: \`${e.message}\``, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`[Honour Marks] Online as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(config.token);
  try {
    // Writes the wanted scope, then empties the other one. Without the second
    // half, a server that has held both a global and a guild registration keeps
    // both and the picker shows every subcommand twice.
    await syncCommands({
      rest,
      routes: {
        global: () => Routes.applicationCommands(config.clientId),
        guild: (guildId) => Routes.applicationGuildCommands(config.clientId, guildId),
      },
      clientId: config.clientId,
      commands,
      devGuildId: config.devGuildId,
      guildIds: [...client.guilds.cache.keys()],
      log: (msg) => console.log(`[Honour Marks] ${msg}`),
      warn: (msg) => console.warn(`[Honour Marks] ${msg}`),
    });
  } catch (e) {
    console.error("[Honour Marks] Command registration failed:", e.message);
  }

  // Expiry sweep — pays partial HM for lapsed quests, awards no Rank XP.
  const sweep = async () => {
    try {
      await sweepExpiredQuests();
    } catch (e) {
      console.error("[Honour Marks] Expiry sweep failed:", e.message);
    }
  };
  await sweep();
  setInterval(sweep, config.expirySweepMs).unref?.();

  // Periodic panel reconciliation heals anything a moderator deleted.
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      await refreshPanels(guild.id).catch(() => {});
    }
  }, config.syncIntervalMs).unref?.();

  for (const guild of client.guilds.cache.values()) {
    await refreshPanels(guild.id).catch(() => {});
  }
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`[Honour Marks] Joined guild ${guild.name} (${guild.id})`);
  // Panels are only posted after /setup runs — we don't assume a channel.
});

process.on("unhandledRejection", (e) => console.error("[Honour Marks] Unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("[Honour Marks] Uncaught exception:", e));

client.login(config.token);

module.exports = { client, refreshPanels };
