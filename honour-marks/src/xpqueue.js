"use strict";
const crypto = require("crypto");
const { getSupabase } = require("./db");
const { config } = require("./config");

/**
 * Quest Rank XP leaves this bot through exactly one door: an INSERT into
 * `pending_rank_xp`. We never write clan_members.xp.
 *
 * Why: Heimdall recomputes `tenure_xp` from the join date on every sync and
 * writes `xp = tenure_xp + bonus_xp`. Anything this bot wrote straight into
 * clan_members.xp would be overwritten within 30 minutes. The queue makes the
 * award durable, retry-safe, and single-owner.
 *
 * `idempotency_key` is derived from what actually happened (member + reason +
 * a caller-supplied discriminator), so a retried interaction can't double-pay.
 */

function makeIdempotencyKey(userId, eventKey, discriminator) {
  const raw = `${userId}:${eventKey}:${discriminator}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

/**
 * Queues flat Rank XP for a member.
 * @returns {{ok: boolean, amount: number, duplicate?: boolean}}
 */
async function awardRankXp({ guildId, userId, rsn, eventKey, reason, discriminator }) {
  const amount = Number(config.rankXp[eventKey]) || 0;
  if (!userId || amount <= 0) return { ok: true, amount: 0 };

  const supabase = getSupabase();
  if (!supabase) return { ok: false, amount: 0 };

  const idempotencyKey = makeIdempotencyKey(userId, eventKey, discriminator || Date.now());

  try {
    const { error } = await supabase.from("pending_rank_xp").insert({
      guild_id: guildId,
      user_id: userId,
      rsn: rsn || null,
      amount,
      reason: reason || eventKey,
      event_key: eventKey,
      idempotency_key: idempotencyKey,
    });

    if (error) {
      // 23505 = unique violation = this award already exists. Not an error.
      if (error.code === "23505") return { ok: true, amount, duplicate: true };
      console.error("[XPQueue] insert failed:", error.message);
      return { ok: false, amount: 0 };
    }
    return { ok: true, amount };
  } catch (e) {
    console.error("[XPQueue] insert threw:", e.message);
    return { ok: false, amount: 0 };
  }
}

/** How much unclaimed quest XP a member has waiting. Shown on their panel. */
async function getPendingRankXp(userId) {
  const supabase = getSupabase();
  if (!supabase) return 0;
  const { data } = await supabase
    .from("pending_rank_xp")
    .select("amount")
    .eq("user_id", userId)
    .is("consumed_at", null);
  return (data || []).reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
}

module.exports = { awardRankXp, getPendingRankXp, makeIdempotencyKey };
