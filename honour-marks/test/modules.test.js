"use strict";
/**
 * Pure-logic tests. No Discord connection, no Supabase, no network.
 * Run: node test/modules.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { RANK_TIERS, formatRankProgress, getRankForXp } = require("../src/ranks");
const { diffProgress, cleanRsn } = require("../src/jagex");
const q = require("../src/quests");
const { chunkLines, DESC_BUDGET, renderGuide } = require("../src/panels");

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("\n[ranks]");
check("ladder matches Heimdall's exactly", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../onboarding.js"), "utf8");
  const heim = [...src.matchAll(/\{ name: "([^"]+)",\s+multiplier: [^,]+,\s+xpNeeded: (\d+)/g)]
    .map((m) => [m[1], Number(m[2])]);
  assert.ok(heim.length > 10, "parsed Heimdall ladder");
  assert.deepStrictEqual(RANK_TIERS.map((t) => [t.name, t.xpNeeded]), heim);
});

check("progress renders at every boundary", () => {
  for (const tier of RANK_TIERS) {
    const s = formatRankProgress(tier.xpNeeded);
    assert.ok(typeof s === "string" && s.length > 0);
    assert.ok(!/\d(\.\d)?x/.test(s), "no multiplier leaks into progress");
  }
  assert.ok(formatRankProgress(1045000).includes("Max rank"));
  assert.ok(formatRankProgress(99999999).includes("Max rank"));
});

check("rank lookup is monotonic", () => {
  let lastIdx = -1;
  for (let xp = 0; xp <= 1100000; xp += 2500) {
    const idx = RANK_TIERS.indexOf(getRankForXp(xp));
    assert.ok(idx >= lastIdx, "rank went backwards at " + xp);
    lastIdx = idx;
  }
});

console.log("\n[hiscores diff]");
check("counts skill and boss gains", () => {
  const base = { skills: { mining: { experience: 1000000 } }, bosses: { vorkath: { kills: 10 } } };
  const cur = { skills: { mining: { experience: 1030000 } }, bosses: { vorkath: { kills: 35 } } };
  const p = diffProgress(base, cur, { skills: { mining: 20000 }, bosses: { vorkath: 50 } });
  assert.strictEqual(p.parts[0].gained, 30000);
  assert.strictEqual(p.parts[0].pct, 100, "pct caps at 100");
  assert.strictEqual(p.parts[1].gained, 25);
  assert.strictEqual(p.parts[1].pct, 50);
  assert.strictEqual(p.totalPct, 75);
});

check("negative deltas clamp to zero", () => {
  const a = { skills: { mining: { experience: 500 } }, bosses: {} };
  const b = { skills: { mining: { experience: 100 } }, bosses: {} };
  const p = diffProgress(a, b, { skills: { mining: 1000 } });
  assert.strictEqual(p.parts[0].gained, 0);
  assert.strictEqual(p.totalPct, 0);
});

check("missing snapshot is safe", () => {
  const p = diffProgress(null, null, { skills: { mining: 100 } });
  assert.strictEqual(p.totalPct, 0);
});

check("RSN cleaning strips non-ASCII and trims", () => {
  assert.strictEqual(cleanRsn("  ZéZima  "), "ZZima"); // é stripped, casing untouched
  assert.strictEqual(cleanRsn(null), "");
});

console.log("\n[quest targets]");
check("solo targets generate for every tree and type", () => {
  for (const tree of q.QUEST_TREES) {
    for (const type of ["daily", "weekly", "monthly"]) {
      const t = q.buildSoloTargets(tree, type);
      const n = Object.keys(t.skills).length + Object.keys(t.bosses).length;
      assert.ok(n > 0, `${tree}/${type} produced no targets`);
      for (const v of [...Object.values(t.skills), ...Object.values(t.bosses)]) {
        assert.ok(v > 0, `${tree}/${type} produced a zero target`);
      }
    }
  }
});

check("party targets generate for every tree and size", () => {
  for (const tree of q.QUEST_TREES) {
    for (const size of ["duo", "trio", "quad"]) {
      const t = q.buildPartyTargets(tree, size, "hard");
      assert.ok(Object.keys(t.skills).length + Object.keys(t.bosses).length > 0);
    }
  }
});

check("slayer + unassignable bosses are never assigned", () => {
  const banned = [
    "abyssal_sire", "alchemical_hydra", "araxxor", "cerberus", "grotesque_guardians",
    "kraken", "shellbane_gryphon", "thermonuclear_smoke_devil", "skotizo",
    "hespori", "mimic", "tzkal_zuk", "sol_heredit",
  ];
  for (let i = 0; i < 400; i++) {
    const t = q.buildSoloTargets("boss", "daily");
    for (const b of banned) {
      assert.ok(!Object.keys(t.bosses).includes(b), `${b} was assigned`);
    }
  }
});

check("boss groups collapse to their primary key", () => {
  for (const folded of [
    "the_corrupted_gauntlet", "phosanis_nightmare", "dagannoth_rex", "dagannoth_supreme",
  ]) {
    assert.ok(!q.BOSS_POOL.includes(folded), `${folded} must be folded into its primary`);
  }
  for (const primary of ["the_gauntlet", "nightmare", "dagannoth_kings"]) {
    assert.ok(q.BOSS_POOL.includes(primary), `${primary} missing from pool`);
  }
});

check("Dagannoth Kings is one virtual target counting all three", () => {
  const { bossKeys, bossLabel } = require("../src/jagex");
  assert.deepStrictEqual(bossKeys("dagannoth_kings"), [
    "dagannoth_prime", "dagannoth_rex", "dagannoth_supreme",
  ]);
  assert.strictEqual(bossLabel("dagannoth_kings"), "Dagannoth Kings (Prime, Rex or Supreme)");
});

check("grouped KC sums across variants in the diff", () => {
  const { diffProgress } = require("../src/jagex");
  const base = { skills: {}, bosses: { dagannoth_prime: { kills: 10 }, dagannoth_rex: { kills: 5 }, dagannoth_supreme: { kills: 0 } } };
  const cur = { skills: {}, bosses: { dagannoth_prime: { kills: 30 }, dagannoth_rex: { kills: 10 }, dagannoth_supreme: { kills: 5 } } };
  const p = diffProgress(base, cur, { bosses: { dagannoth_kings: 50 } });
  assert.strictEqual(p.parts[0].gained, 30, "20 + 5 + 5");
  assert.strictEqual(p.parts[0].pct, 60);
});

check("raid difficulties collapse to one entry", () => {
  for (const variant of [
    "chambers_of_xeric_challenge_mode", "theatre_of_blood_hard_mode", "tombs_of_amascut_expert_mode",
  ]) {
    assert.ok(!q.BOSS_POOL.includes(variant), `${variant} should not be separately assignable`);
  }
});

console.log("\n[quest choice token — hand-picked targets]");
check("a valid pick is used instead of a random roll", () => {
  for (let i = 0; i < 50; i++) {
    const t = q.buildSoloTargets("gathering", "daily", ["mining"]);
    assert.deepStrictEqual(Object.keys(t.skills), ["mining"]);
  }
});

check("an invalid pick is topped up with a random one from the real pool, never dropped", () => {
  const t = q.buildSoloTargets("gathering", "daily", ["not_a_real_skill"]);
  const picked = Object.keys(t.skills);
  assert.strictEqual(picked.length, 1, "still produces exactly one target");
  assert.ok(q.SKILLS_BY_TREE.gathering.includes(picked[0]), "falls back into the real pool");
});

check("a monthly skill quest needing 2 picks keeps both valid choices", () => {
  const t = q.buildSoloTargets("gathering", "monthly", ["mining", "woodcutting"]);
  assert.deepStrictEqual(Object.keys(t.skills).sort(), ["mining", "woodcutting"]);
  assert.strictEqual(t.skills.mining, 150000);
});

check("no picks at all still produces a valid random target (unchanged default behaviour)", () => {
  const t = q.buildSoloTargets("boss", "weekly", null);
  assert.strictEqual(Object.keys(t.bosses).length, 1);
});

check("soloTargetPool exposes the exact pool and count the picker UI needs", () => {
  const spec = q.soloTargetPool("combat", "monthly");
  assert.strictEqual(spec.kind, "skill");
  assert.strictEqual(spec.count, 2);
  assert.deepStrictEqual(spec.pool, q.SKILLS_BY_TREE.combat);
});

console.log("\n[rewards]");
check("HM scales by size and difficulty", () => {
  assert.strictEqual(q.soloHmReward("daily"), 50);
  assert.strictEqual(q.soloHmReward("monthly"), 400);
  assert.strictEqual(q.partyHmReward("quad", "easy"), 450);
  assert.strictEqual(q.partyHmReward("quad", "hard"), 720);
});

check("rank XP is flat and small enough to protect the tenure curve", () => {
  const { config } = require("../src/config");
  assert.strictEqual(config.rankXp.quest_solo_daily, 100);
  // A heavy quest month must stay well under the ~28,000 tenure income.
  const heavyMonth = config.rankXp.quest_solo_daily * 30 +
    config.rankXp.quest_solo_weekly * 4 +
    config.rankXp.quest_solo_monthly +
    config.rankXp.quest_party_quad * 2;
  assert.ok(heavyMonth < 28000, `heavy month ${heavyMonth} would outrun tenure`);
});

console.log("\n[resets]");
check("day/week/month stamps", () => {
  const d = new Date("2026-10-28T12:00:00Z"); // Wednesday, safely midday in Chicago too
  assert.strictEqual(q.dayStamp(d), "2026-10-28");
  assert.strictEqual(q.weekStamp(d), "2026-10-26"); // Monday
  assert.strictEqual(q.monthStamp(d), "2026-10-01");
});

check("reset stamps use America/Chicago, not UTC, across the UTC day boundary", () => {
  // 04:00 UTC on the 29th is still 23:00 on the 28th in Chicago (CDT, UTC-5).
  // A UTC-based stamp would wrongly call this the 29th.
  const lateNightUTC = new Date("2026-10-29T04:00:00Z");
  assert.strictEqual(q.dayStamp(lateNightUTC), "2026-10-28", "should use Chicago's calendar day, not UTC's");
  assert.strictEqual(q.weekStamp(lateNightUTC), "2026-10-26", "still the same Chicago week (Wednesday)");
});

check("reset stamps stay correct across the DST transition", () => {
  // DST 2026 falls back at 2:00 AM local on Nov 1 (clocks become 1:00 AM CST).
  // 06:30 UTC is 01:30 AM CDT (UTC-5) — just before the fallback, still Nov 1.
  assert.strictEqual(q.dayStamp(new Date("2026-11-01T06:30:00Z")), "2026-11-01");
  // 08:30 UTC is 02:30 AM CST (UTC-6) — just after the fallback, still Nov 1.
  assert.strictEqual(q.dayStamp(new Date("2026-11-01T08:30:00Z")), "2026-11-01");
  // A full day later, safely into CST: 2026-11-02T06:30:00Z is 00:30 AM CST,
  // the start of Nov 2 local — proves the -6 offset is actually being used
  // post-transition, not a stale -5.
  assert.strictEqual(q.dayStamp(new Date("2026-11-02T06:30:00Z")), "2026-11-02");
});

console.log("\n[panel pagination]");
check("chunking respects the description budget", () => {
  const lines = Array.from({ length: 500 }, (_, i) => `Line ${i} — some member data here`);
  const chunks = chunkLines(lines, "HEADER\n\n");
  assert.ok(chunks.length > 1, "should split");
  for (const c of chunks) {
    const len = c.join("\n").length;
    assert.ok(len <= DESC_BUDGET, `chunk of ${len} exceeds budget ${DESC_BUDGET}`);
  }
  assert.strictEqual(chunks.flat().length, lines.length, "no lines lost");
});

check("empty input still yields one page", () => {
  const chunks = chunkLines([], "HEADER\n\n");
  assert.strictEqual(chunks.length, 1);
});

console.log("\n[guide]");
check("every guide page fits the description budget and has a footer", () => {
  const pages = renderGuide({ channels: { claim: "1", quests: "2", shop: "3", database: "4" } });
  assert.ok(pages.length >= 10, "guide should be a full multi-page manual, not a short blurb");
  pages.forEach((p, i) => {
    const desc = p.embed.data.description || "";
    assert.ok(desc.length > 0, `page ${i + 1} has no description`);
    assert.ok(desc.length <= DESC_BUDGET, `page ${i + 1} description of ${desc.length} exceeds budget ${DESC_BUDGET}`);
    assert.ok(p.embed.data.title, `page ${i + 1} has no title`);
    const footer = p.embed.data.footer?.text || "";
    assert.ok(
      footer.includes(`Page ${i + 1}/${pages.length}`),
      `page ${i + 1} footer "${footer}" doesn't match its real position out of ${pages.length}`
    );
  });
});

check("renderGuide still works with no setup/channels passed at all", () => {
  const pages = renderGuide();
  assert.ok(pages.length >= 10);
  assert.ok(pages.every((p) => (p.embed.data.description || "").length > 0));
});

check("guide doesn't mention a tutorial reward or a team-quest difficulty choice", () => {
  const pages = renderGuide({ channels: { claim: "1", quests: "2", shop: "3", database: "4" } });
  const all = pages.map((p) => `${p.embed.data.title} ${p.embed.data.description}`).join("\n").toLowerCase();
  assert.ok(!all.includes("tutorial"), "there is no tutorial-reward feature in the code");

  const teamPage = pages.find((p) => p.embed.data.title.includes("Team Quests"));
  assert.ok(teamPage, "team quests page should exist");
  assert.ok(
    !/difficulty/i.test(teamPage.embed.data.description),
    "team quests only ever run at easy difficulty in the actual UI (hard mode is unreachable dead code)"
  );
});

console.log(`\n${passed} checks passed.\n`);
