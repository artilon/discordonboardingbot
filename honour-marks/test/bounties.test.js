// Coverage for the Bounty Quests generator: board shape (5 bounties with
// category caps + random types), category validity, reward scaling (2.5x),
// NPC variety, solo/collective labeling, collective tier scaling, and
// collective progress pooling.
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
    check("bounty size is a valid size", ["solo", "group"].includes(b.size));
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

  // ---- Rewards are 2.5x the normal quest of the same scale ----
  check("solo bounty HM is 2.5x weekly (150)", bounties.bountyRewards("solo").hm === 375);
  check("duo scale HM is 2.5x duo (250)", bounties.bountyRewards("duo").hm === 625);
  check("trio scale HM is 2.5x trio (350)", bounties.bountyRewards("trio").hm === 875);
  check("quad scale HM is 2.5x quad (450)", bounties.bountyRewards("quad").hm === 1125);
  check("five scale HM is 2.5x five (550)", bounties.bountyRewards("five").hm === 1375);
  check("six scale HM is 2.5x six (650)", bounties.bountyRewards("six").hm === 1625);
  check("group bounty starts at the duo scale", bounties.bountyRewards("group").hm === 625);
  check("group bounty Rank XP starts at the duo scale", bounties.bountyRewards("group").rankXp === 6250);
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
    const b = bounties.generateBounty("group");
    const embed = bounties.renderBountyEmbed(b, []);
    check("embed has a title", !!embed.title);
    check("embed description names the NPC", embed.description.includes(b.npc_name));
    check("embed shows the reward", embed.description.includes(`${b.hm_reward} HM`));
    check("embed shows requirements", b.requirements.every((r) => embed.description.includes(Number(r.amount).toLocaleString())));
    check("empty board says no hunters yet", /No hunters yet/.test(embed.description));
    check("group embed clearly labels collective", embed.description.includes("**Type:** Collective — target grows with hunters"));

    const solo = bounties.generateBounty("solo");
    const soloEmbed = bounties.renderBountyEmbed(solo, []);
    check("solo embed clearly labels solo", soloEmbed.description.includes("**Type:** Solo — just you"));
    check("solo embed has no collective line", !soloEmbed.description.includes("**Collective:**"));

    const withAcc = bounties.renderBountyEmbed(b, [
      { user_id: "u1", displayName: "Torlokt", progressText: "5,000 / 25,000", completed: false, progress: {} },
      { user_id: "u2", displayName: "Em Bri", progressText: "15,000 / 25,000", completed: true, progress: {} },
    ]);
    check("embed lists acceptors", withAcc.description.includes("Torlokt") && withAcc.description.includes("Em Bri"));
    check("embed marks completions", /Complete!/.test(withAcc.description));
    check("group embed shows the collective pool line", withAcc.description.includes("**Collective:**"));
  }

  // ---- Collective tiers: scale grows with hunter count ----
  {
    check("0-2 hunters face the duo scale", bounties.tierForCount(0) === "duo" && bounties.tierForCount(1) === "duo" && bounties.tierForCount(2) === "duo");
    check("3-6 hunters face the trio scale", bounties.tierForCount(3) === "trio" && bounties.tierForCount(6) === "trio");
    check("7-11 hunters face the quad scale", bounties.tierForCount(7) === "quad" && bounties.tierForCount(11) === "quad");
    check("12-18 hunters face the 5-man scale", bounties.tierForCount(12) === "five" && bounties.tierForCount(18) === "five");
    check("19-30 hunters face the 6-man scale", bounties.tierForCount(19) === "six" && bounties.tierForCount(30) === "six");
    check("past 30 hunters stays at the 6-man scale", bounties.tierForCount(31) === "six" && bounties.tierForCount(100) === "six");
  }

  // ---- Re-scaling stored (duo-scale) requirements to a tier ----
  {
    // A duo-scale boss contract scaled to trio must match direct trio
    // generation exactly (frac preserves the generic/named/triple share).
    const duoBoss = [
      { kind: "boss_kc", boss: null, amount: 375, frac: 1 },
      { kind: "boss_kc", boss: "Zulrah", amount: 188, frac: 0.5 },
      { kind: "boss_kc", boss: "Vorkath", amount: 94, frac: 0.25 },
    ];
    const trio = bounties.scaleRequirements(duoBoss, "trio");
    check("generic KC scales duo->trio", trio[0].amount === 625);
    check("named KC scales duo->trio exactly", trio[1].amount === 313);
    check("triple KC scales duo->trio exactly", trio[2].amount === 156);
    const six = bounties.scaleRequirements(duoBoss, "six");
    check("generic KC scales duo->six", six[0].amount === 1375);
    check("named KC scales duo->six", six[1].amount === 688);
    check("triple KC scales duo->six", six[2].amount === 344);

    const duoSkills = [
      { kind: "skill", skill: "Slayer", amount: 25000, frac: 1 },
      { kind: "skill", skill: "Prayer", amount: 12500, frac: 0.5 },
      { kind: "skill", skill: "Hitpoints", amount: 12500, frac: 0.5 },
      { kind: "skill", skill: "Attack", amount: 18750, frac: 0.75 },
    ];
    const quadSkills = bounties.scaleRequirements(duoSkills, "quad");
    check("skill XP scales duo->quad", quadSkills[0].amount === 60000);
    check("half-frac skill scales duo->quad", quadSkills[1].amount === 30000);
    check("three-quarter-frac skill scales duo->quad", quadSkills[3].amount === 45000);

    const duoRaid = [{ kind: "raid", raid: "Tombs of Amascut", amount: 3, frac: 1 }];
    check("raid KC scales duo->five", bounties.scaleRequirements(duoRaid, "five")[0].amount === 6);
    check("raid KC scales duo->six", bounties.scaleRequirements(duoRaid, "six")[0].amount === 7);
  }

  // ---- Effective requirements/rewards for a live bounty ----
  {
    const group = bounties.generateBounty("group");
    const solo = bounties.generateBounty("solo");
    check("solo effective requirements are the stored ones", bounties.effectiveRequirements(solo, 5) === solo.requirements);
    check("group with 2 hunters keeps the stored duo amounts", bounties.effectiveRequirements(group, 2).every((r, i) => r.amount === group.requirements[i].amount));
    check("group with 8 hunters uses quad amounts", bounties.effectiveRequirements(group, 8).every((r, i) => r.amount === bounties.scaleRequirements(group.requirements, "quad")[i].amount));
    check("solo effective rewards are the stored ones", bounties.effectiveRewards(solo, 9).hm === solo.hm_reward);
    check("group rewards grow with hunters", bounties.effectiveRewards(group, 2).hm === 625 && bounties.effectiveRewards(group, 8).hm === 1125 && bounties.effectiveRewards(group, 25).hm === 1625);
    check("group Rank XP grows with hunters", bounties.effectiveRewards(group, 25).rankXp === 16250);
  }

  // ---- Collective progress pooling ----
  {
    const reqs = [{ kind: "boss_kc", boss: null, amount: 375 }];
    const mk = (gained) => [{ req: reqs[0], gained, done: gained >= 375 }];
    const { totals, complete } = bounties.collectiveProgress(reqs, [mk(200), mk(100), mk(74)]);
    check("collective sums every hunter's delta", totals["boss:any"] === 374);
    check("collective is short by one kill", complete === false);
    check("collective completes at the target", bounties.collectiveProgress(reqs, [mk(200), mk(175)]).complete === true);
    check("empty pool never completes", bounties.collectiveProgress(reqs, []).complete === false);
  }

  // ---- Generated requirements carry frac ----
  {
    for (let i = 0; i < 30; i++) {
      const b = bounties.generateBounty("group");
      for (const r of b.requirements) {
        check("generated requirement carries a frac", typeof r.frac === "number" && r.frac > 0 && r.frac <= 1);
      }
    }
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
