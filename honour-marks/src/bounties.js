"use strict";
/**
 * Bounty Quests — an OSRS-themed bounty board for Honour Marks.
 *
 * 5 active bounties at a time, posted as requests from NPCs. The board's
 * category mix is capped so it never floods with one kind: at most 2
 * skilling (Artisan), 1 slayer (Mercenary), 1 boss and 1 raid — which
 * sums to exactly the 5 slots. Each bounty rolls a random type: solo
 * (tracked per hunter) or collective (everyone's progress pools into one
 * shared total). The NPC type determines the contract:
 *   - Artisan:       paired gathering + artisan skills (blacksmith, alchemist…)
 *   - Mercenary:     "creatures" — always Slayer + Prayer + Hitpoints + one
 *                    random combat style (pure slayer training)
 *   - Boss Contract: generic boss KC, a named boss, or a brutal triple
 *   - Raid Delver:   a random raid
 *
 * Multiple people can accept the same bounty. Solo bounties track each
 * hunter's progress separately; collective bounties sum every hunter's
 * hiscores delta into one pool, and the target scales with how many
 * hunters have accepted (2 hunters face the smallest target, growing up
 * to 30). Only hunters who actually contributed get paid when a
 * collective bounty completes. Requirements are visible before
 * accepting. Progress is tracked from a hiscores snapshot taken at
 * accept time. Bounties cycle every 3 hours, but one with an active
 * hunter endures up to 96 hours from the last accept. Completed bounties
 * count toward active clan quests.
 *
 * Rewards are 2.5x the normal HM quest of the same scale.
 */

const { SKILL_MAP, ACTIVITY_MAP } = require("./jagex");

const BOUNTY_SIZES = ["solo", "group"];
const BOUNTY_TOTAL = 5;
// Board category caps — they sum to exactly BOUNTY_TOTAL, so a full board
// is always 2 skilling + 1 slayer + 1 boss + 1 raid, never more.
const CATEGORY_CAPS = { artisan: 2, mercenary: 1, boss: 1, raid: 1 };
const BOUNTY_CYCLE_MS = 3 * 60 * 60 * 1000; // 3 hours
const BOUNTY_MAX_ACTIVE_MS = 96 * 60 * 60 * 1000; // 96 hours from last accept
const REWARD_MULTIPLIER = 2.5;

// Base HM reward per scale (mirrors the normal HM quest of the same
// scale), scaled by REWARD_MULTIPLIER. Solo uses the weekly quest as its
// counterpart. Collective bounties scale with hunter count (see
// GROUP_TIERS); the stored bounty always carries the smallest (duo)
// scale, and the effective scale is derived from the acceptor count.
const BASE_HM_BY_SIZE = { solo: 150, duo: 250, trio: 350, quad: 450, five: 550, six: 650 };
const BASE_RANK_XP_BY_SIZE = { solo: 1500, duo: 2500, trio: 3500, quad: 4500, five: 5500, six: 6500 };

function bountyRewards(size) {
  const key = size === "group" ? "duo" : size;
  const base = BASE_HM_BY_SIZE[key] || 0;
  const rankBase = BASE_RANK_XP_BY_SIZE[key] || 0;
  return {
    hm: Math.round(base * REWARD_MULTIPLIER),
    rankXp: Math.round(rankBase * REWARD_MULTIPLIER),
  };
}

// Collective bounty scale tiers by hunter (acceptor) count: 2 hunters
// face the duo scale, growing through trio/quad/5-man/6-man as more join,
// so a small crew is never handed a huge target. Past 30 it stays at the
// 6-man scale.
const GROUP_TIERS = [
  { key: "duo", max: 2 },
  { key: "trio", max: 6 },
  { key: "quad", max: 11 },
  { key: "five", max: 18 },
  { key: "six", max: Infinity },
];

function tierForCount(n) {
  for (const tier of GROUP_TIERS) {
    if (n <= tier.max) return tier.key;
  }
  return "six";
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
  { name: "Mason Mabel", title: "the Stonemason", flavor: "The new fountain's half-built and the quarry's gone quiet. Cut me blocks and set 'em true — the water won't wait.", skills: ["Mining", "Construction"], contract: "Blocks & Mortar" },
  { name: "Scribe Silas", title: "the Scribe", flavor: "The clan chronicle needs writin' and the ink's run dry. Gather the parchment and bind it proper — history waits for no one.", skills: ["Crafting", "Fletching"], contract: "Ink & Parchment" },
  { name: "Herbalist Hana", title: "the Herbalist", flavor: "The healers need tonics and the garden's overrun. Pull the weeds, pick the herbs, and mind the mandrakes — they bite.", skills: ["Farming", "Herblore"], contract: "Tonics & Tinctures" },
  { name: "Navigator Nell", title: "the Sailor", flavor: "Charts are useless without a crew who knows the tides. Haul the nets, trim the sails, and keep her steady through the strait.", skills: ["Sailing", "Fishing"], contract: "Tide & Timber" },
  { name: "Runecarver Rook", title: "the Runecarver", flavor: "The rune stones are cracked and the altar's gone cold. Quarry the stone and carve it true — the gods are watchin'.", skills: ["Mining", "Runecraft"], contract: "Stones of Power" },
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
  "Zulrah", "Vorkath", "Cerberus", "Kree'Arra", "King Black Dragon",
  "Chaos Elemental", "Crazy Archaeologist", "Scorpia",
  "Giant Mole",
  "Dagannoth Supreme", "Dagannoth Rex", "Dagannoth Prime",
  "Callisto", "Vet'ion", "Chaos Fanatic", "Scorpia",
  "Kalphite Queen", "Abyssal Sire", "Alchemical Hydra", "Thermonuclear Smoke Devil",
  "Sarachnis", "Corporeal Beast", "Mimic",
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
const SKILL_XP_BY_SIZE = { solo: 15000, duo: 25000, trio: 40000, quad: 60000, five: 85000, six: 115000 };
// Boss KC target scaled by party size. Bounties pay 2.5x a normal quest,
// so the KC is 2.5x the normal quest's requirement (solo weekly 40, duo
// 150, trio 250, quad 350) — the effort matches the reward.
const KC_BY_SIZE = { solo: 100, duo: 375, trio: 625, quad: 875, five: 1125, six: 1375 };
const RAID_BY_SIZE = { solo: 2, duo: 3, trio: 4, quad: 5, five: 6, six: 7 };

// Every requirement carries `frac` — its share of the scale's full
// amount (1 = full, 0.5 = half, ...). Collective bounties are stored at
// the duo scale and re-scaled to the current tier via scaleRequirements,
// so frac is what lets amounts move between scales exactly.
function skillReq(skill, size, frac = 1) {
  return { kind: "skill", skill, amount: Math.round((SKILL_XP_BY_SIZE[size] || 15000) * frac), frac };
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
  return {
    category: "mercenary",
    npc_name: npc.name,
    npc_title: npc.title,
    title: "Creature Cull",
    flavor: npc.flavor,
    requirements: [
      skillReq("Slayer", size, 1),
      skillReq("Prayer", size, 0.5),
      skillReq("Hitpoints", size, 0.5),
      skillReq(style, size, 0.75),
    ],
  };
}

function genBoss(size, recentNpcs) {
  const npc = pick(BOSS_NPCS, recentNpcs);
  const roll = Math.random();
  const kc = KC_BY_SIZE[size] || 100;
  if (roll < 0.4) {
    // Generic KC — no specific boss (full amount).
    return {
      category: "boss",
      npc_name: npc.name,
      npc_title: npc.title,
      title: "The Ledger Hungers",
      flavor: npc.flavor,
      requirements: [{ kind: "boss_kc", boss: null, amount: kc, frac: 1 }],
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
      requirements: [{ kind: "boss_kc", boss, amount: Math.max(3, Math.round(kc / 2)), frac: 0.5 }],
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
    requirements: bosses.map((boss) => ({ kind: "boss_kc", boss, amount: per, frac: 0.25 })),
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
    requirements: [{ kind: "raid", raid, amount: RAID_BY_SIZE[size] || 2, frac: 1 }],
  };
}

const GENERATORS = { artisan: genArtisan, mercenary: genMercenary, boss: genBoss, raid: genRaid };
const CATEGORIES = Object.keys(GENERATORS);

// Board display order: artisan first, then slayer, boss, raid.
const CATEGORY_ORDER = ["artisan", "mercenary", "boss", "raid"];

// Sort a list of bounties into board display order (stable within a
// category, so same-category bounties keep their existing order).
function sortBoard(list) {
  return [...list].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
  );
}

// Roll a random bounty type: solo (individual progress) or collective
// (shared progress pool, target scales with hunter count).
function randomSize() {
  return pick(BOUNTY_SIZES);
}

// Pick a category that still has room under its board cap, given the
// current per-category counts on the board.
function pickCategory(counts) {
  const available = CATEGORIES.filter((c) => (counts[c] || 0) < CATEGORY_CAPS[c]);
  return pick(available);
}

// Build one bounty spec for a type, avoiding recently-used NPCs. Group
// bounties are generated at the duo scale (the smallest collective
// tier); the effective scale grows with the acceptor count.
function generateBounty(size, recentNpcs = new Set()) {
  const category = pick(CATEGORIES);
  const scale = size === "group" ? "duo" : size;
  const spec = GENERATORS[category](scale, recentNpcs);
  const rewards = bountyRewards(size);
  return { ...spec, size, hm_reward: rewards.hm, rank_xp_reward: rewards.rankXp };
}

// Build one bounty for the board: category respects the caps, type is
// rolled at random. `counts` is the running per-category tally.
function generateBountyForBoard(counts, recentNpcs = new Set()) {
  const category = pickCategory(counts);
  const size = randomSize();
  const scale = size === "group" ? "duo" : size;
  const spec = GENERATORS[category](scale, recentNpcs);
  const rewards = bountyRewards(size);
  return { ...spec, size, hm_reward: rewards.hm, rank_xp_reward: rewards.rankXp };
}

// Generate the full board (5 bounties: 2 skilling + 1 slayer + 1 boss +
// 1 raid, each with a random type), tracking recent NPCs so the same
// ones don't repeat within a single board.
function generateBoard(recentNpcs = new Set()) {
  const used = new Set(recentNpcs);
  const counts = {};
  const board = [];
  for (let i = 0; i < BOUNTY_TOTAL; i++) {
    const b = generateBountyForBoard(counts, used);
    counts[b.category] = (counts[b.category] || 0) + 1;
    used.add(b.npc_name);
    board.push(b);
  }
  return board;
}

// ── Rendering ──────────────────────────────────────────────────────────────

const CATEGORY_EMOJI = { artisan: "🔨", mercenary: "⚔️", boss: "💀", raid: "🗿" };
const CATEGORY_LABEL = { artisan: "Artisan", mercenary: "Mercenary", boss: "Boss Contract", raid: "Raid Delver" };
// Explicit type label so it's obvious at a glance whether a bounty is
// solo (tracked per hunter) or collective (shared progress pool).
const TYPE_LABEL = {
  solo: "Solo — just you",
  group: "Collective — target grows with hunters",
};

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
  const isGroup = bounty.size === "group";
  const typeLabel = TYPE_LABEL[bounty.size] || TYPE_LABEL.group;
  const effReqs = effectiveRequirements(bounty, acceptances.length);
  const effRewards = effectiveRewards(bounty, acceptances.length);
  const lines = [
    `**From:** *${bounty.npc_name} ${bounty.npc_title}*`,
    `*"${bounty.flavor}"*`,
    "",
    `**Contract:** ${bounty.title}`,
    `**Type:** ${typeLabel}`,
    formatRequirements(effReqs),
    "",
    `**Reward:** ${effRewards.hm} HM · ${effRewards.rankXp} Rank XP`,
  ];

  // Collective bounties show the shared pool total above the hunter list.
  if (isGroup && acceptances.length) {
    const parts = effReqs.map((req) => {
      const sum = acceptances.reduce((s, acc) => s + (acc.progress?.[reqKey(req)] || 0), 0);
      return `${Number(sum).toLocaleString()} / ${req.amount.toLocaleString()}`;
    });
    lines.push(`**Collective:** ${parts.join(" · ")}`);
  }

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

// Snapshot value lookups. Requirements store display names ("Slayer",
// "Zulrah", "Tombs of Amascut") while fetchHiscores snapshots are keyed by
// internal keys ("slayer", "zulrah", "tombs_of_amascut") with object values
// ({ experience } / { kills }) — translate + unwrap here so the two shapes
// meet. Plain-number values (older stored baselines, tests) also work, as
// does the legacy `activities` section name.
function skillXp(snap, name) {
  const key = SKILL_MAP[name] || name;
  const v = snap?.skills?.[key] ?? snap?.skills?.[name];
  return v?.experience ?? v ?? 0;
}

function bossKills(snap, name) {
  const key = ACTIVITY_MAP[name] || name;
  const v =
    snap?.bosses?.[key] ?? snap?.bosses?.[name] ??
    snap?.activities?.[key] ?? snap?.activities?.[name];
  return v?.kills ?? v ?? 0;
}

function allBossKeys(...snaps) {
  const keys = new Set();
  for (const snap of snaps) {
    for (const k of Object.keys(snap?.bosses || {})) keys.add(k);
    for (const k of Object.keys(snap?.activities || {})) keys.add(k);
  }
  return keys;
}

function computeProgress(requirements, baseline = {}, current = {}) {
  const perReq = requirements.map((req) => {
    let gained = 0;
    if (req.kind === "skill") {
      gained = Math.max(0, skillXp(current, req.skill) - skillXp(baseline, req.skill));
    } else if (req.kind === "boss_kc") {
      if (req.boss) {
        gained = Math.max(0, bossKills(current, req.boss) - bossKills(baseline, req.boss));
      } else {
        // Any-boss: sum the delta across every tracked boss activity.
        gained = 0;
        for (const k of allBossKeys(baseline, current)) {
          gained += Math.max(0, bossKills(current, k) - bossKills(baseline, k));
        }
      }
    } else if (req.kind === "raid") {
      gained = Math.max(0, bossKills(current, req.raid) - bossKills(baseline, req.raid));
    }
    return { req, gained, done: gained >= req.amount };
  });
  return { perReq, complete: perReq.every((p) => p.done) };
}

// Re-scale stored (duo-scale) requirements to a collective tier.
function scaleRequirements(requirements, tier) {
  return (requirements || []).map((req) => {
    const frac = req.frac ?? 1;
    let amount = req.amount;
    if (req.kind === "skill") {
      amount = Math.round((SKILL_XP_BY_SIZE[tier] || 15000) * frac);
    } else if (req.kind === "boss_kc") {
      amount = Math.max(2, Math.round((KC_BY_SIZE[tier] || 100) * frac));
    } else if (req.kind === "raid") {
      amount = Math.round((RAID_BY_SIZE[tier] || 2) * frac);
    }
    return { ...req, amount };
  });
}

// The requirements a bounty is currently judged against. Solo bounties
// use their stored requirements; collective bounties scale with the
// acceptor count.
function effectiveRequirements(bounty, acceptorCount = 0) {
  if (bounty.size !== "group") return bounty.requirements || [];
  return scaleRequirements(bounty.requirements, tierForCount(acceptorCount));
}

// The rewards paid on completion, at the current collective scale.
function effectiveRewards(bounty, acceptorCount = 0) {
  if (bounty.size !== "group") return { hm: bounty.hm_reward, rankXp: bounty.rank_xp_reward };
  return bountyRewards(tierForCount(acceptorCount));
}

// Sum per-acceptor progress arrays into one collective pool and check
// whether the pool meets every requirement.
function collectiveProgress(requirements, perReqList) {
  const totals = {};
  for (const perReq of perReqList || []) {
    for (const p of perReq) {
      totals[reqKey(p.req)] = (totals[reqKey(p.req)] || 0) + p.gained;
    }
  }
  const complete = (requirements || []).every((req) => (totals[reqKey(req)] || 0) >= req.amount);
  return { totals, complete };
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
  BOUNTY_TOTAL,
  CATEGORY_CAPS,
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
  CATEGORY_ORDER,
  TYPE_LABEL,
  GROUP_TIERS,
  tierForCount,
  scaleRequirements,
  effectiveRequirements,
  effectiveRewards,
  collectiveProgress,
  SKILL_XP_BY_SIZE,
  KC_BY_SIZE,
  RAID_BY_SIZE,
  randomSize,
  pickCategory,
  sortBoard,
  generateBounty,
  generateBountyForBoard,
  generateBoard,
  formatRequirement,
  formatRequirements,
  renderBountyEmbed,
  computeProgress,
  progressFraction,
  reqKey,
};
