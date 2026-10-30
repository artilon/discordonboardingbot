"use strict";
const { getSupabase } = require("./db");
const {
  TREES, TREE_BY_KEY, createSoloQuest,
  getPerks, getPerkTier, getItems, getItemTier, ITEM_SLOT, ITEM_PCT_BY_TIER, itemPercentForTier,
} = require("./quests");

/**
 * Shop tracks:
 *
 *   Perks       5 tiers per category, permanent, +5% HM from quests each (max +25%)
 *   Items       3 slots x 3 tiers per category, permanent (see ITEM_CATALOG below)
 *   Boosts      temporary QUEST COMPLETION XP multipliers — bought here, sat in
 *               your Inventory until you activate one, then they multiply the
 *               Rank XP a FINISHED quest in that category pays out for as long
 *               as they're running. They do nothing to HM and do nothing to a
 *               quest that expires instead of finishing.
 *   Consumables Skip token (cancel a quest) and Choice token (pick the target)
 *
 * Items were originally cut from the simplified three-track shop because the
 * old "quest reduction / HM bonus / boost length" trio interacted with perks,
 * boosts and quest targets in ways that made the economy hard to reason
 * about. This reintroduces the same three slots with a clearer contract:
 * each slot does exactly one well-defined thing, computed once at quest
 * creation time in src/quests.js (see aggregateTeamEffects/applyItemEffects),
 * so there is nothing for this file or progress.js to reconcile later.
 *
 *   Slot 1 — Quest & Threshold Reduction: -2%/-5%/-10% off the XP/KC/clears/
 *            completions a quest in that category requires.
 *   Slot 2 — Clan Chat XP Bonus: +2%/+5%/+10% more RANK XP (not HM) from
 *            quests in that category. (Renamed from mimir.js's "HM Bonus" —
 *            Perks already own the HM-bonus niche, so this was repointed at
 *            Rank XP to give it a distinct purpose instead of just being a
 *            smaller version of a Perk.)
 *   Slot 3 — Quest Expansion: for Gathering/Production/Combat/Utility/Boss
 *            PvM, adds 1/2/3 extra full-requirement targets (2/3/4 total);
 *            for Raids/Minigames, instead adds +2%/+5%/+10% to the single
 *            target's requirement. Either way the quest's HM and Rank XP pay
 *            out proportionally more, never less, for the extra work.
 *
 * Both Perks and all three Item slots stack additively across every member
 * of a team quest (Quest Expansion's extra-TARGET-COUNT variant is the one
 * exception — it uses the team's single highest tier, not a sum, so a
 * 4-person team can't demand an absurd 16 skills from one purchase).
 *
 * Boost prices are 3x the original tuning (750 / 2,250 / 7,500) because,
 * unlike the old display-only version, a boost is now a real, ongoing
 * multiplier on every quest you finish in that category for its whole
 * duration — it needed to cost like the advantage it actually gives.
 */

const PERK_TIERS = [
  { tier: 1, cost: 1750 },
  { tier: 2, cost: 10062 },
  { tier: 3, cost: 24150 },
  { tier: 4, cost: 48300 },
  { tier: 5, cost: 100625 },
];

const BOOST_TIERS = [
  { tier: 1, cost: 750,  multiplier: 1.5, weeks: 1 },
  { tier: 2, cost: 2250, multiplier: 2.0, weeks: 2 },
  { tier: 3, cost: 7500, multiplier: 2.5, weeks: 1 },
];

const CONSUMABLES = {
  quest_skip_token: {
    cost: 4, label: "Quest Skip Token", emoji: "🎫",
    desc:
      "Instantly cancels one active SOLO quest. No reward and no penalty — it simply disappears and that " +
      "daily/weekly/monthly slot is free again right away. Use it on **My Quests**. Doesn't work on team quests.",
  },
  quest_choice_token: {
    cost: 50, label: "Quest Choice Token", emoji: "🎯",
    desc:
      "The next time you start a SOLO quest, you'll be offered the choice to hand-pick its exact target " +
      "(a specific skill or boss) instead of letting the bot roll one at random from that category. " +
      "Only spent if you actually use it to pick — declining keeps the token for later.",
  },
};

function perkBonusPercent(tier) {
  return (Number(tier) || 0) * 5;
}

// ── Items catalog ────────────────────────────────────────────────────────────
// Item names: Slot 1 keeps every original mimir.js "quest reduction" name,
// and Slot 2 keeps every original mimir.js "HM Bonus" name even though the
// slot's effect was repointed at Rank XP (user's explicit call: keep the
// names, only the mechanic changed). Slot 3 is a brand-new mechanic, so it
// gets brand-new names.
const REDUCTION_NAMES = {
  gathering: ["Old Spade", "New Spade", "Gilded Spade"],
  production: ["Rusty Needle", "Shiny Needle", "Gilded Needle"],
  combat: ["Rusty Whetstone", "New Whetstone", "Gilded Whetstone"],
  utility: ["Worn Shoes", "New Shoes", "Open Toed Shoes"],
  boss: ["Old Rusty Sword", "Very Straight, Sharp Sword", "Legendary Sword of a Legendary Hero"],
  raids: ["Longbow with a Broken String", "Freshly Strung Bow", "Legendary Bow of a Legendary Hero"],
  minigames: ["Holey Coin Pouch", "Totally-Not-Restitched Coin Pouch", "Gold Threaded Coin Pouch"],
};
const REDUCTION_COSTS = [600, 1400, 5000];

const CLAN_CHAT_XP_NAMES = {
  gathering: ["Broken Harpoon", "New Harpoon", "Gilded Harpoon"],
  production: ["Rusty Saw", "Very Sharp Saw", "Gilded Saw"],
  combat: ["Dented Shield", "Reinforced Shield", "Gilded Shield"],
  utility: ["Bent Lockpick", "Very Straight Lockpick", "Gilded Lockpick"],
  boss: ["Smelly Helmet", "Not-At-All-Dented Helmet", "Legendary Helmet of a Legendary Hero"],
  raids: ["Broken 2H Sword", "Very Girthy 2H Sword", "Legendary 2H Sword of a Legendary Hero"],
  minigames: ["Old Bedsheet Cape", "Newly Hemmed Cape", "Gold Clasped Hooded Cape"],
};
const CLAN_CHAT_XP_COSTS = [900, 1750, 10062]; // T2/T3 reuse the matching 5%/10% Perk price points on purpose

const EXPANSION_NAMES = {
  gathering: ["Worn Rucksack", "Reinforced Rucksack", "Gilded Rucksack"],
  production: ["Cracked Mould", "Sturdy Mould", "Gilded Mould"],
  combat: ["Tattered Training Manual", "Updated Training Manual", "Gilded War Manual"],
  utility: ["Frayed Planner", "Detailed Planner", "Gilded Itinerary"],
  boss: ["Faded Bounty Board", "Fresh Bounty Board", "Gilded Bounty Board"],
  raids: ["Torn Raid Log", "Updated Raid Log", "Gilded Raid Log"],
  minigames: ["Worn Activity Pass", "Renewed Activity Pass", "Gilded Activity Pass"],
};
// Skills/Boss PvM buy extra TARGET COUNT (priced steeper — it's a whole extra
// quest's worth of work each tier). Raids/Minigames buy a % onto the single
// target instead, priced like the other percentage slots.
const EXPANSION_COSTS_COUNT = [5000, 15000, 35000];
const EXPANSION_COSTS_PCT = [2000, 6000, 18000];
const EXPANSION_IS_PCT = { raids: true, minigames: true };

function buildCatalogFor(tree, label) {
  const reduction = REDUCTION_NAMES[tree].map((name, i) => ({
    tier: i + 1, name, cost: REDUCTION_COSTS[i],
    effect: `-${ITEM_PCT_BY_TIER[i + 1]}% XP/KC/clears/completions required for ${label} quests (Solo & Team, stacks across the whole team).`,
  }));
  const clanChatXp = CLAN_CHAT_XP_NAMES[tree].map((name, i) => ({
    tier: i + 1, name, cost: CLAN_CHAT_XP_COSTS[i],
    effect: `+${ITEM_PCT_BY_TIER[i + 1]}% more Rank XP from ${label} quests (Solo & Team, stacks across the whole team).`,
  }));
  const isPct = !!EXPANSION_IS_PCT[tree];
  const expansion = EXPANSION_NAMES[tree].map((name, i) => {
    const tier = i + 1;
    const cost = isPct ? EXPANSION_COSTS_PCT[i] : EXPANSION_COSTS_COUNT[i];
    const effect = isPct
      ? `+${ITEM_PCT_BY_TIER[tier]}% more clears/completions required for ${label} quests, paying +${ITEM_PCT_BY_TIER[tier]}% more HM and Rank XP for it (Solo & Team, stacks across the whole team).`
      : `Adds ${tier} extra full-requirement target${tier > 1 ? "s" : ""} to ${label} quests (Solo & Team — a team uses whoever's highest tier, not a sum), paying proportionally more HM and Rank XP for the extra work.`;
    return { tier, name, cost, effect };
  });
  return { [ITEM_SLOT.REDUCTION]: reduction, [ITEM_SLOT.CLAN_CHAT_XP]: clanChatXp, [ITEM_SLOT.EXPANSION]: expansion };
}

const ITEM_CATALOG = {};
for (const t of TREES) ITEM_CATALOG[t.key] = buildCatalogFor(t.key, t.label);

const ITEM_SLOT_LABEL = {
  [ITEM_SLOT.REDUCTION]: "Quest & Threshold Reduction",
  [ITEM_SLOT.CLAN_CHAT_XP]: "Clan Chat XP Bonus",
  [ITEM_SLOT.EXPANSION]: "Quest Expansion",
};

/** `1.5×` — the whole multiplier a quest's Rank XP is multiplied BY, not a bonus on top of it. */
function boostBonusLabel(multiplier) {
  const mult = Number(multiplier) || 1;
  return `${mult}×`;
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

/**
 * The quest-completion XP multiplier a member currently has active for one
 * category. Read at the moment a quest finishes (see src/progress.js) — this
 * is the ONLY place a boost has any effect. If someone somehow has more than
 * one active boost for the same category, the strongest one applies; they
 * don't stack additively.
 */
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

/** `{reduction: 2, hm_bonus: 0, boost_length: 1}` — every slot's current tier for one category. */
async function getItemTiers(userId, tree) {
  const [reduction, clanChatXp, expansion] = await Promise.all([
    getItemTier(userId, tree, ITEM_SLOT.REDUCTION),
    getItemTier(userId, tree, ITEM_SLOT.CLAN_CHAT_XP),
    getItemTier(userId, tree, ITEM_SLOT.EXPANSION),
  ]);
  return { [ITEM_SLOT.REDUCTION]: reduction, [ITEM_SLOT.CLAN_CHAT_XP]: clanChatXp, [ITEM_SLOT.EXPANSION]: expansion };
}

/**
 * Buys the next tier of one Item slot in one category. Items use the same
 * "one row per (user, tree, slot)" shape as Perks, but deliberately an
 * explicit select-then-insert/update instead of `.upsert(...,{onConflict})`:
 * the test double in test/fake-supabase.js doesn't implement upsert's
 * conflict-target matching, and a real explicit check-then-write is no less
 * correct against production Supabase either.
 */
async function buyItem({ guildId, userId, tree, slot }) {
  const supabase = getSupabase();
  if (!supabase) return { error: "Database unavailable." };
  if (!TREE_BY_KEY[tree]) return { error: "Unknown category." };
  const catalog = ITEM_CATALOG[tree]?.[slot];
  if (!catalog) return { error: "Unknown item slot." };

  const currentTier = await getItemTier(userId, tree, slot);
  if (currentTier >= catalog.length) return { error: "You already own the top tier of that item." };

  const next = catalog[currentTier];
  const debit = await tryDebit({
    guildId, userId, amount: next.cost, kind: "item",
    reason: `${tree} ${slot} item tier ${next.tier} (${next.name})`,
    refId: `${tree}:${slot}:${next.tier}`,
  });
  if (!debit.ok) return { error: debit.error };

  // hm_items has no surrogate id column — its primary key is
  // (user_id, tree, slot) — so the explicit update below matches on that
  // instead of an "id" that doesn't exist.
  const { data: existing } = await supabase
    .from("hm_items")
    .select("*")
    .eq("user_id", userId)
    .eq("tree", tree)
    .eq("slot", slot)
    .maybeSingle();

  const { error } = existing
    ? await supabase
        .from("hm_items")
        .update({ tier: next.tier, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("tree", tree)
        .eq("slot", slot)
    : await supabase.from("hm_items").insert({ user_id: userId, guild_id: guildId, tree, slot, tier: next.tier });

  if (error) {
    await supabase.from("hm_balances").update({ balance: debit.balance + next.cost }).eq("user_id", userId);
    return { error: "Couldn't save that item. You were refunded." };
  }

  return { ok: true, tier: next.tier, name: next.name, cost: next.cost, balance: debit.balance };
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

/** Adds one of a consumable to a member's inventory without charging HM. */
async function grantConsumable(userId, guildId, key) {
  const supabase = getSupabase();
  if (!supabase) return false;

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
  return !error;
}

async function buyConsumable({ guildId, userId, key }) {
  const spec = CONSUMABLES[key];
  if (!spec) return { error: "Unknown item." };

  const debit = await tryDebit({
    guildId, userId, amount: spec.cost, kind: "consumable",
    reason: spec.label, refId: key,
  });
  if (!debit.ok) return { error: debit.error };

  const granted = await grantConsumable(userId, guildId, key);
  if (!granted) {
    const supabase = getSupabase();
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

/**
 * A Quest Choice Token is spent BEFORE the quest it pays for is known to
 * actually succeed — `createSoloQuest` can still reject the attempt for any
 * number of reasons that have nothing to do with the picks themselves
 * (already have one of this type, already used this period, a hiscores read
 * failure, a DB hiccup). Spending the token and then letting the quest fail
 * anyway used to just eat it for nothing; this refunds it whenever that
 * happens, the same way a Skip Token already refunds itself on a failed
 * cancel. `tokenConsumed` should be `false` when the member didn't spend a
 * token at all (the random-roll path), in which case this behaves exactly
 * like a plain `createSoloQuest` call.
 */
async function createSoloQuestWithChoiceToken({ guildId, member, tree, questType, picks, tokenConsumed }) {
  const result = await createSoloQuest({ guildId, member, tree, questType, picks: tokenConsumed ? picks : null });

  if (result.error && tokenConsumed) {
    const refunded = await grantConsumable(member.user_id, guildId, "quest_choice_token");
    return { ...result, tokenConsumed, refunded };
  }
  return { ...result, tokenConsumed, refunded: false };
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
  ITEM_CATALOG, ITEM_SLOT, ITEM_SLOT_LABEL,
  perkBonusPercent, boostBonusLabel,
  getBalance, getPerks, getPerkTier, getItems, getItemTier, getItemTiers,
  getInventory, getActiveBoosts, getBoostMultiplier,
  tryDebit, buyPerk, buyItem, buyBoost, buyConsumable, grantConsumable, consumeItem, activateBoost,
  createSoloQuestWithChoiceToken,
  TREES,
};
