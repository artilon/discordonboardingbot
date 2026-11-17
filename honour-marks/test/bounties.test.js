// Coverage for the Bounty Quests generator: board shape (5 bounties with
// category caps + random sizes), category validity, reward scaling (2.5x),
// NPC variety, and team-size labeling.
const assert = require("assert");
const path = require("path");

const bounties = require(path.join(__dirname, "..", "src", "bounties.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

function main() {
  // ---- Board shape: 5 total, category caps, random sizes ----
  const board = bounties.generateBoard();
  check("board has 5 bounties", board.length === 5);
  check("board has 2 skilling (artisan) bounties", board.filter((b) => b.category === "artisan").length === 2);
  check("board has 1 slayer (mercenary) bounty", board.filter((b) => b.category === "mercenary").length === 1);
  check("board has 1 boss bounty", board.filter((b) => b.category === "boss").length === 1);
  check("board has 1 raid bounty", board.filter((b) => b.category === "raid").length === 1);
  for (const b of board) {
    check("bounty size is a valid size", ["solo", "duo", "trio", "quad"].includes(b.size));
  }
  // Caps hold across many boards, and sizes vary (random, not fixed per slot).
  const seenSizes = new Set();
  for (let i = 0; i < 60; i++) {
    const b = bounties.generateBoard();
    check("board is always 5", b.length === 5);
    const byCat = {};
    for (const x of b) byCat[x.category] = (byCat[x.category] || 0) + 1;
    check("raid never exceeds 1", (byCat.raid || 0) <= 1);
    check("boss never exceeds 1", (byCat.boss || 0) <= 1);
    check("slayer never exceeds 1", (byCat.mercenary || 0) <= 1);
    check("skilling never exceeds 2", (byCat.artisan || 0) <= 2);
    for (const x of b) seenSizes.add(x.size);
  }
  check("sizes are random across boards (more than one size seen)", seenSizes.size > 1);

  // ---- Board display order: artisan, slayer, boss, raid ----
  {
    const shuffled = [
      { category: "raid", npc_name: "R" },
      { category: "boss", npc_name: "B" },
      { category: "mercenary", npc_name: "M" },
      { category: "artisan", npc_name: "A2" },
      { category: "artisan", npc_name: "A1" },
    ];
    const sorted = bounties.sortBoard(shuffled);
    check(
      "sortBoard orders artisan, slayer, boss, raid",
      sorted.map((b) => b.category).join(",") === "artisan,artisan,mercenary,boss,raid"
    );
    check("sortBoard is stable within a category", sorted[0].npc_name === "A2" && sorted[1].npc_name === "A1");
    check("sortBoard does not mutate the input", shuffled[0].category === "raid");
  }

  // ---- Rewards are 2.5x the normal quest of the same size ----
  check("solo bounty HM is 2.5x weekly (150)", bounties.bountyRewards("solo").hm === 375);
  check("duo bounty HM is 2.5x duo (250)", bounties.bountyRewards("duo").hm === 625);
  check("trio bounty HM is 2.5x trio (350)", bounties.bountyRewards("trio").hm === 875);
  check("quad bounty HM is 2.5x quad (450)", bounties.bountyRewards("quad").hm === 1125);
  for (const b of board) {
    check(`bounty (${b.size}) reward matches 2.5x`, b.hm_reward === bounties.bountyRewards(b.size).hm);
  }

  // ---- Every bounty is well-formed ----
  const cats = new Set(["artisan", "mercenary", "boss", "raid"]);
  for (const b of board) {
    check("bounty has a valid category", cats.has(b.category));
    check("bounty has an NPC name + title", !!b.npc_name && !!b.npc_title);
    check("bounty has a title + flavor", !!b.title && !!b.flavor);
    check("bounty has requirements", Array.isArray(b.requirements) && b.requirements.length > 0);
    for (const r of b.requirements) {
      check("requirement has a kind + amount", !!r.kind && Number(r.amount) > 0);
    }
  }

  // ---- Category-specific invariants ----
  for (let i = 0; i < 40; i++) {
    const m = bounties.generateBounty("solo");
    if (m.category === "mercenary") {
      const skills = m.requirements.map((r) => r.skill);
      check("mercenary always includes Slayer", skills.includes("Slayer"));
      check("mercenary always includes Prayer", skills.includes("Prayer"));
      check("mercenary always includes Hitpoints", skills.includes("Hitpoints"));
      check("mercenary includes a combat style", skills.some((s) => bounties.COMBAT_STYLES.includes(s)));
      check("mercenary never names a creature", !/zulrah|vorkath|cerberus/i.test(JSON.stringify(m.requirements)));
    }
    if (m.category === "boss") {
      for (const r of m.requirements) {
        if (r.boss) check("named boss is from the pool", bounties.BOSS_POOL.includes(r.boss));
      }
    }
    // Boss KC is scaled 2.5x the normal quest (effort matches the 2.5x pay):
    // generic = full amount, named = half, triple = quarter each.
    if (m.category === "boss") {
      const base = { solo: 100, duo: 375, trio: 625, quad: 875 }[m.size];
      const total = m.requirements.reduce((s, r) => s + r.amount, 0);
      check("boss KC is at the 2.5x scale", total >= base / 4 && total <= base);
    }
    if (m.category === "raid") {
      check("raid is a real raid", bounties.RAIDS.includes(m.requirements[0].raid));
    }
    if (m.category === "artisan") {
      check("artisan pairs two skills", m.requirements.length === 2 && m.requirements.every((r) => r.kind === "skill"));
    }
  }

  // ---- NPC variety: a full board shouldn't repeat NPCs ----
  const names = board.map((b) => b.npc_name);
  check("no NPC repeats within one board", new Set(names).size === names.length);

  // ---- Rendering ----
  {
    const b = bounties.generateBounty("duo");
    const embed = bounties.renderBountyEmbed(b, []);
    check("embed has a title", !!embed.title);
    check("embed description names the NPC", embed.description.includes(b.npc_name));
    check("embed shows the reward", embed.description.includes(`${b.hm_reward} HM`));
    check("embed shows requirements", b.requirements.every((r) => embed.description.includes(String(r.amount))));
    check("empty board says no hunters yet", /No hunters yet/.test(embed.description));
    check("embed clearly labels the team size", embed.description.includes("**Team:** Team of 2 (Duo)"));

    const solo = bounties.generateBounty("solo");
    const soloEmbed = bounties.renderBountyEmbed(solo, []);
    check("solo embed clearly labels solo", soloEmbed.description.includes("**Team:** Solo — just you"));
    const quad = bounties.generateBounty("quad");
    const quadEmbed = bounties.renderBountyEmbed(quad, []);
    check("quad embed clearly labels team of 4", quadEmbed.description.includes("**Team:** Team of 4 (Quad)"));

    const withAcc = bounties.renderBountyEmbed(b, [
      { user_id: "u1", displayName: "Torlokt", progressText: "5,000 / 15,000", completed: false },
      { user_id: "u2", displayName: "Em Bri", progressText: "15,000 / 15,000", completed: true },
    ]);
    check("embed lists acceptors", withAcc.description.includes("Torlokt") && withAcc.description.includes("Em Bri"));
    check("embed marks completions", /Complete!/.test(withAcc.description));
  }

  // ---- Progress computation ----
  {
    const reqs = [
      { kind: "skill", skill: "Mining", amount: 10000 },
      { kind: "skill", skill: "Smithing", amount: 10000 },
    ];
    const baseline = { skills: { Mining: 5000, Smithing: 5000 }, activities: {} };
    const current = { skills: { Mining: 12000, Smithing: 8000 }, activities: {} };
    const { perReq, complete } = bounties.computeProgress(reqs, baseline, current);
    check("progress computes skill deltas", perReq[0].gained === 7000 && perReq[1].gained === 3000);
    check("not complete when a req is short", complete === false);
    check("fraction is the mean of per-req fractions", Math.abs(bounties.progressFraction(reqs, baseline, current) - 0.5) < 1e-9);

    const done = bounties.computeProgress(reqs, baseline, { skills: { Mining: 20000, Smithing: 20000 }, activities: {} });
    check("complete when all reqs met", done.complete === true);
  }
  {
    // Boss KC (named) + any-boss aggregation.
    const reqs = [{ kind: "boss_kc", boss: "Zulrah", amount: 5 }];
    const baseline = { skills: {}, activities: { Zulrah: 10 } };
    const current = { skills: {}, activities: { Zulrah: 14 } };
    check("named boss KC delta", bounties.computeProgress(reqs, baseline, current).perReq[0].gained === 4);

    const anyReqs = [{ kind: "boss_kc", boss: null, amount: 10 }];
    const b2 = { skills: {}, activities: { Zulrah: 10, Vorkath: 5 } };
    const c2 = { skills: {}, activities: { Zulrah: 13, Vorkath: 9 } };
    check("any-boss sums deltas across bosses", bounties.computeProgress(anyReqs, b2, c2).perReq[0].gained === 7);
  }

  console.log(`\n[bounties] ${passed} checks passed.`);
}

main();
