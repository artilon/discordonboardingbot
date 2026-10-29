"use strict";
const { getSupabase } = require("./db");
const { TREES, TREE_BY_KEY } = require("./quests");

/**
 * Shop, simplified from the original four-track system to three:
 *
 *   Perks      5 tiers per category, permanent, +5% HM each (max +25%)
 *   Boosts     temporary Rank XP multipliers, bought then activated later
 *   Consumables Skip token (cancel a quest) and Choice token (pick the target)
 *
 * The old "Items" track (quest reduction / HM bonus / boost length) is gone —
 * it interacted with perks, boosts and quest targets in ways that made the
 * economy hard to reason about, and it was the least-used of the four.
 */

const PERK_TIERS = [
  { tier: 1, cost: 1750 },
  { tier: 2, cost: 10062 },
  { tier: 3, cost: 24150 },
  { tier: 4, cost: 48300 },
  { tier: 5, cost: 100625 },
];

const BOOST_TIERS = [
  { tier: 1, cost: 250,  multiplier: 1.5, weeks: 1 },
  { tier: 2, cost: 750,  multiplier: 2.0, weeks: 2 },
  { tier: 3, cost: 2500, multiplier: 2.5, weeks: 1 },
];

const CONSUMABLES = {
  quest_skip_token:   { cost: 4,  label: "Quest Skip Token",   emoji: "🎫", desc: "Cancel an active solo quest with no penalty." },
  quest_choice_token: { cost: 50, label: "Quest Choice Token", emoji: "🎯", desc: "Hand-pick the target of your next quest." },
};

function perkBonusPercent(tier) {
  return (Number(tier) || 0) * 5;
}

function boostBonusLabel(multiplier) {
  const bonus = (Number(multiplier) || 1) - 1;
  return `+${bonus}×`;
}

// ── Reads ────────────────────────────────────────────────────────────────────
async function getBalance(userId) {
  const supabase = getSupabase();
  if (!supabase) return { balance: 0, total_earned: 0, total_spent: 0 };
  const { data } = await supabase.from("hm_balances").select("*").eq("user_id", userId).maybeSingle();
  return {
    balance: Number(data?.balance) || 0,
    total_earned: Number(data?.total_earned) || 0,
    total_spent: Number(data?.total_spent) || 0,
    double_hm_until: data?.double_hm_until || null,
  };
}

async function getPerks(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from("hm_perks").select("*").eq("user_id", userId);
  return data || [];
}

async function getPerkTier(userId, tree) {
  const perks = await getPerks(userId);
  return Number(perks.find((p) => p.tree === tree)?.tier) || 0;
}

async function getInventory(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("hm_inventory")
    .select("*")
    .eq("user_id", userId)
    .gt("quantity", 0);
  return data || [];
}

async function getActiveBoosts(userId) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("hm_active_boosts")
    .select("*")
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString());
  return data || [];
}

/** Total Rank XP multiplier a member currently has from activated boosts. */
async function getBoostMultiplier(userId, tree) {
  const boosts = await getActiveBoosts(userId);
  const relevant = boosts.filter((b) => b.tree === "all" || b.tree === tree);
  if (!relevant.length) return 1;
  return relevant.reduce((max, b) => Math.max(max, Number(b.multiplier) || 1), 1);
}

// ── Writes ───────────────────────────────────────────────────────────────────
/**
 * Debiting is the risky half of a purchase, so it is done as a conditional
 * update on the balance row: we only proceed if the balance we read is still
 * the balance we're decrementing. Without that, two simultaneous purchases can
 * both pass the affordability check and overdraw the account.
 */
async function tryDebit({ guildId, userId, amount, kind, reason, refId, idempotencyKey }) {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: "Database unavailable." };

  const { data: bal } = await supabase
    .from("hm_balances")
    .select("balance,total_spent")
    .eq("user_id", userId)
    .maybeSingle();

  const current = Number(bal?.balance) || 0;
  if (current < amount) {
    return { ok: false, error: `You need **${amount.toLocaleString()}** HM but have **${current.toLocaleString()}**.` };
  }

  const { data: updated } = await supabase
    .from("hm_balances")
    .update({
      balance: current - amount,
      total_spent: (Number(bal?.total_spent) || 0) + amount,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("balance", current)
    .select("balance");

  if (!updated?.length) {
    return { ok: false, error: "That purchase collided with another one — try again." };
  }

  try {
    await supabase.from("hm_transactions").insert({
      guild_id: guildId,
      user_id: userId,
      delta: -amount,
      balance_after: current - amount,
      kind,
      reason,
      ref_id: refId || null,
      idempotency_key: idempotencyKey || null,
    });
  } catch { /* ledger is best-effort */ }

  return { ok: true, balance: current - amount };
}

async function buyPerk({ guildId, userId, tree }) {
  const supabase = getSupabase();
  if (!TREE_BY_KEY[tree]) return { error: "Unknown category." };

  const currentTier = await getPerkTier(userId, tree);
  if (currentTier >= PERK_TIERS.length) return { error: "You already own the top tier of that perk." };

  const next = PERK_TIERS[currentTier];
  const debit = await tryDebit({
    guildId, userId, amount: next.cost, kind: "perk",
    reason: `${tree} perk tier ${next.tier}`,
    refId: `${tree}:${next.tier}`,
  });
  if (!debit.ok) return { error: debit.error };

  const { error } = await supabase.from("hm_perks").upsert(
    { user_id: userId, guild_id: guildId, tree, tier: next.tier, updated_at: new Date().toISOString() },
    { onConflict: "user_id,tree" }
  );
  if (error) {
    // Refund, because the debit succeeded but the grant didn't.
    await supabase.from("hm_balances").update({ balance: debit.balance + next.cost }).eq("user_id", userId);
    return { error: "Couldn't save that perk. You were refunded." };
  }

  return { ok: true, tier: next.tier, cost: next.cost, balance: debit.balance };
}

async function buyBoost({ guildId, userId, tree, tier }) {
  const supabase = getSupabase();
  if (!TREE_BY_KEY[tree]) return { error: "Unknown category." };
  const spec = BOOST_TIERS.find((t) => t.tier === Number(tier));
  if (!spec) return { error: "Unknown boost tier." };

  const debit = await tryDebit({
    guildId, userId, amount: spec.cost, kind: "boost",
    reason: `${tree} boost T${spec.tier}`, refId: `${tree}:${spec.tier}`,
  });
  if (!debit.ok) return { error: debit.error };

  // Boosts go into inventory to be activated when the member chooses, matching
  // the original design — buying and activating in one step punishes anyone who
  // buys before a busy week.
  const { data: existing } = await supabase
    .from("hm_inventory")
    .select("*")
    .eq("user_id", userId)
    .eq("tree", tree)
    .eq("boost_tier", spec.tier)
    .maybeSingle();

  const { error } = existing
    ? await supabase.from("hm_inventory").update({ quantity: existing.quantity + 1 }).eq("id", existing.id)
    : await supabase.from("hm_inventory").insert({
        user_id: userId, guild_id: guildId, tree, boost_tier: spec.tier, quantity: 1,
      });

  if (error) {
    await supabase.from("hm_balances").update({ balance: debit.balance + spec.cost }).eq("user_id", userId);
    return { error: "Couldn't save that boost. You were refunded." };
  }
  return { ok: true, cost: spec.cost, balance: debit.balance };
}

async function buyConsumable({ guildId, userId, key }) {
  const supabase = getSupabase();
  const spec = CONSUMABLES[key];
  if (!spec) return { error: "Unknown item." };

  const debit = await tryDebit({
    guildId, userId, amount: spec.cost, kind: "consumable",
    reason: spec.label, refId: key,
  });
  if (!debit.ok) return { error: debit.error };

  const { data: existing } = await supabase
    .from("hm_inventory")
    .select("*")
    .eq("user_id", userId)
    .eq("tree", key)
    .eq("boost_tier", 0)
    .maybeSingle();

  const { error } = existing
    ? await supabase.from("hm_inventory").update({ quantity: existing.quantity + 1 }).eq("id", existing.id)
    : await supabase.from("hm_inventory").insert({
        user_id: userId, guild_id: guildId, tree: key, boost_tier: 0, quantity: 1,
      });

  if (error) {
    await supabase.from("hm_balances").update({ balance: debit.balance + spec.cost }).eq("user_id", userId);
    return { error: "Couldn't save that item. You were refunded." };
  }
  return { ok: true, cost: spec.cost, balance: debit.balance };
}

async function consumeItem(userId, key) {
  const supabase = getSupabase();
  const { data: row } = await supabase
    .from("hm_inventory")
    .select("*")
    .eq("user_id", userId)
    .eq("tree", key)
    .eq("boost_tier", 0)
    .maybeSingle();
  if (!row || row.quantity <= 0) return false;

  if (row.quantity === 1) await supabase.from("hm_inventory").delete().eq("id", row.id);
  else await supabase.from("hm_inventory").update({ quantity: row.quantity - 1 }).eq("id", row.id);
  return true;
}

async function activateBoost({ guildId, userId, tree, tier }) {
  const supabase = getSupabase();
  const spec = BOOST_TIERS.find((t) => t.tier === Number(tier));
  if (!spec) return { error: "Unknown boost tier." };

  const { data: row } = await supabase
    .from("hm_inventory")
    .select("*")
    .eq("user_id", userId)
    .eq("tree", tree)
    .eq("boost_tier", spec.tier)
    .maybeSingle();
  if (!row || row.quantity <= 0) return { error: "You don't own that boost." };

  if (row.quantity === 1) await supabase.from("hm_inventory").delete().eq("id", row.id);
  else await supabase.from("hm_inventory").update({ quantity: row.quantity - 1 }).eq("id", row.id);

  const now = new Date();
  const expires = new Date(now.getTime() + spec.weeks * 7 * 86400000);
  const { error } = await supabase.from("hm_active_boosts").insert({
    user_id: userId,
    guild_id: guildId,
    tree,
    multiplier: spec.multiplier,
    started_at: now.toISOString(),
    expires_at: expires.toISOString(),
  });
  if (error) return { error: "Couldn't activate that boost." };
  return { ok: true, expiresAt: expires };
}

module.exports = {
  PERK_TIERS, BOOST_TIERS, CONSUMABLES,
  perkBonusPercent, boostBonusLabel,
  getBalance, getPerks, getPerkTier, getInventory, getActiveBoosts, getBoostMultiplier,
  tryDebit, buyPerk, buyBoost, buyConsumable, consumeItem, activateBoost,
  TREES,
};
