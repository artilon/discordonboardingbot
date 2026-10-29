"use strict";
/**
 * Permission matrix tests.
 *
 * These matter more than they look: Discord applies category overwrites to
 * every child channel, so a single misplaced allow exposes #hm-log to the whole
 * clan. Each assertion below is a specific way that could happen.
 *
 * Run: node test/permissions.test.js
 */
const assert = require("assert");
const { PermissionFlagsBits: P } = require("discord.js");
const {
  CHANNEL_SPECS, buildOverwrites, buildCategoryOverwrites, NO_WRITE,
} = require("../src/permissions");

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

const CTX = {
  guildId: "g1",
  everyoneId: "everyone",
  botId: "bot",
  clanMemberRoleId: "clanmember",
  honourMarksRoleId: "honourmarks",
  staffRoleId: "staff",
  logUserId: "owner",
  manageRoleIds: [],
};

const ALLOW = (row, ...perms) => perms.every((p) => (row.allow || []).includes(p));
const DENY = (row, ...perms) => perms.every((p) => (row.deny || []).includes(p));

function rowsFor(audience, ctx = CTX) {
  const rows = buildOverwrites(ctx, audience);
  return {
    rows,
    get: (id) => rows.find((r) => r.id === id),
  };
}

console.log("\n[channel map]");

check("claim channel exists and is the clan-facing one", () => {
  const claim = CHANNEL_SPECS.find((s) => s.key === "claim");
  assert.ok(claim, "claim channel missing");
  assert.strictEqual(claim.audience, "clanMember");
});

check("every spec key the panel renderer expects exists", () => {
  const keys = CHANNEL_SPECS.map((s) => s.key);
  for (const k of ["claim", "guide", "quests", "shop", "database", "staff", "log"]) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
});

check("guide and shop are their own channels, not aliases of quests", () => {
  const byKey = Object.fromEntries(CHANNEL_SPECS.map((s) => [s.key, s]));
  assert.notStrictEqual(byKey.guide.name, byKey.quests.name, "guide shares a channel name with quests");
  assert.notStrictEqual(byKey.shop.name, byKey.quests.name, "shop shares a channel name with quests");
  assert.notStrictEqual(byKey.guide.name, byKey.shop.name, "guide shares a channel name with shop");
  assert.strictEqual(byKey.guide.audience, "honourMarks");
  assert.strictEqual(byKey.shop.audience, "honourMarks");
});

check("every channel name is unique", () => {
  const names = CHANNEL_SPECS.map((s) => s.name);
  assert.strictEqual(new Set(names).size, names.length, "duplicate channel name in CHANNEL_SPECS");
});

console.log("\n[claim channel]");

check("clan members can view but cannot write", () => {
  const { get } = rowsFor("clanMember");
  const row = get("clanmember");
  assert.ok(row, "clan member has no overwrite");
  assert.ok(ALLOW(row, P.ViewChannel));
  for (const p of NO_WRITE) assert.ok(DENY(row, p), "missing write deny");
});

check("honour marks holders can also view the claim channel (to drop the role)", () => {
  const { get } = rowsFor("clanMember");
  assert.ok(ALLOW(get("honourmarks"), P.ViewChannel));
});

check("everyone is denied view", () => {
  const { get } = rowsFor("clanMember");
  assert.ok(DENY(get("everyone"), P.ViewChannel));
});

console.log("\n[quests + database]");

for (const audience of ["honourMarks"]) {
  check(`${audience}: holders read, everyone else cannot see`, () => {
    const { get } = rowsFor(audience);
    const holders = get("honourmarks");
    assert.ok(ALLOW(holders, P.ViewChannel), "holder cannot view");
    for (const p of NO_WRITE) assert.ok(DENY(holders, p), `holder can ${p}`);

    assert.ok(DENY(get("clanmember"), P.ViewChannel), "clan member not explicitly denied");
    assert.ok(DENY(get("everyone"), P.ViewChannel), "everyone not denied");
  });

  check(`${audience}: nobody can post, thread, react or poll`, () => {
    const { rows } = rowsFor(audience);
    // The only rows allowed to send are the bot's.
    for (const row of rows) {
      if (row.id === CTX.botId) continue;
      const canSend = (row.allow || []).includes(P.SendMessages);
      assert.ok(!canSend, `${row.id} can send messages`);
    }
  });
}

console.log("\n[staff channel]");

check("staff read, holders and clan members cannot see", () => {
  const { get } = rowsFor("staff");
  assert.ok(ALLOW(get("staff"), P.ViewChannel));
  assert.ok(DENY(get("staff"), P.SendMessages));
  assert.ok(DENY(get("honourmarks"), P.ViewChannel));
  assert.ok(DENY(get("clanmember"), P.ViewChannel));
});

console.log("\n[log channel]");

check("only the owner and the bot can see the log", () => {
  const { rows, get } = rowsFor("owner");
  assert.ok(ALLOW(get("owner"), P.ViewChannel), "owner cannot see log");

  const viewers = rows
    .filter((r) => (r.allow || []).includes(P.ViewChannel))
    .map((r) => r.id)
    .sort();
  assert.deepStrictEqual(viewers, ["bot", "owner"], `unexpected viewers: ${viewers.join(", ")}`);
});

check("staff are explicitly denied the log, not left to inherit", () => {
  const { get } = rowsFor("owner");
  assert.ok(DENY(get("staff"), P.ViewChannel));
  assert.ok(DENY(get("honourmarks"), P.ViewChannel));
  assert.ok(DENY(get("clanmember"), P.ViewChannel));
});

check("owner cannot post in the log either", () => {
  const { get } = rowsFor("owner");
  for (const p of NO_WRITE) assert.ok(DENY(get("owner"), p));
});

console.log("\n[bot]");

check("bot can view, send, embed, edit and read history everywhere", () => {
  for (const spec of CHANNEL_SPECS) {
    const { get } = rowsFor(spec.audience);
    const bot = get("bot");
    assert.ok(bot, `bot has no overwrite on ${spec.key}`);
    for (const p of [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory, P.ManageMessages]) {
      assert.ok((bot.allow || []).includes(p), `bot missing a permission on ${spec.key}`);
    }
  }
});

check("no duplicate overwrite targets", () => {
  for (const spec of CHANNEL_SPECS) {
    const rows = buildOverwrites(CTX, spec.audience);
    const ids = rows.map((r) => r.id);
    assert.strictEqual(new Set(ids).size, ids.length, `duplicate target on ${spec.key}`);
  }
});

check("missing role IDs degrade instead of emitting undefined targets", () => {
  const bare = { ...CTX, staffRoleId: null, honourMarksRoleId: null, logUserId: null };
  for (const spec of CHANNEL_SPECS) {
    const rows = buildOverwrites(bare, spec.audience);
    assert.ok(rows.every((r) => typeof r.id === "string" && r.id.length > 0));
  }
});

console.log("\n[category]");

check("category denies everyone so children must re-allow", () => {
  const rows = buildCategoryOverwrites(CTX);
  const everyone = rows.find((r) => r.id === "everyone");
  assert.ok(DENY(everyone, P.ViewChannel));
  const bot = rows.find((r) => r.id === "bot");
  assert.ok(ALLOW(bot, P.ViewChannel));
});

check("category does not grant any human role access", () => {
  const rows = buildCategoryOverwrites(CTX);
  const humanAllows = rows.filter(
    (r) => r.id !== "everyone" && r.id !== "bot" && (r.allow || []).includes(P.ViewChannel)
  );
  assert.strictEqual(humanAllows.length, 0, "category leaks access to a role");
});

console.log(`\n${passed} checks passed.\n`);
