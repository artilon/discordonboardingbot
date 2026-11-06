"use strict";
/**
 * The #database channel panel used to be sorted by current HM balance
 * (held), with no rank numbers at all — just a flat list. This covers the
 * fix: it's now styled as a leaderboard, ranked #1 downward by total HM
 * EARNED over a member's lifetime (not current balance, which drops every
 * time someone spends in the shop), while still showing every stat the
 * plain database view always did.
 *
 * Run: node test/database-leaderboard.test.js
 */
const assert = require("assert");
const { createFakeSupabase } = require("./fake-supabase");

// A large guild (g2) is pre-built here too, so both the small-list and the
// multi-page cases can be tested against ONE fake instance — swapping
// getSupabase() mid-test wouldn't work, since src/panels.js destructures it
// at require() time and keeps that one reference for good.
const manyRows = [];
for (let i = 0; i < 40; i++) {
  manyRows.push({
    user_id: `u-${i}`, guild_id: "g2", rsn: `Member${String(i).padStart(2, "0")}`,
    balance: 100, total_earned: 100000 - i * 100, total_spent: 0,
    solo_daily: 1, solo_weekly: 1, solo_monthly: 1, duo: 0, trio: 0, quad: 0,
  });
}

const fake = createFakeSupabase({
  hm_member_totals: [
    // Deliberately NOT already in earned order, and balance order would
    // produce a DIFFERENT ranking than earned order — that's the point.
    { user_id: "u-bigspender", guild_id: "g1", rsn: "BigSpender", balance: 50000, total_earned: 10000, total_spent: 40000, solo_daily: 2, solo_weekly: 1, solo_monthly: 0, duo: 0, trio: 0, quad: 0 },
    { user_id: "u-grinder", guild_id: "g1", rsn: "Grinder", balance: 5000, total_earned: 90000, total_spent: 85000, solo_daily: 20, solo_weekly: 10, solo_monthly: 3, duo: 1, trio: 0, quad: 0 },
    { user_id: "u-middle", guild_id: "g1", rsn: "Middle", balance: 20000, total_earned: 40000, total_spent: 20000, solo_daily: 10, solo_weekly: 5, solo_monthly: 1, duo: 0, trio: 1, quad: 0 },
    { user_id: "u-noname", guild_id: "g1", rsn: null, balance: 999, total_earned: 999999, total_spent: 0, solo_daily: 0, solo_weekly: 0, solo_monthly: 0, duo: 0, trio: 0, quad: 0 },
    ...manyRows,
  ],
  hm_prestige: [],
});

const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { getSupabase: () => fake, getConfigValue: async () => null, setConfigValue: async () => {} },
};

const { renderDatabase } = require("../src/panels");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  const pages = await renderDatabase("g1");
  assert.strictEqual(pages.length, 1, "small member list fits on one page");
  const embed = pages[0].embed;
  const title = embed.data.title;
  const desc = embed.data.description;

  console.log("\n[#database channel is now styled as a leaderboard]");

  check("the title now says Leaderboard", /Leaderboard/i.test(title));
  check("an unregistered row (no rsn) never appears, regardless of its total_earned", !desc.includes("999999"));

  const grinderIdx = desc.indexOf("Grinder");
  const middleIdx = desc.indexOf("Middle");
  const bigSpenderIdx = desc.indexOf("BigSpender");
  check("all 3 registered members appear", grinderIdx > -1 && middleIdx > -1 && bigSpenderIdx > -1);
  check(
    "ranked by total HM EARNED, not current balance — Grinder (lowest balance, highest earned) is #1",
    grinderIdx < middleIdx && middleIdx < bigSpenderIdx
  );
  check("Grinder is explicitly numbered #1", desc.includes("#1 — Grinder"));
  check("Middle is explicitly numbered #2", desc.includes("#2 — Middle"));
  check("BigSpender (highest balance, lowest earned) is ranked LAST at #3", desc.includes("#3 — BigSpender"));

  check("each line still shows HM earned", desc.includes("90,000") && desc.includes("earned"));
  check("each line still shows HM held (balance)", desc.includes("5,000") && desc.includes("held"));
  check("each line still shows the quest-type breakdown", /Quests `\d+`.*D `\d+`.*W `\d+`.*M `\d+`/.test(desc));
  check("header explicitly states the ranking rule", /Ranked by total HM earned/i.test(desc));

  // ---- Rank numbers must keep counting across pages, not reset per page ----
  const bigPages = await renderDatabase("g2");
  check("a large member list spans multiple pages", bigPages.length > 1);
  const firstPageDesc = bigPages[0].embed.data.description;
  const secondPageDesc = bigPages[1].embed.data.description;
  check("page 1 starts at #1", firstPageDesc.includes("#1 — Member00"));
  check("page 2 continues numbering, not restarting at #1", !secondPageDesc.includes("#1 — ") && /#\d{2} — /.test(secondPageDesc));

  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
