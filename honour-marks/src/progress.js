"use strict";
const { getSupabase } = require("./db");
const { fetchHiscores, diffProgress } = require("./jagex");
const {
  getMember, getActiveSoloQuests, creditHm, bumpCounts, awardRankXp,
} = require("./quests");
const { getBoostMultiplier } = require("./shop");

/**
 * Quest completion and expiry.
 *
 * Two awards happen on completion, and they go to different places on purpose:
 *   HM       -> hm_balances (this bot owns it)
 *   Rank XP  -> pending_rank_xp queue (Heimdall owns the ladder)
 *
 * Partial credit pays HM proportional to progress when a quest expires, but
 * NOT Rank XP — Rank XP is only for actually finishing the target. That keeps
 * the rank ladder from being farmed by letting quests lapse.
 *
 * Boosts (bought and activated in the Shop) multiply the Rank XP a FINISHED
 * quest pays out — never the HM, never a partial/expired payout. The active
 * boost for the quest's own tree is read right here, at the moment of
 * completion, and the boosted number is what actually gets queued and what
 * gets written onto the completion row, so #hm-database always shows what a
 * member was actually paid.
 */

function pctOf(targets, baseline, current) {
  return diffProgress(baseline, current, targets).totalPct;
}

/** Evaluates every active solo quest for a member against live hiscores. */
async function checkSoloQuests({ guildId, userId, memberRsn }) {
  const quests = await getActiveSoloQuests(userId);
  if (!quests.length) return { results: [], completed: 0, awardedHm: 0, awardedXp: 0 };

  const snap = await fetchHiscores(memberRsn);
  if (!snap) {
    return { error: "Couldn't read your hiscores just now — try again in a minute.", results: [] };
  }

  const results = [];
  let completed = 0;
  let awardedHm = 0;
  let awardedXp = 0;

  for (const quest of quests) {
    const progress = diffProgress(quest.baseline, snap, quest.targets);
    const finished = progress.finished === true;
    results.push({ quest, progress, finished });

    if (!finished) continue;

    const supabase = getSupabase();
    // Idempotency: delete-then-award would be wrong; instead delete the quest
    // row first, and only award if the delete actually removed something. That
    // makes a double-click on "Check" harmless.
    const { data: deleted, error } = await supabase
      .from("hm_quests")
      .delete()
      .eq("id", quest.id)
      .select("id");

    if (error || !deleted || deleted.length === 0) continue;

    const hm = Number(quest.hm_reward) || 0;
    await creditHm({
      guildId,
      userId,
      amount: hm,
      kind: "quest",
      reason: `${quest.quest_type} ${quest.tree} quest complete`,
      idempotencyKey: `quest:${quest.id}`,
      refId: String(quest.id),
    });

    const boostMultiplier = await getBoostMultiplier(userId, quest.tree);
    const xpResult = await awardRankXp({
      guildId,
      userId,
      rsn: memberRsn,
      eventKey: `quest_solo_${quest.quest_type}`,
      reason: boostMultiplier > 1
        ? `${quest.quest_type} ${quest.tree} quest complete (boosted ${boostMultiplier}×)`
        : `${quest.quest_type} ${quest.tree} quest complete`,
      discriminator: String(quest.id),
      multiplier: boostMultiplier,
    });

    await supabase.from("hm_quest_completions").insert({
      guild_id: guildId,
      user_id: userId,
      quest_type: quest.quest_type,
      tree: quest.tree,
      difficulty: quest.difficulty,
      hm_awarded: hm,
      rank_xp_awarded: xpResult.amount || 0,
      progress_pct: 100,
    });

    await bumpCounts({ guildId, userId, questType: quest.quest_type });

    completed += 1;
    awardedHm += hm;
    awardedXp += xpResult.amount || 0;
  }

  return { results, completed, awardedHm, awardedXp };
}

/** Evaluates one party quest against every member's live hiscores. */
async function checkPartyQuest(quest) {
  const supabase = getSupabase();
  if (!supabase) return { error: "Database unavailable." };

  const perMember = {};
  for (const uid of quest.members) {
    const member = await getMember(uid);
    if (!member?.rsn) return { error: `<@${uid}> has no registered RSN.` };
    const snap = await fetchHiscores(member.rsn);
    if (!snap) return { error: `Couldn't read hiscores for **${member.rsn}**.` };
    perMember[uid] = snap;
    perMember[uid]._rsn = member.rsn;
  }

  // Team progress combines: everyone's gains are summed into one shared total.
  // diffProgress expects one snapshot, so sum the deltas per target first.
  const targets = quest.targets || {};
  const summed = { skills: {}, bosses: {} };

  for (const [skill] of Object.entries(targets.skills || {})) {
    let total = 0;
    for (const uid of quest.members) {
      const base = quest.baseline?.[uid]?.skills?.[skill]?.experience || 0;
      const now = perMember[uid].skills?.[skill]?.experience || 0;
      total += Math.max(0, now - base);
    }
    summed.skills[skill] = total;
  }
  for (const [boss] of Object.entries(targets.bosses || {})) {
    let total = 0;
    for (const uid of quest.members) {
      const base = quest.baseline?.[uid]?.bosses?.[boss]?.kills || 0;
      const now = perMember[uid].bosses?.[boss]?.kills || 0;
      total += Math.max(0, now - base);
    }
    summed.bosses[boss] = total;
  }

  const zero = { skills: {}, bosses: {} };
  const asPseudoSnapshot = { skills: {}, bosses: {} };
  for (const [k, v] of Object.entries(summed.skills)) asPseudoSnapshot.skills[k] = { experience: v };
  for (const [k, v] of Object.entries(summed.bosses)) asPseudoSnapshot.bosses[k] = { kills: v };

  const progress = diffProgress(zero, asPseudoSnapshot, targets);

  return { progress, finished: progress.finished === true, perMember };
}

async function completePartyQuest(quest, progress) {
  const supabase = getSupabase();
  if (!supabase) return { ok: false };

  const { data: deleted, error } = await supabase
    .from("hm_party_quests")
    .delete()
    .eq("id", quest.id)
    .select("id");
  if (error || !deleted || deleted.length === 0) return { ok: false };

  const hm = Number(quest.hm_reward) || 0;
  // Each member can have a different active boost for this tree, so the
  // boosted Rank XP is tracked per member in `rank_xp_breakdown`. One row is
  // written for the whole party AFTER the loop — writing it inside the loop
  // (as this used to) inserted one full-duplicate completion row per member,
  // which made #hm-database and every party total count every quest 2-4x.
  const rankXpBreakdown = {};

  for (const uid of quest.members) {
    const member = await getMember(uid);
    await creditHm({
      guildId: quest.guild_id,
      userId: uid,
      amount: hm,
      kind: "team_quest",
      reason: `${quest.size} ${quest.tree} quest complete`,
      idempotencyKey: `party:${quest.id}:${uid}`,
      refId: String(quest.id),
    });

    const boostMultiplier = await getBoostMultiplier(uid, quest.tree);
    const xpResult = await awardRankXp({
      guildId: quest.guild_id,
      userId: uid,
      rsn: member?.rsn,
      eventKey: `quest_party_${quest.size}`,
      reason: boostMultiplier > 1
        ? `${quest.size} ${quest.tree} quest complete (boosted ${boostMultiplier}×)`
        : `${quest.size} ${quest.tree} quest complete`,
      discriminator: String(quest.id),
      multiplier: boostMultiplier,
    });
    rankXpBreakdown[uid] = xpResult.amount || 0;

    await bumpCounts({ guildId: quest.guild_id, userId: uid, size: quest.size });
  }

  const totalRankXp = Object.values(rankXpBreakdown).reduce((sum, v) => sum + v, 0);

  await supabase.from("hm_party_quest_completions").insert({
    guild_id: quest.guild_id,
    quest_id: quest.id,
    members: quest.members,
    size: quest.size,
    tree: quest.tree,
    difficulty: quest.difficulty,
    completed: true,
    hm_awarded: hm,
    rank_xp_awarded: totalRankXp,
    rank_xp_breakdown: rankXpBreakdown,
  });

  return { ok: true, hm };
}

/**
 * Sweeps expired quests, paying partial HM. Runs on a timer.
 * Rank XP is deliberately NOT awarded for an expired quest.
 */
async function sweepExpiredQuests() {
  const supabase = getSupabase();
  if (!supabase) return { solo: 0, party: 0 };

  const nowIso = new Date().toISOString();
  let soloCount = 0;
  let partyCount = 0;

  // ── Solo ──────────────────────────────────────────────────────────────────
  const { data: expiredSolo } = await supabase
    .from("hm_quests")
    .select("*")
    .lte("expires_at", nowIso);

  for (const quest of expiredSolo || []) {
    const { data: deleted } = await supabase
      .from("hm_quests")
      .delete()
      .eq("id", quest.id)
      .select("id");
    if (!deleted?.length) continue;

    const member = await getMember(quest.user_id);
    let pct = 0;
    if (member?.rsn) {
      const snap = await fetchHiscores(member.rsn);
      if (snap) pct = pctOf(quest.targets, quest.baseline, snap);
    }

    const hm = Math.round(((Number(quest.hm_reward) || 0) * pct) / 100);
    if (hm > 0) {
      await creditHm({
        guildId: quest.guild_id,
        userId: quest.user_id,
        amount: hm,
        kind: "quest_partial",
        reason: `${quest.quest_type} ${quest.tree} expired at ${pct}%`,
        idempotencyKey: `quest_expiry:${quest.id}`,
        refId: String(quest.id),
      });
    }

    await supabase.from("hm_quest_completions").insert({
      guild_id: quest.guild_id,
      user_id: quest.user_id,
      quest_type: quest.quest_type,
      tree: quest.tree,
      difficulty: quest.difficulty,
      hm_awarded: hm,
      rank_xp_awarded: 0,
      progress_pct: pct,
    });

    soloCount += 1;
  }

  // ── Party ─────────────────────────────────────────────────────────────────
  const { data: expiredParty } = await supabase
    .from("hm_party_quests")
    .select("*")
    .lte("expires_at", nowIso);

  for (const quest of expiredParty || []) {
    const { data: deleted } = await supabase
      .from("hm_party_quests")
      .delete()
      .eq("id", quest.id)
      .select("id");
    if (!deleted?.length) continue;

    let pct = 0;
    try {
      const evaluated = await checkPartyQuest(quest);
      if (evaluated?.progress) pct = evaluated.progress.totalPct;
    } catch { /* pay 0 if hiscores are unreachable */ }

    const hm = Math.round(((Number(quest.hm_reward) || 0) * pct) / 100);
    for (const uid of quest.members) {
      if (hm <= 0) continue;
      await creditHm({
        guildId: quest.guild_id,
        userId: uid,
        amount: hm,
        kind: "team_quest_partial",
        reason: `${quest.size} ${quest.tree} expired at ${pct}%`,
        idempotencyKey: `party_expiry:${quest.id}:${uid}`,
        refId: String(quest.id),
      });
    }

    await supabase.from("hm_party_quest_completions").insert({
      guild_id: quest.guild_id,
      quest_id: quest.id,
      members: quest.members,
      size: quest.size,
      tree: quest.tree,
      difficulty: quest.difficulty,
      completed: false,
      hm_awarded: hm,
      rank_xp_awarded: 0,
    });

    partyCount += 1;
  }

  if (soloCount || partyCount) {
    console.log(`[Expiry] Swept ${soloCount} solo and ${partyCount} team quest(s).`);
  }
  return { solo: soloCount, party: partyCount };
}

module.exports = { checkSoloQuests, checkPartyQuest, completePartyQuest, sweepExpiredQuests };
