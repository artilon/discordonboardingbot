"use strict";
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require("discord.js");
const { getSupabase, getConfigValue, setConfigValue } = require("./db");
const { getRankForXp, formatRankProgress, RANK_TIERS } = require("./ranks");
const { TREES, TREE_BY_KEY, PARTY_SIZES, LFG_EXPIRY_HOURS } = require("./quests");

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
    // Shop & Inventory now lives only in the dedicated shop channel, and
    // Looking For Group has been replaced by the permanent open-teams panel
    // below the board — so this is down to one row of four.
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("hm_quest_start").setLabel("📋 Start a Solo Quest").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("hm_team_start").setLabel("👥 Start a Team Quest").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("hm_check").setLabel("✅ Check Quests & Collect").setStyle(ButtonStyle.Success),
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

// ── Looking For Group ────────────────────────────────────────────────────────
/**
 * The real, permanent replacement for the old "not live yet" LFG button.
 * Every open (recruiting) team listing is shown here with who's already in
 * it and how many slots are left. The dropdown joins one; joining the last
 * slot converts it into a real team quest automatically (see
 * `joinOpenTeam` in src/quests.js) and it drops off this list.
 */
async function renderOpenTeams(guildId) {
  const supabase = getSupabase();
  if (!supabase) return [emptyPage("🔍 Looking For Group", "Database unavailable.")];

  const cutoff = new Date(Date.now() - LFG_EXPIRY_HOURS * 3600000).toISOString();
  const { data } = await supabase
    .from("hm_lfg_posts")
    .select("*")
    .eq("guild_id", guildId)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: true });

  const open = (data || []).slice(0, 25);
  const lines = [];

  if (open.length) {
    for (const p of open) {
      const tree = TREE_BY_KEY[p.categories?.[0]];
      const expected = PARTY_SIZES[p.team_size] || p.members.length;
      const need = Math.max(expected - p.members.length, 0);
      const expiresAt = Math.floor(new Date(p.created_at).getTime() / 1000) + LFG_EXPIRY_HOURS * 3600;
      lines.push(
        `• **${p.team_size}** ${tree ? `${tree.emoji} ${tree.label}` : p.categories?.[0] || "?"} — ` +
        `${p.members.map((m) => `<@${m}>`).join(", ")} ` +
        `(needs **${need}** more) — expires <t:${expiresAt}:R>`
      );
    }
  } else {
    lines.push(
      "_No open teams right now._ On the quest board, press **Start a Team Quest** and choose " +
      "**Post an Open Listing** to recruit here instead of picking everyone yourself."
    );
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR.main)
    .setTitle("🔍 Looking For Group")
    .setDescription(
      "Open team listings below are still recruiting. Pick one from the dropdown to join — " +
      "the moment a listing fills every slot it starts for real, automatically, with the same " +
      `rewards as any other team quest. An unfilled listing expires after ${LFG_EXPIRY_HOURS} hours.\n\n` +
      lines.join("\n").slice(0, DESC_BUDGET)
    )
    .setFooter({ text: "Odinheim • Honour Marks" })
    .setTimestamp();

  const components = [];
  if (open.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("hm_lfg_join")
          .setPlaceholder("Join an open team…")
          .addOptions(
            open.map((p) => {
              const tree = TREE_BY_KEY[p.categories?.[0]];
              const expected = PARTY_SIZES[p.team_size] || p.members.length;
              return new StringSelectMenuOptionBuilder()
                .setLabel(`${p.team_size} • ${tree?.label || p.categories?.[0]} (${p.members.length}/${expected})`)
                .setDescription(`${expected - p.members.length} slot(s) open`)
                .setValue(String(p.id))
                .setEmoji(tree?.emoji || "🔍");
            })
          )
      )
    );
  }
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("hm_lfg_cancel_mine").setLabel("❌ Cancel My Listing").setStyle(ButtonStyle.Danger)
    )
  );

  return [{ embed, components }];
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
      `**🗃️ Items — permanent, 3 slots per category** — unlike Perks, Items change what a quest actually ` +
      `asks of you: **Quest & Threshold Reduction** lowers the requirement, **Clan Chat XP Bonus** raises the ` +
      `**Rank XP** paid out, and **Quest Expansion** adds extra targets (or extra %) for proportionally more ` +
      `reward. Press **🗃️ Items** for the full per-category price list.\n\n` +
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
    new ButtonBuilder().setCustomId("hm_shop_items").setLabel("🗃️ Items").setStyle(ButtonStyle.Primary),
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

  const rankLadder = RANK_TIERS.map((t) => `${t.name} — ${t.xpNeeded.toLocaleString()} XP`).join(" • ");

  // Every page here is content, not UI — the guide channel is read-only, so
  // there's nothing to click on any of these. The whole point of this guide
  // is that a brand new member can read it start to finish and never have to
  // guess at a single step, number, or edge case anywhere in the system.
  const sections = [
    {
      short: "The Basics",
      title: "📖 What Is Honour Marks?",
      body:
        `**Honour Marks** is this clan's optional quest-and-reward system, layered on top of OSRS itself. You do ` +
        `something in-game (train a skill, kill a boss, clear a raid, finish a minigame), tell the bot you're done, ` +
        `and it checks the **real OSRS hiscores** for your linked account to confirm it actually happened. Every ` +
        `quest you finish pays out two completely separate things at the same time:\n\n` +
        `${HM_EMOJI} **Honour Marks (HM)** — a spendable currency. It does nothing by itself; it just sits in your ` +
        `balance until you spend it in the Shop. It is **not** part of your clan rank.\n\n` +
        `🏅 **Rank XP** — a small amount of progress toward your actual clan rank, the one shown on the member ` +
        `list by Heimdall (the other bot). This runs *alongside* the XP you earn automatically just from being a ` +
        `member over time (tenure XP) — the two add together for your total, but neither affects how the other ` +
        `is earned.\n\n` +
        `Nothing here is required. Your clan rank still climbs on its own from tenure alone even if you never ` +
        `touch a single quest — this whole system is a bonus for people who want extra rewards for playing.\n\n` +
        `**This guide is long on purpose** — it's meant to answer every question before you have to ask it, from ` +
        `your very first click to the exact numbers behind every quest type. What's in it, in order:\n` +
        `1. The Basics (this page) • 2. Your First 10 Minutes • 3. Solo Quests In Detail • ` +
        `4. Boss PvM, Raids & Minigames Explained • 5. Team Quests Step By Step • ` +
        `6. Looking For Group Step By Step • 7. Checking Progress & Collecting Rewards • ` +
        `8. Shop: Perks • 8b. Shop: Items • 9. Boss PvM Safety Check • 10. Weighted Skill Rolls • ` +
        `11. Shop: Boosts • 12. Shop: Consumables • 13. Your Inventory • ` +
        `14. How This Affects Your Clan Rank • 15. Commands & Where To Look Things Up • ` +
        `16. Troubleshooting & FAQ.\n\n` +
        `If you only read one more page right now, make it the next one.`,
    },
    {
      short: "Getting Started",
      title: "🚀 Step 1: Your First 10 Minutes",
      body:
        `**Step 1 — Claim the role.** Go to ${claimCh} and press **🎖️ Claim Role**. This instantly unlocks ` +
        `${questsCh} (the quest board), ${shopCh} (the shop) and ${dbCh} (everyone's stats) — you can't see or ` +
        `use any of them beforehand. Changed your mind later? Press **✅ Drop Role** in that same channel any ` +
        `time; nothing you've earned is ever lost, it just hides the channels again until you claim it back.\n\n` +
        `**Step 2 — Link your RuneScape account.** Type \`/register\` anywhere in the server and fill in your ` +
        `exact in-game name. This is required and deliberately separate from your Discord nickname — nicknames ` +
        `can be changed, denied, or shared with someone else, so the bot needs your real RSN to know whose ` +
        `hiscores to check. \`/register\` immediately looks your name up on the real OSRS hiscores before saving ` +
        `it, so:\n` +
        `• Spell it **exactly** right — capitalization doesn't matter, but spacing and special characters do.\n` +
        `• Your hiscores profile must **not** be set to private, or the lookup fails and registration is refused.\n` +
        `• One RuneScape account per Discord account.\n\n` +
        `**Step 3 — Start your first quest.** Open ${questsCh} and press **📋 Start a Solo Quest**. You'll be ` +
        `asked to pick a length (Daily, Weekly or Monthly) and then a category (Gathering, Production, Combat, ` +
        `Utility, Boss PvM, Raids or Minigames). The moment you confirm, the bot reads your hiscores **right ` +
        `now** and saves that as your "baseline" — only progress made *after* this exact moment counts, so ` +
        `starting a quest with 1,000 Zulrah kills already banked doesn't give you a head start on a fresh one.\n\n` +
        `**Step 4 — Just play.** There's nothing else to click, no tracker to keep open. Play OSRS completely ` +
        `normally.\n\n` +
        `**Step 5 — Come back and press ✅ Check Quests & Collect.** This is the one manual step in the whole ` +
        `system — the bot does **not** watch you live, it only checks your hiscores the moment you press this ` +
        `button. Press it as often as you like with zero downside; if you've hit the target it pays you right ` +
        `then, and if you haven't it just shows your current percentage.\n\n` +
        `That's genuinely the entire loop. Everything from here on is detail on exactly how each piece works.`,
    },
    {
      short: "Solo Quests",
      title: "📜 Step 2: Solo Quests, In Detail",
      body:
        `You can hold **one Daily, one Weekly, and one Monthly solo quest at the same time** — they don't compete ` +
        `with each other, and each can be in a different category if you want. As soon as a slot is completed or ` +
        `cancelled, you can immediately start a new quest of that same type.\n\n` +
        `**Durations**, counted from the moment you start (not from any clock reset): Daily = 1 day, ` +
        `Weekly = 7 days, Monthly = 30 days.\n\n` +
        `**Picking a target.** After you choose a category, the bot normally rolls a random skill or boss from ` +
        `it for you. If you own a 🎯 Quest Choice Token (Page 10), you'll instead be offered a choice between ` +
        `hand-picking the exact target yourself or rolling randomly anyway.\n\n` +
        `**Exact requirements**, by category type and length — when a quest needs more than one target, EACH ` +
        `one individually needs the full amount shown below; they are never split or added together:\n\n` +
        `**Skill categories** (Gathering, Production, Combat, Utility) — gain this much XP in one skill ` +
        `(two *different* skills for Monthly):\n` +
        `• Daily — 1 skill, 20,000 XP • Weekly — 1 skill, 75,000 XP • Monthly — 2 skills, 150,000 XP **each**\n\n` +
        `**Boss PvM** — kill count on one boss (see Page 4 for which ones are possible):\n` +
        `• Daily — 15 KC • Weekly — 40 KC • Monthly — 100 KC\n\n` +
        `**Raids** — clears of one raid (any difficulty mode counts the same):\n` +
        `• Daily — 3 clears • Weekly — 8 clears • Monthly — 20 clears\n\n` +
        `**Minigames** — completions of one minigame:\n` +
        `• Daily — 5 completions • Weekly — 15 completions • Monthly — 40 completions\n\n` +
        `**Rewards** (flat — a Perk can raise the HM, see Page 8):\n` +
        `• Daily — 50 ${HM_EMOJI} + 100 Rank XP • Weekly — 150 ${HM_EMOJI} + 250 Rank XP • ` +
        `Monthly — 400 ${HM_EMOJI} + 750 Rank XP\n\n` +
        `**If time runs out before you finish**, the quest is removed automatically with no penalty beyond ` +
        `losing the slot. You still get paid ${HM_EMOJI} HM for the percentage of the target you actually ` +
        `reached (e.g. 40% progress = 40% of the HM reward, rounded), but **zero Rank XP** — Rank XP only pays ` +
        `out for a quest you actually finish in time.`,
    },
    {
      short: "Boss, Raids & Minigames",
      title: "🦴 Step 3: Boss PvM, Raids & Minigames Explained",
      body:
        `**Boss PvM quests** are assigned from a pool of farmable, non-slayer-locked bosses — starting one rolls ` +
        `ONE of these at random (or you hand-pick it with a Quest Choice Token):\n\n` +
        `Commander Zilyana, General Graardor, Kree'Arra, K'ril Tsutsaroth, Callisto, Artio, Venenatis, Spindel, ` +
        `Vet'ion, Calvar'ion, Chaos Elemental, Chaos Fanatic, King Black Dragon, Scorpia, Duke Sucellus, The ` +
        `Leviathan, The Whisperer, Vardorvis, Zulrah, Vorkath, Phantom Muspah, Nex, Corporeal Beast, Kalphite ` +
        `Queen, Giant Mole, Sarachnis, Scurrius, Zalcano, Barrows Chests, Lunar Chests, Obor, Bryophyta, Crazy ` +
        `Archaeologist, Deranged Archaeologist, Amoxliatl, Doom of Mokhaiotl, The Hueycoatl, The Royal Titans, ` +
        `Mad Angel, Maggot King, Yama, TzTok-Jad (the regular Fight Caves), The Nightmare, The Gauntlet, and ` +
        `Dagannoth Kings.\n\n` +
        `**Three of those are "grouped" targets** — killing ANY of the variants counts toward the same total, ` +
        `you never need to split kills between them:\n` +
        `• **Dagannoth Kings** — Prime, Rex, and Supreme all count together.\n` +
        `• **The Gauntlet** — the normal Gauntlet and the Corrupted Gauntlet count together.\n` +
        `• **The Nightmare** — The Nightmare and Phosani's Nightmare count together.\n\n` +
        `**Never randomly assigned** — too slayer-locked, one-time, or swingy for a fair timed quest. Killing ` +
        `these is never wasted effort for your own OSRS goals, they just never count toward a Boss PvM quest: ` +
        `Abyssal Sire, Alchemical Hydra, Araxxor, Cerberus, Grotesque Guardians, Kraken, Shellbane Gryphon, ` +
        `Thermonuclear Smoke Devil, Skotizo, Hespori, Mimic, Sol Heredit (Fortis Colosseum), and TzKal-Zuk (the ` +
        `Inferno) — note that regular TzTok-Jad (the Fight Caves) IS in the pool above; it's only the Inferno ` +
        `version that's excluded.\n\n` +
        `**Raids** are always one of Chambers of Xeric, Theatre of Blood, or Tombs of Amascut. Any difficulty ` +
        `mode (Normal, Challenge Mode / Hard Mode / Expert Mode) counts identically toward the same clear count.\n\n` +
        `**Minigames** are rolled from: Guardians of the Rift, Wintertodt, Tempoross, Soul Wars, and Last Man ` +
        `Standing. One completion = one full round, as counted by the OSRS hiscores for that activity.\n\n` +
        `All of this applies to BOTH solo and team quests — team quests draw from exactly the same pools, just ` +
        `with higher combined targets split across more people (Page 5).`,
    },
    {
      short: "Team Quests",
      title: "👥 Step 4: Team Quests, Step By Step",
      body:
        `A team quest (Duo, Trio, or Quad) shares ONE target across the whole group — everyone's gains are ` +
        `summed together, so it finishes faster the more people are pulling their weight. It always runs for ` +
        `**14 days** regardless of size, and pays **every member the full reward**, not a split share.\n\n` +
        `**Starting one, step by step:**\n` +
        `1. Open ${questsCh} and press **👥 Start a Team Quest**.\n` +
        `2. Pick a size: **Duo** (2 people total), **Trio** (3 people total), or **Quad** (4 people total). You ` +
        `count as the first member either way.\n` +
        `3. Pick a category — the same seven choices as solo quests.\n` +
        `4. Choose how to fill the rest of the team:\n` +
        `　• **Pick Teammates** — a member picker opens where you select the exact number of other people ` +
        `needed (1 for Duo, 2 for Trio, 3 for Quad). Everyone picked must already be registered with ` +
        `\`/register\`, or it fails to create. The quest starts **immediately** once confirmed.\n` +
        `　• **📋 Post Open Listing** — skips picking anyone; instead it posts a public listing to the ` +
        `**Looking For Group** board (Page 6) and starts automatically once enough other members join it.\n\n` +
        `**Requirements**, by category and size — the team's combined gains must reach the full amount on ` +
        `EACH target listed, same "never split or summed together across targets" rule as solo quests:\n\n` +
        `**Skill categories** — Duo picks 2 skills (135,000 XP combined, each) • Trio picks 3 skills (200,000 ` +
        `XP combined, each) • Quad picks 4 skills (270,000 XP combined, each).\n` +
        `**Boss PvM** — Duo picks 1 boss (150 combined KC) • Trio picks 2 bosses (250 combined KC each) • ` +
        `Quad picks 3 bosses (350 combined KC each).\n` +
        `**Raids** — always 1 raid: Duo needs 15 combined clears • Trio needs 30 • Quad needs 45.\n` +
        `**Minigames** — Duo picks 1 minigame (50 combined) • Trio picks 2 (125 combined each) • Quad picks 3 ` +
        `(200 combined each).\n\n` +
        `**Rewards per member** (everyone gets the full amount, it is NOT split between you):\n` +
        `• Duo — 250 ${HM_EMOJI} + 750 Rank XP • Trio — 350 ${HM_EMOJI} + 1,200 Rank XP • ` +
        `Quad — 450 ${HM_EMOJI} + 2,000 Rank XP\n\n` +
        `A team quest that runs out of time is simply cancelled for everyone — unlike solo quests there is no ` +
        `partial HM payout, and no one can cancel it early themselves (a Skip Token only works on solo quests).`,
    },
    {
      short: "Looking For Group",
      title: "🔍 Step 5: Looking For Group, Step By Step",
      body:
        `The **Looking For Group** board is a second panel posted right under the quest board. It lists every ` +
        `team quest that's currently recruiting, with the category, size, and who's already joined.\n\n` +
        `**Posting a listing, step by step:**\n` +
        `1. Press **👥 Start a Team Quest** → pick a size → pick a category, exactly like a normal team quest.\n` +
        `2. On the "how do you want to fill it" screen, press **📋 Post Open Listing** instead of Pick Teammates.\n` +
        `3. You're now the first member of an open listing, and it appears on the LFG board immediately.\n` +
        `4. You can only have **one** open listing — or be a member of one — at a time, whether posting or ` +
        `joining. Cancel or complete one before starting or joining another.\n\n` +
        `**Joining a listing, step by step:**\n` +
        `1. Open the LFG board and use the **"Join an open team…"** dropdown.\n` +
        `2. Pick the listing you want — each option shows the category, size, and how many of its slots are ` +
        `already filled.\n` +
        `3. You're added immediately. If that was the last empty slot, the quest **starts automatically for ` +
        `every member right then** — no extra confirmation step, and everyone gets a private confirmation ` +
        `message. If it still needs more people, you'll just see how many more are needed and the listing ` +
        `stays open for others to join.\n\n` +
        `**Expiry.** An open listing that never fills disappears after **24 hours**. Nothing is lost — whoever ` +
        `posted it can simply post again.\n\n` +
        `**Cancelling early.** Press **❌ Cancel My Listing** on the LFG board any time before it fills. This ` +
        `only cancels a listing YOU personally posted.\n\n` +
        `Once a listing converts into a real quest, it behaves exactly like any other team quest from Page 4 — ` +
        `same rewards, same 14-day duration, checked and collected the exact same way.`,
    },
    {
      short: "Checking & Collecting",
      title: "✅ Step 6: Checking Progress & Collecting Rewards",
      body:
        `**✅ Check Quests & Collect** on the quest board is the one button that handles everything after ` +
        `you've started a quest:\n` +
        `1. It re-reads your hiscores right now.\n` +
        `2. For every active solo quest you have, it shows an embed with your current percentage toward each ` +
        `target.\n` +
        `3. Any quest whose target has been fully met is paid out — ${HM_EMOJI} HM and Rank XP — immediately, ` +
        `and removed.\n` +
        `4. If you're on a team quest, it also shows the whole team's combined progress (and pays everyone out ` +
        `if the team just finished).\n` +
        `5. If you own any 🎫 Quest Skip Tokens AND have an active solo quest, cancel buttons appear underneath ` +
        `so you can scrap a quest you don't want anymore (Page 10).\n\n` +
        `**How the percentage is calculated.** If a quest only has one target, the percentage shown is simply ` +
        `your progress toward it. If it has more than one target (e.g. a Monthly skill quest needs 2 skills), ` +
        `the percentage is the **average** across all of them — a quest only actually finishes once **every ` +
        `single target** individually hits 100%, so "75%" could mean one target is fully done and another is ` +
        `only half-way, not that you're three-quarters done evenly across both.\n\n` +
        `**Pressing Check costs nothing** and has no cooldown or limit — press it as often as you like, it ` +
        `simply does nothing extra if nothing has changed since last time.\n\n` +
        `**What if a quest's timer runs out before you press Check?** It's removed automatically by a background ` +
        `check that runs every few minutes — you don't need to notice it yourself. You're paid ${HM_EMOJI} HM ` +
        `for whatever percentage you'd reached (partial credit), but **zero Rank XP** either way.`,
    },
    {
      short: "Shop: Perks",
      title: "🎖️ Step 7: The Shop — Perks, Step By Step",
      body:
        `A **Perk** is a **permanent** upgrade to one quest category — once bought it never expires, is never ` +
        `used up, and can't be sold back. It makes every quest you finish in that one category pay more ` +
        `${HM_EMOJI} HM, forever. It does **nothing** to Rank XP, and a perk in one category has zero effect on ` +
        `any other category.\n\n` +
        `**5 tiers, bought in order** — you can't skip ahead, each purchase buys the next tier up from whatever ` +
        `you already own:\n` +
        `• Tier 1 — 1,750 HM → +5% HM\n• Tier 2 — 10,062 HM → +10% HM\n• Tier 3 — 24,150 HM → +15% HM\n` +
        `• Tier 4 — 48,300 HM → +20% HM\n• Tier 5 — 100,625 HM → +25% HM (maximum)\n\n` +
        `**Step by step — buying one:**\n` +
        `1. Open ${shopCh} and press **🎖️ Perks**.\n` +
        `2. A dropdown lists every category you haven't maxed out yet, showing its next tier's cost.\n` +
        `3. Pick one — it's bought **immediately** if you can afford it. There's no confirmation step after ` +
        `that, so make sure you picked the right category.\n` +
        `4. The upgrade applies instantly and automatically to every quest you finish in that category from ` +
        `then on — there's nothing to activate.\n\n` +
        `Perks stack separately per category — you could, for example, max out Combat (+25%) while owning ` +
        `nothing at all in Gathering.`,
    },
    {
      short: "Shop: Items",
      title: "🗃️ Step 7b: The Shop — Items, Step By Step",
      body:
        `**Items** are also **permanent**, like Perks, but each one changes something different about how a ` +
        `quest actually works instead of just paying more ${HM_EMOJI} HM. Every category has all **3 slots**, ` +
        `**3 tiers each**, bought in order, 9 purchases total per category:\n\n` +
        `**📉 Slot 1 — Quest & Threshold Reduction** — lowers the XP/KC/clears/completions a quest in that ` +
        `category asks for: -2% at T1, -5% at T2, -10% at T3. Prices: 600 / 1,400 / 5,000 HM.\n\n` +
        `**💬 Slot 2 — Clan Chat XP Bonus** — raises the **Rank XP** (not HM — that's what Perks already do) a ` +
        `quest in that category pays: +2% / +5% / +10%. Prices: 900 / 1,750 / 10,062 HM.\n\n` +
        `**📜 Slot 3 — Quest Expansion** — for Gathering, Production, Combat, Utility and Boss PvM, this adds ` +
        `extra full-requirement targets: T1 adds 1 (2 total), T2 adds 2 (3 total), T3 adds 3 (4 total) — each ` +
        `extra target needs the FULL normal requirement, same as any other target. For Raids and Minigames, ` +
        `which only ever have one target, it instead adds +2% / +5% / +10% to that single target's requirement. ` +
        `Either way, the quest's ${HM_EMOJI} HM and Rank XP pay out **exactly proportionally** more for the ` +
        `extra work — a 4-target Quest Expansion skill quest pays 4× what a normal 1-target quest of the same ` +
        `length pays, never a diminished rate. Prices: Gathering/Production/Combat/Utility/Boss PvM — ` +
        `5,000 / 15,000 / 35,000 HM. Raids/Minigames — 2,000 / 6,000 / 18,000 HM.\n\n` +
        `**Buying one:** open ${shopCh}, press **🗃️ Items**, and pick a purchase from the dropdown — it shows ` +
        `every slot across every category you haven't maxed, with its next tier's cost and effect. It's bought ` +
        `**immediately** if you can afford it, with no confirmation step.\n\n` +
        `**Team quests:** every Item (and Perk) you own applies automatically to any team quest you're on in ` +
        `that category too, and stacks with what your teammates own — if two of you each own +5% Clan Chat XP ` +
        `Bonus in Combat, the team quest pays +10% total. The one exception is Quest Expansion's EXTRA-TARGET ` +
        `(not percentage) effect on skill/Boss PvM categories — a team uses whichever single member owns the ` +
        `**highest** tier, not everyone's added together, so a 4-person team can't stack up to an unreasonable ` +
        `16 required targets from one purchase each.\n\n` +
        `A Boss PvM Quest Expansion item also interacts with the boss safety check (next page) — if there ` +
        `aren't enough safe bosses to fill every extra target it asks for, you'll still get however many are ` +
        `safe, each needing proportionally more kills instead, so the total grind and reward stay the same.`,
    },
    {
      short: "Boss Safety Check",
      title: "🛡️ How The Boss PvM Safety Check Works",
      body:
        `A random Boss PvM roll used to have zero regard for whether you could actually survive the fight — a ` +
        `brand-new account could get assigned Nex. This is the fix: the bot filters the boss pool down to ones ` +
        `your (or your whole team's) current stats can reasonably handle before rolling.\n\n` +
        `**How a boss qualifies for the random roll.** Each boss on the list has rough, community-sourced ` +
        `"recommended stats" (hitpoints, defence, prayer, and an attack style requirement). You qualify for a ` +
        `boss if **either**:\n` +
        `• your current hiscores stats clear every one of its recommended numbers, **or**\n` +
        `• you already have **any prior kill count** on it at all — proof you've already done it, regardless of ` +
        `what the recommendation says.\n\n` +
        `**Team quests** need **every single member** to individually qualify for a boss before it can be ` +
        `assigned — one under-levelled teammate is enough to rule a boss out for the whole group.\n\n` +
        `**If not enough bosses qualify.** Say a quest (or a Tier-3 Quest Expansion item) wants 4 Boss PvM ` +
        `targets but only 2 bosses are actually safe for everyone involved — you still get exactly those 2, ` +
        `just with the required kill count on each doubled, so the total expected grind (and the reward it ` +
        `pays) comes out the same as a full 4-target quest would have. If literally **nothing** on the whole ` +
        `list is safe yet, you still get exactly one boss — whichever has the lowest requirements overall — ` +
        `with its KC scaled up to cover the full target count by itself, rather than the quest failing to ` +
        `generate at all.\n\n` +
        `**This entire check is skipped for a hand-picked target.** If you spend a 🎯 Quest Choice Token to ` +
        `pick your own boss, that's an informed, intentional choice — the safety check never overrides or ` +
        `blocks it, even if your stats don't technically meet the recommendation.`,
    },
    {
      short: "Weighted Skill Rolls",
      title: "🎲 How Random Skill Rolls Are Weighted",
      body:
        `Random skill-quest rolls (Gathering, Production, Combat, Utility) don't pick with flat equal odds ` +
        `across every skill in the category — **lower-level skills are weighted to come up more often**, so ` +
        `the bot stops repeatedly handing you a skill you've already maxed while the one you actually still ` +
        `need to train almost never gets rolled.\n\n` +
        `**The rough idea:** a skill's chance of being picked goes up the lower its level is. A level 1 skill ` +
        `is roughly 99 times as likely to be picked as a level 99 skill in the same category — but a maxed, ` +
        `level 99 skill still always has a small, genuinely nonzero chance of coming up. It's never fully ` +
        `excluded, it's just rare.\n\n` +
        `**Quests needing more than one skill** (a Monthly quest, or a Quest Expansion item asking for extra ` +
        `targets) roll each pick without repeats, still favouring whichever skills are lowest among whatever ` +
        `hasn't been picked yet for that quest.\n\n` +
        `**Team quests** weight each candidate skill by whichever team member's level in it is the **lowest** ` +
        `— so the roll favours training that's useful to the team as a whole, not just whoever's furthest ` +
        `behind on average.\n\n` +
        `**This weighting is skills only.** Boss PvM, Raids and Minigame rolls are unaffected — those are ` +
        `governed by the boss safety check (previous page) and plain random choice, respectively.\n\n` +
        `**Hand-picking with a 🎯 Quest Choice Token completely bypasses this** — once you're choosing your own ` +
        `target, there's nothing left to weight; every valid option in the category is shown and selectable.`,
    },
    {
      short: "Shop: Boosts",
      title: "⚡ Step 8: The Shop — Boosts, Step By Step",
      body:
        `A **Boost** is a **temporary multiplier on the Rank XP** a finished quest pays — it does **nothing** to ` +
        `${HM_EMOJI} HM, and it does **nothing** for a quest that expires instead of finishing. It only applies ` +
        `to quests in the one category you bought it for.\n\n` +
        `**3 tiers:**\n` +
        `• T1 — 750 HM → 1.5× Rank XP for 1 week\n• T2 — 2,250 HM → 2.0× Rank XP for 2 weeks\n` +
        `• T3 — 7,500 HM → 2.5× Rank XP for 1 week\n\n` +
        `**Step by step — buying and using one:**\n` +
        `1. Open ${shopCh} and press **⚡ Boosts**.\n` +
        `2. Pick a category + tier combination from the dropdown. It's bought immediately and placed in your ` +
        `**Inventory** — buying it does **not** start the clock.\n` +
        `3. When you're ready to actually use it, press **🎒 Inventory** (also in the shop channel).\n` +
        `4. Use the **"Activate a boost…"** dropdown to pick the one you want to start. The moment you activate ` +
        `it, the timer begins counting down for real.\n` +
        `5. From then until it expires, every quest you **finish** (not one that times out) in that category ` +
        `pays Rank XP multiplied by the boost's number — e.g. a normal 250 Rank XP Weekly quest under a 2.0× ` +
        `boost pays 500 instead.\n\n` +
        `**Buy ahead, activate when it matters.** There's no reason not to buy a boost the moment you have the ` +
        `HM for it, since it sits safely in your inventory doing nothing until you switch it on — line it up ` +
        `with a week you know you'll be grinding.\n\n` +
        `If you somehow have two active boosts for the same category at once, only the **stronger** one applies ` +
        `— they don't add together.`,
    },
    {
      short: "Shop: Consumables",
      title: "🎫 Step 9: The Shop — Consumables, Step By Step",
      body:
        `Consumables are **one-time use** — buying one just adds it to your **Inventory**, and it's spent the ` +
        `moment you actually use it. Buying it alone does nothing by itself.\n\n` +
        `**🎫 Quest Skip Token — 4 HM.** Instantly cancels one active **solo** quest. No reward, no penalty — ` +
        `it disappears and that slot is immediately free for a new quest. Doesn't work on team quests.\n` +
        `Step by step:\n` +
        `1. Buy it from **🎫 Consumables** in ${shopCh}.\n` +
        `2. Go to the quest board and press **✅ Check Quests & Collect**.\n` +
        `3. A red **❌ Cancel [type]** button appears under the results for each active solo quest, as long as ` +
        `you own at least one token.\n` +
        `4. Press it to cancel that specific quest. If the cancel attempt itself somehow fails (the quest ` +
        `already finished or expired a moment earlier), your token is **automatically refunded** — you never ` +
        `lose one for nothing.\n\n` +
        `**🎯 Quest Choice Token — 50 HM.** Lets you hand-pick the exact skill or boss for your NEXT solo quest ` +
        `instead of letting the bot roll one at random.\n` +
        `Step by step:\n` +
        `1. Buy it from **🎫 Consumables**.\n` +
        `2. Start a new solo quest as normal (Start a Solo Quest → pick length → pick category).\n` +
        `3. Because you own a token, you'll be shown a choice: **🎯 Hand-pick (uses token)** or ` +
        `**🎲 Random (keep token)**.\n` +
        `4. Hand-pick opens a dropdown of every valid skill/boss for that category and length — select exactly ` +
        `as many as the quest needs (usually 1, sometimes 2 for a Monthly skill quest) and confirm.\n` +
        `5. Pressing Random instead keeps the token untouched for later — it's only spent if you actually use ` +
        `it to pick.\n` +
        `6. If the quest fails to create for any reason after you've spent the token (you already had one of ` +
        `that type, you'd already used that slot this period, a hiscores read failed, etc.), the token is ` +
        `**automatically refunded** and the error message confirms it.\n\n` +
        `Both tokens stack — you can own several of either at once.`,
    },
    {
      short: "Your Inventory",
      title: "🎒 Step 10: Your Inventory, Step By Step",
      body:
        `Press **🎒 Inventory** (in ${shopCh}) any time to see everything you currently hold, split into four ` +
        `sections:\n` +
        `• **Perks** — your current tier in every category you own one in.\n` +
        `• **Boosts owned** — boosts you've bought but not yet activated, sitting ready to go.\n` +
        `• **Consumables** — how many Skip Tokens and Choice Tokens you currently have.\n` +
        `• **Active boosts** — any boost currently running, and exactly when it expires.\n\n` +
        `If you own at least one un-activated boost, a dropdown appears at the bottom labelled **"Activate a ` +
        `boost…"** — pick one to start its timer (see Page 9 for exactly what that does).\n\n` +
        `Your balance (${HM_EMOJI} HM) is shown at the top of this same screen. You can also check it any time ` +
        `with \`/hm balance\` without opening Inventory at all.`,
    },
    {
      short: "Rank & XP",
      title: "🏅 How Any Of This Affects Your Clan Rank",
      body:
        `This system touches your **clan rank** in exactly one way: **Rank XP**, awarded for FINISHING a quest ` +
        `(never for a partial/expired one). It is completely separate from ${HM_EMOJI} Honour Marks, which only ` +
        `buys things in the Shop and has zero effect on rank.\n\n` +
        `**How your total rank XP is calculated:** \`rank XP = tenure XP + bonus XP\`\n` +
        `• **Tenure XP** — earned automatically just by being a member over time. Keeps accumulating whether or ` +
        `not you ever touch a quest.\n` +
        `• **Bonus XP** — everything this bot pays out: every quest completion (and any boosted amount from an ` +
        `active Boost).\n` +
        `These two numbers are simply added together — nothing here multiplies, replaces, or interferes with ` +
        `your tenure XP, and tenure XP doesn't change how quest Rank XP is earned either.\n\n` +
        `**Exactly how much Rank XP each quest pays**, before any Boost multiplier:\n` +
        `• Solo Daily — 100 • Solo Weekly — 250 • Solo Monthly — 750\n` +
        `• Team Duo — 750 (per member) • Team Trio — 1,200 (per member) • Team Quad — 2,000 (per member)\n\n` +
        `A Boost only ever multiplies the quest's own Rank XP number above — it never touches tenure XP, and ` +
        `it's capped at whichever single boost is strongest if you somehow have more than one active for the ` +
        `same category (Page 9).\n\n` +
        `**The full rank ladder**, in order — the same one Heimdall shows on the member list:\n${rankLadder}`,
    },
    {
      short: "Commands",
      title: "🗒️ Step 11: Commands & Where To Look Things Up",
      body:
        `**\`/register <rsn>\`** — links your RuneScape name to your Discord account. Required before you can do ` +
        `anything else. Staff can register someone else on their behalf with the optional \`member\` option.\n\n` +
        `**\`/hm balance [member]\`** — shows your own ${HM_EMOJI} HM balance, or someone else's if you give the ` +
        `optional \`member\` option.\n\n` +
        `**\`/hm give\` and \`/hm take\`** — staff-only, used to manually adjust a member's HM balance with a ` +
        `logged reason. If your balance looks wrong, ask a staff member to check the log rather than trying ` +
        `these yourself — they won't work for a regular member anyway.\n\n` +
        `**\`/hm refresh\`** — forces every Honour Marks panel (quest board, LFG board, shop, database, this ` +
        `guide) to redraw immediately instead of waiting for the next automatic refresh. Handy if something ` +
        `looks out of date.\n\n` +
        `**${dbCh}** — a read-only, live-updating leaderboard showing every registered member's balance and ` +
        `quest completion counts at a glance. It updates automatically as people complete quests; you don't ` +
        `need to do anything special to appear on it beyond registering and finishing at least one quest.\n\n` +
        `**Every Honour Marks channel is read-only for humans** — you can't post, start a thread, or react in ` +
        `${questsCh}, ${shopCh}, ${dbCh}, or this guide channel. Every single action in this whole system ` +
        `happens through a button or dropdown on a panel, never by typing in the channel.`,
    },
    {
      short: "FAQ",
      title: "❓ Step 12: Troubleshooting & Frequently Asked Questions",
      body:
        `**"\`/register\` says it can't find my hiscores."** Your profile is probably set to private on the OSRS ` +
        `hiscores, or your RSN is spelled slightly wrong (extra space, wrong character, etc). Double-check both ` +
        `and try again.\n\n` +
        `**"I started a quest but my existing boss KC / skill XP didn't count."** That's intentional — only ` +
        `progress made AFTER you start the quest counts. The bot snapshots your hiscores the instant you ` +
        `confirm a quest as your "baseline"; anything before that moment doesn't count toward it.\n\n` +
        `**"Can I change a quest's category or length after starting it?"** No — cancel it (with a Skip Token, ` +
        `for a solo quest) and start a fresh one instead. A team quest can't be cancelled by anyone once started.\n\n` +
        `**"Why do I need to press Check Quests & Collect — can't it just pay me automatically?"** The bot ` +
        `deliberately doesn't watch your hiscores continuously, it only reads them when you ask, to keep ` +
        `hiscores lookups reasonable. There's no downside to pressing it often — do it whenever you remember.\n\n` +
        `**"My quest expired and I only got partial HM — where's the rest?"** By design. An expired (not ` +
        `finished) quest pays HM proportional to how close you got, and zero Rank XP, as a consolation rather ` +
        `than the full reward — only finishing the actual target in time pays everything.\n\n` +
        `**"Can I post two open Looking For Group listings at once, or join two?"** No — you can only be the ` +
        `poster of one open listing, or a joined member of one, at any given time. Cancel or complete one ` +
        `before starting or joining another.\n\n` +
        `**"I joined an open team listing but nothing happened."** Nothing happens until the LAST slot fills — ` +
        `you'll see how many more people are needed. The moment the final slot fills, it converts into a real ` +
        `quest automatically for everyone in it.\n\n` +
        `**"Does a Boost affect my HM, or a quest that times out?"** No to both — a Boost ONLY multiplies Rank ` +
        `XP, and ONLY for a quest you actually finish. Zero effect on Honour Marks or on an expired quest.\n\n` +
        `**"I bought a Quest Choice Token / Skip Token but it got used for nothing."** It shouldn't — both are ` +
        `automatically refunded if the action you tried to use them for fails. If you believe one was lost ` +
        `anyway, bring it to a staff member with the details so they can check the log.\n\n` +
        `**"Where do I see everyone else's progress?"** The quest board lists every currently active solo and ` +
        `team quest clan-wide, and ${dbCh} shows a running leaderboard of completions and balances for every ` +
        `registered member.\n\n` +
        `Still stuck on something this guide didn't cover? Ask in the server — if it comes up more than once, ` +
        `it probably belongs on this page.`,
    },
  ];

  return sections.map((s, i) => ({
    embed: new EmbedBuilder()
      .setColor(COLOR.gold)
      .setTitle(s.title)
      .setDescription(s.body.slice(0, DESC_BUDGET))
      .setFooter({ text: `Odinheim • Honour Marks — Page ${i + 1}/${sections.length}: ${s.short}` }),
    components: [],
  }));
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
  renderDatabase, renderQuestBoard, renderShop, renderOpenTeams, emptyPage,
  getPanelLedger, syncPanel,
  getRankForXp, formatRankProgress,
  getConfigValue, setConfigValue,
};
