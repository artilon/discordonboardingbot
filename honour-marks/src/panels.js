"use strict";
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require("discord.js");
const { getSupabase, getConfigValue, setConfigValue } = require("./db");
const { getRankForXp, formatRankProgress } = require("./ranks");
const { TREES } = require("./quests");

const COLOR = {
  main: 0xb8860b,
  gold: 0xd4af37,
  ok: 0x2ecc71,
  warn: 0xe67e22,
  bad: 0xe74c3c,
};

const HM_EMOJI = "<:hm:1565236821330493512>";

/**
 * THE EMBED LIMIT, SOLVED
 * =======================
 * A Discord embed description is capped at 4,096 chars and a message at 6,000.
 * Naively dumping a member database into one embed truncates silently once the
 * clan grows. The original bot's answer was to chunk into N embeds and then
 * track "part 1..10" message IDs by hand, which drifted and left orphans.
 *
 * Here every panel is a PURE FUNCTION of the database that returns an array of
 * page payloads. `syncPanel` reconciles that array against the `hm_panels`
 * ledger:
 *
 *   page exists, message exists  -> edit in place
 *   page exists, message gone    -> repost at the same index
 *   page added                   -> post
 *   page removed                 -> delete the stale message
 *
 * So growth is automatic and shrinkage cleans up after itself. Page count never
 * drifts, and a manual delete by a moderator self-heals on the next refresh.
 */

const DESC_BUDGET = 3800; // safety margin under 4096

/** Splits entry lines into as few embed descriptions as possible. */
function chunkLines(lines, header = "", budget = DESC_BUDGET) {
  const chunks = [];
  let current = [];
  let len = header.length;

  for (const line of lines) {
    if (current.length && len + line.length + 1 > budget) {
      chunks.push(current);
      current = [];
      len = 0;
    }
    current.push(line);
    len += line.length + 1;
  }
  if (current.length || chunks.length === 0) chunks.push(current);
  return chunks;
}

function buildPanelComponents(panelKey, pageIndex, pageCount) {
  const rows = [];

  if (panelKey === "quest_board" && pageIndex === 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("hm_quest_start").setLabel("📋 Start a Solo Quest").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("hm_team_start").setLabel("👥 Start a Team Quest").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("hm_check").setLabel("✅ Check Quests & Collect").setStyle(ButtonStyle.Success)
      )
    );
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("hm_shop_open").setLabel("🛒 Shop & Inventory").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("hm_lfg_open").setLabel("🔍 Looking For Group").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("hm_my_quests").setLabel("📜 My Quests").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("hm_guide_open").setLabel("📖 How This Works").setStyle(ButtonStyle.Secondary)
      )
    );
  }

  if (panelKey === "database" && pageCount > 1) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("hm_db_page")
          .setLabel(`Page ${pageIndex + 1} of ${pageCount}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder().setCustomId("hm_db_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Primary)
      )
    );
  }

  return rows;
}

// ── Database panel ───────────────────────────────────────────────────────────
/**
 * One line per member: rank, HM held, and every quest type they've completed.
 * Reads the `hm_member_totals` view so the numbers can't drift from the ledger.
 */
async function renderDatabase(guildId) {
  const supabase = getSupabase();
  if (!supabase) return [emptyPage("📊 Honour Marks Database", "Database unavailable.")];

  const { data, error } = await supabase
    .from("hm_member_totals")
    .select("*")
    .eq("guild_id", guildId);

  if (error) return [emptyPage("📊 Honour Marks Database", `Couldn't load: ${error.message}`)];

  const rows = (data || [])
    .filter((r) => r.rsn)
    .sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0));

  if (!rows.length) {
    return [
      emptyPage(
        "📊 Honour Marks Database",
        "_No registered members yet._\n\nUse `/register` to link your RuneScape name and appear here."
      ),
    ];
  }

  const lines = rows.map((r) => {
    const total = (Number(r.solo_daily) || 0) + (Number(r.solo_weekly) || 0) +
      (Number(r.solo_monthly) || 0) + (Number(r.duo) || 0) + (Number(r.trio) || 0) + (Number(r.quad) || 0);
    return (
      `**${r.rsn}** — ${HM_EMOJI} \`${(Number(r.balance) || 0).toLocaleString()}\` held • ` +
      `\`${(Number(r.total_earned) || 0).toLocaleString()}\` earned total\n` +
      `┗ Quests \`${total}\` • D \`${r.solo_daily || 0}\` · W \`${r.solo_weekly || 0}\` · M \`${r.solo_monthly || 0}\` · ` +
      `Duo \`${r.duo || 0}\` · Trio \`${r.trio || 0}\` · Quad \`${r.quad || 0}\``
    );
  });

  const totalHm = rows.reduce((s, r) => s + (Number(r.balance) || 0), 0);
  const totalQuests = rows.reduce(
    (s, r) => s + (Number(r.solo_daily) || 0) + (Number(r.solo_weekly) || 0) +
      (Number(r.solo_monthly) || 0) + (Number(r.duo) || 0) + (Number(r.trio) || 0) + (Number(r.quad) || 0),
    0
  );

  const header =
    `**Members:** \`${rows.length}\` • **HM in circulation:** \`${totalHm.toLocaleString()}\` • ` +
    `**Quests completed:** \`${totalQuests}\`\n\n`;

  const chunks = chunkLines(lines, header);

  return chunks.map((chunk, i) => {
    const embed = new EmbedBuilder()
      .setColor(COLOR.main)
      .setTitle(i === 0 ? "📊 Honour Marks Database" : "📊 Honour Marks Database (cont'd)")
      .setDescription((i === 0 ? header : "") + chunk.join("\n"))
      .setFooter({ text: `Odinheim • ${chunks.length > 1 ? `Part ${i + 1}/${chunks.length} • ` : ""}Updated` })
      .setTimestamp();
    return { embed, components: [] };
  });
}

// ── Quest board ──────────────────────────────────────────────────────────────
async function renderQuestBoard(guildId, setup = {}) {
  const supabase = getSupabase();
  if (!supabase) return [emptyPage("📜 Quest Board", "Database unavailable.")];
  const shopCh = setup.channels?.shop ? `<#${setup.channels.shop}>` : "the Shop";

  const { data: activeQuests } = await supabase
    .from("hm_quests")
    .select("*")
    .eq("guild_id", guildId)
    .order("expires_at", { ascending: true });

  const { data: activeTeams } = await supabase
    .from("hm_party_quests")
    .select("*")
    .eq("guild_id", guildId)
    .order("expires_at", { ascending: true });

  const lines = [];

  if (activeQuests?.length) {
    lines.push("**Solo Quests In Progress**");
    for (const q of activeQuests.slice(0, 25)) {
      lines.push(
        `• <@${q.user_id}> — ${q.quest_type} • ${q.tree} • <t:${Math.floor(new Date(q.expires_at).getTime() / 1000)}:R>`
      );
    }
    if (activeQuests.length > 25) lines.push(`_…and ${activeQuests.length - 25} more_`);
    lines.push("");
  }

  if (activeTeams?.length) {
    lines.push("**Team Quests In Progress**");
    for (const q of activeTeams.slice(0, 15)) {
      lines.push(
        `• ${q.size} • ${q.tree} • ${q.members.map((m) => `<@${m}>`).join(", ")} • ` +
        `<t:${Math.floor(new Date(q.expires_at).getTime() / 1000)}:R>`
      );
    }
    lines.push("");
  }

  if (!lines.length) {
    lines.push("_No quests in progress right now._ Press **Start a Solo Quest** to begin.");
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle("📜 Quest Board")
    .setDescription(
      `Earn ${HM_EMOJI} **Honour Marks** by completing tasks, then spend them in ${shopCh}.\n` +
      `Every completed quest also awards a small amount of **Rank XP**.\n\n` +
      lines.join("\n").slice(0, DESC_BUDGET)
    )
    .setFooter({ text: "Odinheim • Honour Marks" })
    .setTimestamp();

  return [{ embed, components: buildPanelComponents("quest_board", 0, 1) }];
}

// ── Role self-service ────────────────────────────────────────────────────────
/**
 * The claim panel.
 *
 * Two buttons rather than one toggle: this message is shared by the whole
 * server, so its components cannot differ per viewer. A single button whose
 * label changed based on who was looking would be impossible, and a toggle
 * button labelled generically hides what it currently does. Two explicit
 * buttons name both actions and are correct for every member at once.
 */
function renderClaimPanel(setup = {}) {
  const roleMention = setup.honourMarksRoleId ? `<@&${setup.honourMarksRoleId}>` : "**Honour Marks**";
  const unlocked = [
    setup.channels?.guide ? `<#${setup.channels.guide}>` : null,
    setup.channels?.quests ? `<#${setup.channels.quests}>` : null,
    setup.channels?.shop ? `<#${setup.channels.shop}>` : null,
    setup.channels?.database ? `<#${setup.channels.database}>` : null,
  ].filter(Boolean).join(", ");

  const embed = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle("🎖️ Honour Marks Role")
    .setDescription(
      `Claim the ${roleMention} role to unlock the guide, quest board, shop and database, or drop it any time.\n\n` +
      `**Claim Role** — unlocks ${unlocked || "the Honour Marks channels"} so you can start earning Honour Marks ` +
      `from quests.\n\n` +
      `**Drop Role** — removes the role again. You can come back here and claim it whenever you like.\n\n` +
      `_These channels are read-only. Everything you do happens through buttons on their panels._`
    )
    .setFooter({ text: "Odinheim • Honour Marks" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("hm_claim_role")
      .setLabel("Claim Role")
      .setEmoji("🎖️")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("hm_drop_role")
      .setLabel("Drop Role")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Secondary)
  );

  return [{ embed, components: [row] }];
}

// ── Shop ─────────────────────────────────────────────────────────────────────
/**
 * The public shop panel is an overview, not the full catalogue — Discord's
 * embed limit and DESC_BUDGET don't leave room for a full explanation of
 * every tier of every perk here. The buttons below open an ephemeral reply
 * (see handleShopPerks/Boosts/Consumables in index.js) with the complete,
 * first-timer-friendly breakdown of every single purchase, its cost, exactly
 * what it does and doesn't do, and whether it stacks.
 */
async function renderShop(guildId) {
  const perkLines = TREES.map((t) => `${t.emoji} **${t.label}** — 5 tiers, +5% HM each (max +25%)`);
  const boostLines = [
    "T1 — 750 HM — ×1.5 quest completion XP for 1 week",
    "T2 — 2,250 HM — ×2.0 quest completion XP for 2 weeks",
    "T3 — 7,500 HM — ×2.5 quest completion XP for 1 week",
  ];

  const embed = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle("🛒 Honour Marks Shop")
    .setDescription(
      `New here? Press **📖 How This Works** on the quest board first — it explains what ${HM_EMOJI} Honour Marks ` +
      `even are. This panel is just the price list; press a button below for the full explanation of each item.\n\n` +
      `**🎖️ Perks — permanent** — once bought, a perk never expires or gets used up. ` +
      `Each tier adds +5% more ${HM_EMOJI} HM from every quest you finish in that one category (stacks up to +25% at tier 5).\n` +
      `${perkLines.join("\n")}\n\n` +
      `**⚡ Boosts — temporary, Quest Completion XP only** — a boost does nothing to HM. ` +
      `While one is running, every quest you FINISH (not one that times out) in that category pays extra **Rank XP** — ` +
      `the XP that counts toward your actual clan rank. Buy it here, then open **Inventory** to switch it on whenever you want the clock to start.\n` +
      `${boostLines.join("\n")}\n\n` +
      `**🎫 Consumables — one-time use, spent the moment you use them**\n` +
      `🎫 **Quest Skip Token** (4 ${HM_EMOJI}) — cancel an active solo quest, no penalty\n` +
      `🎯 **Quest Choice Token** (50 ${HM_EMOJI}) — hand-pick your next quest's target`
    )
    .setFooter({ text: "Odinheim • Honour Marks Shop" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("hm_shop_perks").setLabel("🎖️ Perks").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("hm_shop_boosts").setLabel("⚡ Boosts").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("hm_shop_consumables").setLabel("🎫 Consumables").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("hm_inventory").setLabel("🎒 Inventory").setStyle(ButtonStyle.Secondary)
  );

  return [{ embed, components: [row] }];
}

// ── Guide ────────────────────────────────────────────────────────────────────
/**
 * The explainer post. Written for someone who has never seen this bot before
 * and has no idea what Honour Marks are. A pure function of `setup` (channel
 * IDs only) so it can be synced as a normal panel AND reused verbatim for the
 * "📖 How This Works" button's ephemeral reply.
 */
function renderGuide(setup = {}) {
  const claimCh = setup.channels?.claim ? `<#${setup.channels.claim}>` : "**the role channel**";
  const questsCh = setup.channels?.quests ? `<#${setup.channels.quests}>` : "**the quest board**";
  const shopCh = setup.channels?.shop ? `<#${setup.channels.shop}>` : "**the shop**";
  const dbCh = setup.channels?.database ? `<#${setup.channels.database}>` : "**the database channel**";

  const page1 = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle("📖 What Is Honour Marks?")
    .setDescription(
      `**Honour Marks** is this clan's quest and reward system. You complete OSRS goals (skill XP, boss kills, ` +
      `raids, minigames), and every time you finish one you get paid in two completely separate currencies ` +
      `at the same time:\n\n` +
      `${HM_EMOJI} **Honour Marks (HM)** — a spendable currency. It does nothing by itself except sit in your ` +
      `balance until you spend it in the **Shop** on permanent upgrades or temporary boosts. It is **not** part of ` +
      `your clan rank.\n\n` +
      `🏅 **Rank XP** — a small amount of progress toward your actual clan rank (the one Heimdall, the other bot, ` +
      `shows on the member list). This runs **side by side** with the XP you earn just from being a clan member over ` +
      `time (tenure XP) — the two are added together for your rank, but neither one affects how the other is earned.\n\n` +
      `Nothing here is required. It's an optional side-game for people who want extra rewards for playing — your ` +
      `clan rank still climbs on its own from tenure alone even if you never touch a quest.`
    )
    .setFooter({ text: "Odinheim • Honour Marks — Page 1/4: The Basics" });

  const page2 = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle("🚀 Your First 10 Minutes")
    .setDescription(
      `**1. Claim the role.** Go to ${claimCh} and press **Claim Role**. This unlocks ${questsCh} (the quest ` +
      `board), ${shopCh} and ${dbCh} (everyone's stats). You can press **Drop Role** there any time to hide ` +
      `those channels again — nothing you've earned is lost.\n\n` +
      `**2. Link your RuneScape account.** Run \`/register <your RSN>\` anywhere in the server. This is required — ` +
      `your Discord nickname is NOT used for tracking, because nicknames can be changed, denied, or shared. ` +
      `\`/register\` checks your name against the real OSRS hiscores before saving it, so make sure it's spelled ` +
      `exactly right and your profile isn't set to private.\n\n` +
      `**3. Start a quest.** Open ${questsCh} and press **📋 Start a Solo Quest**. Pick Daily, Weekly or Monthly, ` +
      `then a category. The bot reads your hiscores right now as your starting point ("baseline") — only progress ` +
      `made *after* this moment counts.\n\n` +
      `**4. Go play.** There's nothing else to click. Just play OSRS normally.\n\n` +
      `**5. Come back and press ✅ Check Quests & Collect.** This is the one manual step — the bot doesn't watch you ` +
      `live, it checks your hiscores only when you press this button. If you've hit the target, you get paid ` +
      `${HM_EMOJI} HM and Rank XP right then.`
    )
    .setFooter({ text: "Odinheim • Honour Marks — Page 2/4: Getting Started" });

  const page3 = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle("📜 How Quests Actually Work")
    .setDescription(
      `**Solo quests** — you can hold one Daily, one Weekly and one Monthly at the same time, each in whatever ` +
      `category you pick (Gathering, Production, Combat, Utility, Boss PvM, Raids, Minigames). A Daily must be ` +
      `finished within 1 day, a Weekly within 7 days, a Monthly within 30 days.\n\n` +
      `**Team quests (duo/trio/quad)** — press **👥 Start a Team Quest** and bring 1-3 others. The whole group ` +
      `shares one target and everyone's progress adds together, so it finishes faster with more people pulling ` +
      `their weight. A team quest runs for 14 days. Every member must already be registered with \`/register\`.\n\n` +
      `**What happens if time runs out?** The quest is cancelled automatically — there's no penalty beyond that. ` +
      `You still get paid ${HM_EMOJI} HM for the percentage of the target you actually reached (e.g. 40% done = ` +
      `40% of the HM reward), but you get **zero Rank XP** for an unfinished quest. Rank XP only pays out for a ` +
      `quest you actually finish in time.\n\n` +
      `**Checking progress doesn't cost you anything** — press ✅ **Check Quests & Collect** as often as you like ` +
      `to see your live percentage; it only pays out once a target is actually met.`
    )
    .setFooter({ text: "Odinheim • Honour Marks — Page 3/4: Quests" });

  const page4 = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle("🛒 Where Your HM Goes")
    .setDescription(
      `Every quest also pays ${HM_EMOJI} Honour Marks — that's the currency you spend in ${shopCh}, also reachable ` +
      `any time from the 🛒 **Shop & Inventory** button on the quest board. Three kinds of things to buy, and the ` +
      `Shop panel explains every single tier of each one in detail when you open it:\n\n` +
      `**🎖️ Perks** — permanent. Each one you buy makes future quests in that category pay more HM, forever.\n\n` +
      `**⚡ Boosts** — temporary. While active, they multiply the **Rank XP** a finished quest in that category ` +
      `pays — not the HM. Buy one, then switch it on from **Inventory** whenever you're ready to start the clock.\n\n` +
      `**🎫 Consumables** — one-time-use items like the Quest Skip Token and Quest Choice Token.\n\n` +
      `Check your balance, perks and active boosts any time with \`/hm balance\`, or see the whole clan's standing ` +
      `in ${dbCh}.\n\n` +
      `_This post is kept up to date automatically — if anything about the system ever changes, this guide changes ` +
      `with it._`
    )
    .setFooter({ text: "Odinheim • Honour Marks — Page 4/4: The Shop" });

  return [
    { embed: page1, components: [] },
    { embed: page2, components: [] },
    { embed: page3, components: [] },
    { embed: page4, components: [] },
  ];
}

function emptyPage(title, description) {
  return {
    embed: new EmbedBuilder().setColor(COLOR.main).setTitle(title).setDescription(description),
    components: [],
  };
}

// ── The ledger ───────────────────────────────────────────────────────────────
async function getPanelLedger(guildId, panelKey) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("hm_panels")
    .select("*")
    .eq("guild_id", guildId)
    .eq("panel_key", panelKey)
    .order("page_index", { ascending: true });
  return data || [];
}

/**
 * Reconciles a rendered panel against what's actually in the channel.
 * Returns { edited, posted, deleted } for logging.
 */
async function syncPanel(guildId, channel, panelKey, pages) {
  const supabase = getSupabase();
  if (!supabase || !channel) return { edited: 0, posted: 0, deleted: 0 };

  const ledger = await getPanelLedger(guildId, panelKey);
  const byIndex = new Map(ledger.map((r) => [r.page_index, r]));

  let edited = 0;
  let posted = 0;
  let deleted = 0;

  for (let i = 0; i < pages.length; i++) {
    const { embed, components } = pages[i];
    const row = byIndex.get(i);

    if (row) {
      const msg = await channel.messages.fetch(row.message_id).catch(() => null);
      if (msg) {
        // touch:false avoids bumping the message to the bottom of the channel,
        // which would scatter a multi-page panel out of order.
        await msg.edit({ embeds: [embed], components }).catch(() => {});
        edited += 1;
        continue;
      }
      // Not found in this channel. Either someone deleted it, OR this panel
      // was just reassigned to a different channel (e.g. splitting the guide
      // or shop out of the quests channel) — in which case the old copy is
      // still sitting, untouched, in whatever channel the ledger remembers.
      // Clean that one up so a channel reorganization doesn't leave stale
      // duplicate panels behind.
      if (row.channel_id && row.channel_id !== channel.id) {
        const oldChannel = await channel.client.channels.fetch(row.channel_id).catch(() => null);
        const oldMsg = oldChannel?.isTextBased?.() ? await oldChannel.messages.fetch(row.message_id).catch(() => null) : null;
        if (oldMsg) await oldMsg.delete().catch(() => {});
      }
      // Repost at the same index, in the (possibly new) channel.
      const reposted = await channel.send({ embeds: [embed], components }).catch(() => null);
      if (reposted) {
        await supabase.from("hm_panels").update({
          message_id: reposted.id,
          channel_id: channel.id,
          updated_at: new Date().toISOString(),
        }).eq("guild_id", guildId).eq("panel_key", panelKey).eq("page_index", i);
        posted += 1;
      }
      continue;
    }

    const sent = await channel.send({ embeds: [embed], components }).catch(() => null);
    if (sent) {
      await supabase.from("hm_panels").upsert(
        {
          guild_id: guildId,
          channel_id: channel.id,
          panel_key: panelKey,
          page_index: i,
          message_id: sent.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "guild_id,panel_key,page_index" }
      );
      posted += 1;
    }
  }

  // Surplus pages: the panel shrank. Delete them and clear the ledger rows.
  for (const row of ledger) {
    if (row.page_index < pages.length) continue;
    const msg = await channel.messages.fetch(row.message_id).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
    await supabase.from("hm_panels").delete()
      .eq("guild_id", guildId).eq("panel_key", panelKey).eq("page_index", row.page_index);
    deleted += 1;
  }

  return { edited, posted, deleted };
}

module.exports = {
  COLOR, HM_EMOJI, DESC_BUDGET,
  chunkLines, buildPanelComponents,
  renderClaimPanel, renderGuide,
  renderDatabase, renderQuestBoard, renderShop, emptyPage,
  getPanelLedger, syncPanel,
  getRankForXp, formatRankProgress,
  getConfigValue, setConfigValue,
};
