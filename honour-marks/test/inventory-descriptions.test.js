"use strict";
/**
 * The Inventory view used to list every owned Perk/Item/Boost/Consumable as
 * just a bare name and tier (e.g. "Gathering — T3 (+15%)" or "Gathering —
 * Quest & Threshold Reduction T3 (Gilded Spade)"), with no statement of what
 * that thing actually DOES. A member had to go back to the shop panel to
 * remember. This covers the fix: every Inventory line-builder in src/shop.js
 * now appends a plain-English description of the effect, reusing the same
 * effect/desc text the shop panel already shows at purchase time.
 *
 * Run: node test/inventory-descriptions.test.js
 */
const assert = require("assert");
const {
  joinInventoryFieldLines, perkInventoryLine, itemInventoryLine,
  consumableInventoryLine, boostOwnedInventoryLine, boostActiveInventoryLine,
  ITEM_CATALOG, CONSUMABLES,
} = require("../src/shop");

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  \u2713 ${label}`);
}

console.log("\n[Inventory lines now state what each held perk/item/boost/consumable does]");

check("a Perk line states the HM% bonus and which quests it applies to", () => {
  const line = perkInventoryLine("gathering", 3);
  assert.ok(line.includes("T3"));
  assert.ok(line.includes("+15%"), "tier 3 = 15% (5% per tier)");
  assert.ok(/HM from every Gathering quest/i.test(line), "must say what the % applies to, not just show the number");
});

check("a Perk line scales correctly across all 5 tiers", () => {
  for (let tier = 1; tier <= 5; tier++) {
    const line = perkInventoryLine("combat", tier);
    assert.ok(line.includes(`+${tier * 5}%`));
  }
});

check("an Item line includes the exact effect text from ITEM_CATALOG, not just the name", () => {
  const tree = "gathering";
  const slot = Object.keys(ITEM_CATALOG[tree])[0];
  const entry = ITEM_CATALOG[tree][slot][0]; // tier 1
  const line = itemInventoryLine(tree, slot, 1);
  assert.ok(line.includes(entry.name), "still shows the item's name");
  assert.ok(line.includes(entry.effect), "must include the actual effect sentence, not just name/tier");
});

check("an Item line reflects the right tier's effect text, not always tier 1's", () => {
  const tree = "combat";
  const slot = Object.keys(ITEM_CATALOG[tree])[0];
  const tier3Effect = ITEM_CATALOG[tree][slot][2].effect;
  const line = itemInventoryLine(tree, slot, 3);
  assert.ok(line.includes(tier3Effect));
});

check("a Consumable line includes the exact desc text from CONSUMABLES, not just name/qty", () => {
  const key = Object.keys(CONSUMABLES)[0];
  const spec = CONSUMABLES[key];
  const line = consumableInventoryLine(key, 2);
  assert.ok(line.includes(`\u00d72`), "still shows the quantity");
  assert.ok(line.includes(spec.desc), "must include the full description, not just the bare name");
});

check("an owned-but-not-active Boost line states what it will do once activated", () => {
  const line = boostOwnedInventoryLine("raids", 2, 1);
  assert.ok(/multiplies Raids quest-completion Rank XP by/i.test(line));
  assert.ok(/not active yet/i.test(line));
});

check("an active Boost line states the multiplier and when it ends", () => {
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const line = boostActiveInventoryLine("boss", 1.5, future);
  assert.ok(/multiplies quest-completion Rank XP by 1\.5\u00d7/i.test(line));
  assert.ok(line.includes(":R>"), "includes a Discord relative timestamp for when it ends");
});

check("joinInventoryFieldLines returns the placeholder for an empty list", () => {
  assert.strictEqual(joinInventoryFieldLines([]), "_None_");
});

check("joinInventoryFieldLines joins normal-length lists with newlines, unmodified", () => {
  const lines = ["• one", "• two", "• three"];
  assert.strictEqual(joinInventoryFieldLines(lines), lines.join("\n"));
});

check("joinInventoryFieldLines stays under Discord's 1,024-char field limit for a maxed-out member", () => {
  // Worst case: every tier-3 item across every slot in every tree, each line
  // already ~150+ chars thanks to the new effect text — enough entries to
  // blow past 1024 chars if left unguarded.
  const lines = [];
  for (const tree of Object.keys(ITEM_CATALOG)) {
    for (const slot of Object.keys(ITEM_CATALOG[tree])) {
      lines.push(itemInventoryLine(tree, slot, 3));
    }
  }
  assert.ok(lines.join("\n").length > 1024, "sanity check: the naive join really would overflow");
  const joined = joinInventoryFieldLines(lines);
  assert.ok(joined.length <= 1024, `guarded join must stay within Discord's limit, got ${joined.length}`);
  assert.ok(/more$/.test(joined), "must note that entries were omitted");
});

console.log(`\n${passed} checks passed.`);
