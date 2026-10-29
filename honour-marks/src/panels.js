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

const HM_EMOJI = "🪙";

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
        new ButtonBuilder().setCustomId("hm_my_quests").setLabel("📜 My Quests").setStyle(ButtonStyle.Secondary)
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
async function renderQuestBoard(guildId) {
  const supabase = getSupabase();
  if (!supabase) return [emptyPage("📜 Quest Board", "Database unavailable.")];

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
      `Earn ${HM_EMOJI} **Honour Marks** by completing tasks, then spend them in the Shop.\n` +
      `Every completed quest also awards a small amount of **Rank XP**.\n\n` +
      lines.join("\n").slice(0, DESC_BUDGET)
    )
    .setFooter({ text: "Odinheim • Honour Marks" })
    .setTimestamp();

  return [{ embed, components: buildPanelComponents("quest_board", 0, 1) }];
}

// ── Shop ─────────────────────────────────────────────────────────────────────
async function renderShop(guildId) {
  const perkLines = TREES.map((t) => `${t.emoji} **${t.label}** — +5% HM per tier, 5 tiers`);
  const boostLines = [
    "T1 — +0.5× Rank XP, 1 week",
    "T2 — +1× Rank XP, 2 weeks",
    "T3 — +1.5× Rank XP, 1 week",
  ];

  const embed = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle("🛒 Honour Marks Shop")
    .setDescription(
      `Spend ${HM_EMOJI} **Honour Marks** on permanent upgrades and temporary boosts.\n\n` +
      `**🎖️ Perks** — permanent, +5% HM from quests in that category per tier (max +25%)\n` +
      `${perkLines.join("\n")}\n\n` +
      `**⚡ Boosts** — temporary **Rank XP** multipliers, bought here and activated from your Inventory when you're ready\n` +
      `${boostLines.join("\n")}\n\n` +
      `**🎫 Consumables**\n` +
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
      // Message was deleted by someone. Repost at the same index.
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
  renderDatabase, renderQuestBoard, renderShop, emptyPage,
  getPanelLedger, syncPanel,
  getRankForXp, formatRankProgress,
  getConfigValue, setConfigValue,
};
