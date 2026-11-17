// Coverage for Pool Quests: requirements (trio x 1.75), rewards, and the
// open-roster model that replaces fixed team quests.
const assert = require("assert");
const path = require("path");

const quests = require(path.join(__dirname, "..", "src", "quests.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

function main() {
  // ---- Pool requirements are trio x 1.75 ----
  const skill = quests.partyTargetPool("gathering", "pool", "easy");
  check("pool skill requirement is 350,000 XP (200k x 1.75)", skill.value === 350000);

  const boss = quests.partyTargetPool("boss", "pool", "easy");
  check("pool boss requirement is 438 KC (250 x 1.75)", boss.value === 438);

  const raid = quests.partyTargetPool("raids", "pool", "easy");
  check("pool raid requirement is 53 (30 x 1.75)", raid.value === 53);

  const minigame = quests.partyTargetPool("minigames", "pool", "easy");
  check("pool minigame requirement is 219 (125 x 1.75)", minigame.value === 219);

  // ---- Difficulty scales target count, not the per-target amount ----
  const skillHard = quests.partyTargetPool("gathering", "pool", "hard");
  check("pool hard has 3 targets", skillHard.count === 3);
  check("pool hard per-target amount is unchanged", skillHard.value === 350000);

  // ---- Pool rewards scale with difficulty ----
  check("pool HM easy is 613", quests.partyHmReward("pool", "easy") === 613);
  check("pool HM medium is 1226", quests.partyHmReward("pool", "medium") === 1226);
  check("pool HM hard is 1839", quests.partyHmReward("pool", "hard") === 1839);

  // ---- Pool requirements are exported for the guide/tests ----
  check("POOL_REQUIREMENTS is exported", !!quests.POOL_REQUIREMENTS);
  check("pool skill requirement exported", quests.POOL_REQUIREMENTS.skill.xp === 350000);

  console.log(`\n[pool-quests] ${passed} checks passed.`);
}

main();
