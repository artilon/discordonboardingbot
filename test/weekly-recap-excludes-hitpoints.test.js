// Regression coverage for: "for the weekly digest can we exclude hitpoints
// from the skills it can select as the most trained skill? hitpoints will
// always be the most trained skill as you earn xp in it no matter what
// combat you are training."
//
// Hitpoints XP still counts toward a member's total XP gained (Top 5 XP
// Gainers), it's just excluded from the clan-wide per-skill tally used to
// pick "Most Trained Skill" — otherwise Hitpoints (which every combat style
// trains passively) would win that highlight almost every week regardless
// of what anyone actually chose to train.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

function makeFakeSupabase({ members, snapshotRows }) {
  const state = { snapshotRows: [...snapshotRows] };
  function from(table) {
    if (table === "clan_members") {
      return { select: () => ({ eq: async () => ({ data: members, error: null }) }) };
    }
    if (table === "weekly_recap_snapshots") {
      return {
        select: (cols) => ({
          eq: (_col, weekKey) => ({
            limit: async () => ({
              data: state.snapshotRows.filter((r) => r.week_key === weekKey).map((r) => (cols === "rsn" ? { rsn: r.rsn } : r)),
              error: null,
            }),
          }),
          lt: (_col, weekKey) => ({
            order: () => ({
              limit: async () => ({
                data: state.snapshotRows.filter((r) => r.week_key < weekKey).sort((a, b) => (a.week_key < b.week_key ? 1 : -1)),
                error: null,
              }),
            }),
          }),
        }),
        upsert: async (rows) => {
          for (const row of rows) {
            const i = state.snapshotRows.findIndex((r) => r.week_key === row.week_key && r.rsn === row.rsn);
            if (i >= 0) state.snapshotRows[i] = row;
            else state.snapshotRows.push(row);
          }
          return { data: rows, error: null };
        },
      };
    }
    const emptyChain = new Proxy(() => emptyChain, {
      get(_t, prop) {
        if (prop === "then") return (resolve) => resolve({ data: [], error: null });
        return () => emptyChain;
      },
      apply() { return emptyChain; },
    });
    return { select: () => emptyChain };
  }
  return { from };
}

function makeFakeChannel() {
  const sent = [];
  return { isTextBased: () => true, send: async (p) => { sent.push(p); return { id: "x" }; }, _sent: sent };
}

(async () => {
  const members = [{ active: true, rsn: "Combatant", xp: 1000 }];
  const fakeSupabase = makeFakeSupabase({ members, snapshotRows: [] });
  bot.config.supabase = fakeSupabase;
  const fakeChannel = makeFakeChannel();
  bot.client.channels.fetch = async () => fakeChannel;

  // Baseline week: trained nothing yet. Attack and Hitpoints both start at 0.
  bot.config.hiscoreFetcher = async () => ({
    skills: [{ name: "Attack", xp: 0 }, { name: "Hitpoints", xp: 0 }, { name: "Mining", xp: 0 }],
    activities: [],
  });
  const week0 = bot.getRecapWindowByIndex(0);
  await bot.runWeeklyRecap(week0, new Date(week0.endsAtMs));

  // Real week: the member trained Attack (gaining some Attack XP) and, as
  // always happens from combat, gained a LARGER amount of Hitpoints XP on
  // top of it (Hitpoints XP comes from any combat style, so it naturally
  // outpaces whichever single skill was actually being trained). Mining
  // gained nothing.
  bot.config.hiscoreFetcher = async () => ({
    skills: [{ name: "Attack", xp: 50000 }, { name: "Hitpoints", xp: 120000 }, { name: "Mining", xp: 0 }],
    activities: [],
  });
  const week1 = bot.getRecapWindowByIndex(1);
  const result1 = await bot.runWeeklyRecap(week1, new Date(week1.endsAtMs));

  check("the real recap returns data", result1 !== null);
  check(
    "Most Trained Skill is Attack, NOT Hitpoints, even though Hitpoints gained far more XP",
    result1.data.mostTrainedSkill?.name === "Attack"
  );
  check(
    "Most Trained Skill's amount is Attack's own gain (50,000), not Hitpoints'",
    result1.data.mostTrainedSkill?.amount === 50000
  );
  check(
    "the member's total XP gained (Top 5 XP Gainers) still includes the Hitpoints XP",
    result1.data.xpGainers[0]?.amount === 170000 // 50,000 Attack + 120,000 Hitpoints
  );

  const recapEmbed = fakeChannel._sent[fakeChannel._sent.length - 1].embeds[0].data;
  const mostTrainedField = recapEmbed.fields.find((f) => f.name.includes("Most Trained Skill"));
  check("the posted embed's Most Trained Skill field names Attack", mostTrainedField.value.includes("Attack"));
  check("the posted embed's Most Trained Skill field does NOT name Hitpoints", !mostTrainedField.value.includes("Hitpoints"));

  // ---- Edge case: if the ONLY XP gained all week was Hitpoints (e.g.
  // everyone was purely bossing and nobody trained a "real" skill), Most
  // Trained Skill should show the empty-state text, not Hitpoints. ----
  fakeChannel._sent.length = 0;
  bot.config.hiscoreFetcher = async () => ({
    skills: [{ name: "Attack", xp: 50000 }, { name: "Hitpoints", xp: 200000 }, { name: "Mining", xp: 0 }],
    activities: [],
  });
  const week2 = bot.getRecapWindowByIndex(2);
  const result2 = await bot.runWeeklyRecap(week2, new Date(week2.endsAtMs));
  check(
    "a week with only Hitpoints XP gained (no change to any other skill) has no Most Trained Skill",
    result2.data.mostTrainedSkill === null
  );
  const recap2Embed = fakeChannel._sent[0].embeds[0].data;
  const mostTrainedField2 = recap2Embed.fields.find((f) => f.name.includes("Most Trained Skill"));
  check(
    "the embed shows the empty-state text instead of crediting Hitpoints",
    mostTrainedField2.value.includes("No skill XP was gained this week")
  );

  console.log(`\n[weekly-recap-excludes-hitpoints] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
