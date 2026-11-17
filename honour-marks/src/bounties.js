"use strict";
/**
 * Bounty Quests — an OSRS-themed bounty board for Honour Marks.
 *
 * 12 active bounties at a time (3 per party size: solo/duo/trio/quad),
 * posted as requests from NPCs. The NPC type determines the contract:
 *   - Artisan:       paired gathering + artisan skills (blacksmith, alchemist…)
 *   - Mercenary:     "creatures" — always Slayer + Prayer + Hitpoints + one
 *                    random combat style (pure slayer training)
 *   - Boss Contract: generic boss KC, a named boss, or a brutal triple
 *   - Raid Delver:   a random raid
 *
 * Multiple people can accept the same bounty; no limit on teams per person.
 * Requirements are visible before accepting. Progress is tracked from a
 * hiscores snapshot taken at accept time. Bounties cycle every 3 hours, but
 * one with an active hunter endures up to 96 hours from the last accept —
 * after which it auto-completes at partial reward based on progress.
 * Completed bounties count toward active clan quests.
 *
 * Rewards are 2.5x the normal HM quest of the same size.
 */

const BOUNTY_SIZES = ["solo", "duo", "trio", "quad"];
const BOUNTIES_PER_SIZE = 3;
const BOUNTY_CYCLE_MS = 3 * 60 * 60 * 1000; // 3 hours
const BOUNTY_MAX_ACTIVE_MS = 96 * 60 * 60 * 1000; // 96 hours from last accept
const REWARD_MULTIPLIER = 2.5;

// Base HM reward per size (mirrors the normal HM quest of the same size),
// scaled by REWARD_MULTIPLIER. Solo uses the weekly quest as its counterpart.
const BASE_HM_BY_SIZE = { solo: 150, duo: 250, trio: 350, quad: 450 };
const BASE_RANK_XP_BY_SIZE = { solo: 1500, duo: 2500, trio: 3500, quad: 4500 };

function bountyRewards(size) {
  const base = BASE_HM_BY_SIZE[size] || 0;
  const rankBase = BASE_RANK_XP_BY_SIZE[size] || 0;
  return {
    hm: Math.round(base * REWARD_MULTIPLIER),
    rankXp: Math.round(rankBase * REWARD_MULTIPLIER),
  };
}

// ── NPC pools ──────────────────────────────────────────────────────────────
// Each entry: { name, title, flavor } — flavor is the NPC's request text.
// Large pools + anti-repeat selection keep the board feeling fresh.

const ARTISAN_NPCS = [
  { name: "Brianna", title: "the Blacksmith", flavor: "The clan armory's runnin' bare, adventurer. I need ore dug and bars hammered before the week's end — and I won't take no for an answer.", skills: ["Mining", "Smithing"], contract: "Gather & Smith" },
  { name: "Old Man Alchemist", title: "the Alchemist", flavor: "My potions are runnin' low and the herbs won't grow themselves. Tend my patches and brew me a proper stock — mind the weeds.", skills: ["Farming", "Herblore"], contract: "Grow & Brew" },
  { name: "Captain Marlin", title: "the Fisherman", flavor: "The mess hall feeds forty mouths and I've not a single mackerel to show for it. Get out on the water and fill me nets — and mind the squall.", skills: ["Fishing", "Sailing"], contract: "The Catch" },
  { name: "Foreman Builda", title: "the Carpenter", flavor: "We're raisin' a new hall and the timber yard's picked clean. Fell the trees, saw the planks, and let's get this frame up before winter.", skills: ["Woodcutting", "Construction"], contract: "Raise the Hall" },
  { name: "Tanner Tom", title: "the Tanner", flavor: "Every adventurer wants a fine cloak, but hides don't tan themselves. Track the beasts, work the leather, and make me something supple.", skills: ["Hunter", "Crafting"], contract: "Hide & Leather" },
  { name: "Fletcher Faye", title: "the Fletcher", flavor: "Bows are flyin' off the shelf and my fingers are cramping. Cut the strings, shape the shafts, and keep the archers supplied.", skills: ["Fletching", "Woodcutting"], contract: "Shafts & Strings" },
  { name: "Chef Burnie", title: "the Cook", flavor: "The feast is in two days and the larders are empty. Bring me the catch and I'll turn it into somethin' fit for a king.", skills: ["Cooking", "Fishing"], contract: "The Feast" },
  { name: "Jeweller Jem", title: "the Jeweller", flavor: "A noble's commissioned a ring and I need the stones and the setting both. Dig deep, cut clean, and don't scratch the gold.", skills: ["Mining", "Crafting"], contract: "Stones & Settings" },
  { name: "Mason Mabel", title: "the Stonemason", flavor: "The new fountain's half-built and the quarry's gone quiet. Cut me blocks and set 'em true — the water won't wait.", skills: ["Quarry", "Construction"], contract: "Blocks & Mortar" },
  { name: "Scribe Silas", title: "the Scribe", flavor: "The clan chronicle needs writin' and the ink's run dry. Gather the parchment and bind it proper — history waits for no one.", skills: ["Crafting", "Fletching"], contract: "Ink & Parchment" },
  { name: "Herbalist Hana", title: "the Herbalist", flavor: "The healers need tonics and the garden's overrun. Pull the weeds, pick the herbs, and mind the mandrakes — they bite.", skills: ["Farming", "Herblore"], contract: "Tonics & Tinctures" },
  { name: "Navigator Nell", title: "the Sailor", flavor: "Charts are useless without a crew who knows the tides. Haul the nets, trim the sails, and keep her steady through the strait.", skills: ["Sailing", "Fishing"], contract: "Tide & Timber" },
  { name: "Runecarver Rook", title: "the Runecarver", flavor: "The rune stones are cracked and the altar's gone cold. Quarry the stone and carve it true — the gods are watchin'.", skills: ["Quarry", "Runecraft"], contract: "Stones of Power" },
  { name: "Weaver Willa", title: "the Weaver", flavor: "Winter's comin' and the looms sit idle. Shear the sheep, spin the wool, and weave us all warm cloaks.", skills: ["Hunter", "Crafting"], contract: "Wool & Weave" },
  { name: "Brewer Bruno", title: "the Brewer", flavor: "The tavern's barrels are dry and the regulars are restless. Malt the grain, ferment it slow, and don't let it turn to vinegar.", skills: ["Farming", "Cooking"], contract: "Malt & Mash" },
  { name: "Cartographer Cleo", title: "the Cartographer", flavor: "Half the map's blank and the other half's wrong. Survey the wilds and chart me a coastline worth the parchment.", skills: ["Hunter", "Sailing"], contract: "Charts & Coasts" },
];

const MERCENARY_NPCS = [
  { name: "Sergeant Grey", title: "the Mercenary Sergeant", flavor: "Creatures are growin' bold beyond the gate. Thin their numbers and come back with proof of the slaughter. We don't care what they are — only that they fall." },
  { name: "The Guildmaster", title: "of the Mercenary Guild", flavor: "The contracts desk is buried in requests. Take a batch of creatures off our hands and the guild will pay in full. No questions, no survivors." },
  { name: "Captain Vane", title: "the Monster Hunter", flavor: "I've hunted every beast from here to the desert and the creatures keep comin'. Prove your steel — slay, pray, and endure." },
  { name: "Warden Moss", title: "the Gate Warden", flavor: "The creatures test the walls every night. Hold the line, hunter. Your blade, your faith, and your constitution are all that stand between us and the dark." },
  { name: "The Taskmaster", title: "the Slayer Master", flavor: "Another assignment, another pile of creatures. Bring the right weapon, keep your prayers up, and don't come back until the task is done." },
  { name: "Scout Rill", title: "the Frontier Scout", flavor: "The frontier's crawlin' with creatures and the settlers are scared witless. Clear 'em out, scout — the guild pays by the kill." },
  { name: "Marshal Dunne", title: "the Marshal", flavor: "Order's breakin' down out in the wilds and creatures rule the roads. Restore it, one slaughter at a time." },
  { name: "The Bounty Hunter", title: "of the Outer Reaches", flavor: "Dead or alive — well, mostly dead. Creatures don't negotiate. Neither do I." },
];

const BOSS_NPCS = [
  { name: "Duradel", title: "the Slayer Master", flavor: "The ledger hungers. Bring me proof of kills — I care not which beast, only that it died." },
  { name: "Konar", title: "the Slayer Master", flavor: "The wilderness is full of bosses growin' fat and bold. Thin them out and the ledger will remember your name." },
  { name: "A Skull-Masked Stranger", title: "the Collector", flavor: "I collect trophies, not excuses. Bring me boss kills and I'll make it worth your while." },
  { name: "The Ledger-Keeper", title: "of the Slayer Tower", flavor: "Every boss kill is a line in the ledger. Fill the page. The tower provides — if you're strong enough to take." },
  { name: "A Hooded Figure", title: "the Contract Broker", flavor: "Names, numbers, payment. That's the whole of it. Kill the bosses, collect the coin." },
  { name: "Mistress Vex", title: "the Trophy Hunter", flavor: "I want heads on my wall and your name under them. Boss kills, adventurer — lots of them." },
];

// Bosses eligible for named/triple contracts. High-end / storyline bosses
// that should never be assigned are simply absent from this pool.
const BOSS_POOL = [
  "Zulrah", "Vorkath", "Cerberus", "Kree'arra", "King Black Dragon",
  "Chaos Elemental", "Crazy Archaeologist", "Scorpia", "King Sand Crab",
  "Giant Mole", "Barrows: Dharok", "Barrows: Verac", "Barrows: Torag",
  "Barrows: Karil", "Barrows: Guthan", "Barrows: Ahrim",
  "Dagannoth Supreme", "Dagannoth Rex", "Dagannoth Prime",
  "Callisto", "Vet'ion", "Chaos Fanatic", "Scorpia",
  "Kalphite Queen", "Abyssal Sire", "Alchemical Hydra", "Thermonuclear Smoke Devil",
  "Sarachnis", "Corporeal Beast", "Elemental", "Mimic",
];

const RAID_NPCS = [
  { name: "A weathered delver", title: "wrapped in bandages", flavor: "The depths shift and breathe below. Lead a party in and come back with completions — don't come back empty-handed." },
  { name: "The Theatre's old doorman", title: "the Theatre of Blood", flavor: "The Theatre wants delvers. Full party, no cowards. The Verzik's waitin'." },
  { name: "A sun-scorched guide", title: "of the Tombs", flavor: "The Tombs of Amascut don't forgive the careless. Delve them, delver — and mind the wardens." },
  { name: "The Chambers' keeper", title: "of Xeric", flavor: "The Chambers of Xeric rearrange themselves nightly. Map them, clear them, and bring me proof." },
  { name: "A nervous recruit", title: "the Delver's Apprentice", flavor: "I hear the raids are where the real glory is. Show me — take a party down and earn it." },
  { name: "The Raid Herald", title: "of the Depths", flavor: "By order of the delvers' council: raids need hunters. Answer the call and descend." },
];

const RAIDS = ["Tombs of Amascut", "Theatre of Blood", "Chambers of Xeric"];

const COMBAT_STYLES = ["Attack", "Strength", "Defence", "Magic", "Ranged"];

// ── Random helpers ─────────────────────────────────────────────────────────

function pick(arr, excludeNames = new Set()) {
  // excludeNames holds NPC *names* (strings); filter the pool by name.
  const pool = arr.filter((x) => !excludeNames.has(x.name));
  const list = pool.length ? pool : arr;
  return list[Math.floor(Math.random() * list.length)];
}

function pickMany(arr, n, exclude = new Set()) {
  const pool = arr.filter((x) => !exclude.has(x));
  const list = pool.length >= n ? pool : arr;
  const copy = [...list];
  const out = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

// Skill XP target scaled by party size (bigger party, bigger grind).
const SKILL_XP_BY_SIZE = { solo: 15000, duo: 25000, trio: 40000, quad: 60000 };
const KC_BY_SIZE = { solo: 10, duo: 15, trio: 25, quad: 40 };
const RAID_BY_SIZE = { solo: 2, duo: 3, trio: 4, quad: 5 };

function skillReq(skill, size) {
  return { kind: "skill", skill, amount: SKILL_XP_BY_SIZE[size] || 15000 };
}

// ── Category generators ────────────────────────────────────────────────────
// Each returns a bounty "spec" (without id/rewards/timestamps).

function genArtisan(size, recentNpcs) {
  const npc = pick(ARTISAN_NPCS, recentNpcs);
  const [s1, s2] = npc.skills;
  return {
    category: "artisan",
    npc_name: npc.name,
    npc_title: npc.title,
    title: npc.contract,
    flavor: npc.flavor,
    requirements: [skillReq(s1, size), skillReq(s2, size)],
  };
}

function genMercenary(size, recentNpcs) {
  const npc = pick(MERCENARY_NPCS, recentNpcs);
  const style = pick(COMBAT_STYLES);
  const base = SKILL_XP_BY_SIZE[size] || 15000;
  return {
    category: "mercenary",
    npc_name: npc.name,
    npc_title: npc.title,
    title: "Creature Cull",
    flavor: npc.flavor,
    requirements: [
      { kind: "skill", skill: "Slayer", amount: base },
      { kind: "skill", skill: "Prayer", amount: Math.round(base * 0.5) },
      { kind: "skill", skill: "Hitpoints", amount: Math.round(base * 0.5) },
      { kind: "skill", skill: style, amount: Math.round(base * 0.75) },
    ],
  };
}

function genBoss(size, recentNpcs) {
  const npc = pick(BOSS_NPCS, recentNpcs);
  const roll = Math.random();
  const kc = KC_BY_SIZE[size] || 10;
  if (roll < 0.4) {
    // Generic KC — no specific boss.
    return {
      category: "boss",
      npc_name: npc.name,
      npc_title: npc.title,
      title: "The Ledger Hungers",
      flavor: npc.flavor,
      requirements: [{ kind: "boss_kc", boss: null, amount: kc * 2 }],
    };
  }
  if (roll < 0.75) {
    // One named boss.
    const boss = pick(BOSS_POOL);
    return {
      category: "boss",
      npc_name: npc.name,
      npc_title: npc.title,
      title: `${boss} Contract`,
      flavor: npc.flavor,
      requirements: [{ kind: "boss_kc", boss, amount: Math.max(3, Math.round(kc / 2)) }],
    };
  }
  // The triple — three named bosses (hardest).
  const bosses = pickMany(BOSS_POOL, 3);
  const per = Math.max(2, Math.round(kc / 4));
  return {
    category: "boss",
    npc_name: npc.name,
    npc_title: npc.title,
    title: "The Triad",
    flavor: npc.flavor,
    requirements: bosses.map((boss) => ({ kind: "boss_kc", boss, amount: per })),
  };
}

function genRaid(size, recentNpcs) {
  const npc = pick(RAID_NPCS, recentNpcs);
  const raid = pick(RAIDS);
  return {
    category: "raid",
    npc_name: npc.name,
    npc_title: npc.title,
    title: `Delve: ${raid}`,
    flavor: npc.flavor,
    requirements: [{ kind: "raid", raid, amount: RAID_BY_SIZE[size] || 2 }],
  };
}

const GENERATORS = { artisan: genArtisan, mercenary: genMercenary, boss: genBoss, raid: genRaid };
const CATEGORIES = Object.keys(GENERATORS);

// Build one bounty spec for a size, avoiding recently-used NPCs.
function generateBounty(size, recentNpcs = new Set()) {
  const category = pick(CATEGORIES);
  const spec = GENERATORS[category](size, recentNpcs);
  const rewards = bountyRewards(size);
  return { ...spec, size, hm_reward: rewards.hm, rank_xp_reward: rewards.rankXp };
}

// Generate the full board (3 per size = 12), tracking recent NPCs so the
// same ones don't repeat within a single board.
function generateBoard(recentNpcs = new Set()) {
  const used = new Set(recentNpcs);
  const board = [];
  for (const size of BOUNTY_SIZES) {
    for (let i = 0; i < BOUNTIES_PER_SIZE; i++) {
      const b = generateBounty(size, used);
      used.add(b.npc_name);
      board.push(b);
    }
  }
  return board;
}

// ── Rendering ──────────────────────────────────────────────────────────────

const CATEGORY_EMOJI = { artisan: "🔨", mercenary: "⚔️", boss: "💀", raid: "🗿" };
const CATEGORY_LABEL = { artisan: "Artisan", mercenary: "Mercenary", boss: "Boss Contract", raid: "Raid Delver" };
const SIZE_LABEL = { solo: "Solo", duo: "Duo", trio: "Trio", quad: "Quad" };

function formatRequirement(req) {
  if (req.kind === "skill") return `**${req.amount.toLocaleString()}** ${req.skill} XP`;
  if (req.kind === "boss_kc") return `**${req.amount}** ${req.boss ? `${req.boss} Kills` : "Boss Kills (any)"}`;
  if (req.kind === "raid") return `**${req.amount}** ${req.raid} Completions`;
  return `**${req.amount}**`;
}

function formatRequirements(requirements) {
  return requirements.map((r) => `🎯 ${formatRequirement(r)}`).join("\n");
}

// Render one bounty as an embed payload (pure — no Discord calls).
function renderBountyEmbed(bounty, acceptances = []) {
  const emoji = CATEGORY_EMOJI[bounty.category] || "📜";
  const lines = [
    `**From:** *${bounty.npc_name} ${bounty.npc_title}*`,
    `*"${bounty.flavor}"*`,
    "",
    `**Contract:** ${bounty.title} · ${SIZE_LABEL[bounty.size] || bounty.size}`,
    formatRequirements(bounty.requirements),
    "",
    `**Reward:** ${bounty.hm_reward} HM · ${bounty.rank_xp_reward} Rank XP`,
  ];

  if (acceptances.length) {
    lines.push("", "**Hunters:**");
    for (const acc of acceptances) {
      const who = acc.displayName || acc.rsn || `<@${acc.user_id}>`;
      const done = acc.completed ? " ✅ *Complete!*" : "";
      const prog = acc.progressText ? ` — ${acc.progressText}` : "";
      lines.push(`• **${who}**${prog}${done}`);
    }
  } else {
    lines.push("", "_No hunters yet — be the first to accept._");
  }

  return {
    title: `${emoji} Bounty — ${bounty.title}`,
    description: lines.join("\n"),
    color: 0xf5c542,
    footer: { text: `${CATEGORY_LABEL[bounty.category] || bounty.category} • Odinheim Bounty Board` },
  };
}

// ── Progress ───────────────────────────────────────────────────────────────
// Progress is the hiscores delta since accept time. `baseline` and `current`
// are hiscores snapshots (skill XP + activity counts). Returns a per-
// requirement progress array and whether all are met.

function reqKey(req) {
  if (req.kind === "skill") return `skill:${req.skill}`;
  if (req.kind === "boss_kc") return `boss:${req.boss || "any"}`;
  if (req.kind === "raid") return `raid:${req.raid}`;
  return req.kind;
}

function computeProgress(requirements, baseline = {}, current = {}) {
  const perReq = requirements.map((req) => {
    let gained = 0;
    if (req.kind === "skill") {
      gained = Math.max(0, (current.skills?.[req.skill] || 0) - (baseline.skills?.[req.skill] || 0));
    } else if (req.kind === "boss_kc") {
      if (req.boss) {
        gained = Math.max(0, (current.activities?.[req.boss] || 0) - (baseline.activities?.[req.boss] || 0));
      } else {
        // Any-boss: sum the delta across every tracked boss activity.
        gained = 0;
        const keys = new Set([...Object.keys(baseline.activities || {}), ...Object.keys(current.activities || {})]);
        for (const k of keys) gained += Math.max(0, (current.activities?.[k] || 0) - (baseline.activities?.[k] || 0));
      }
    } else if (req.kind === "raid") {
      gained = Math.max(0, (current.activities?.[req.raid] || 0) - (baseline.activities?.[req.raid] || 0));
    }
    return { req, gained, done: gained >= req.amount };
  });
  return { perReq, complete: perReq.every((p) => p.done) };
}

// Fraction (0..1) of total progress, for partial rewards on auto-complete.
function progressFraction(requirements, baseline = {}, current = {}) {
  const { perReq } = computeProgress(requirements, baseline, current);
  if (!perReq.length) return 0;
  const sum = perReq.reduce((acc, p) => acc + Math.min(1, p.gained / p.req.amount), 0);
  return sum / perReq.length;
}

module.exports = {
  BOUNTY_SIZES,
  BOUNTIES_PER_SIZE,
  BOUNTY_CYCLE_MS,
  BOUNTY_MAX_ACTIVE_MS,
  REWARD_MULTIPLIER,
  BASE_HM_BY_SIZE,
  bountyRewards,
  ARTISAN_NPCS,
  MERCENARY_NPCS,
  BOSS_NPCS,
  RAID_NPCS,
  BOSS_POOL,
  RAIDS,
  COMBAT_STYLES,
  CATEGORY_EMOJI,
  CATEGORY_LABEL,
  generateBounty,
  generateBoard,
  formatRequirement,
  formatRequirements,
  renderBountyEmbed,
  computeProgress,
  progressFraction,
  reqKey,
};
