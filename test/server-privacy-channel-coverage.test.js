// Regression coverage for two real bugs found after the automatic server
// privacy system first shipped:
//
//   1. A channel explicitly listed in a category's rule (e.g. the clan-chat,
//      recruitment-drive, and rank-list channels, or the Leader/Staff
//      orientation channel) was only ever corrected if Discord's live
//      category-child list happened to include it. If a channel's actual
//      parent category didn't match what the bot assumed, it silently kept
//      whatever permissions it already had forever — which is exactly how
//      Clan Friends could still see clan-only channels, and how a base
//      Staff/Leader role could keep seeing the orientation channel even
//      after being verified. Fixed by resolving every explicitly-listed
//      channel directly by ID, independent of category-child discovery.
//
//   2. setMemberChannelBlock (used to lock Clan Chat for an Unverified Clan
//      Member) only ever DELETED an existing per-member override — it never
//      SET one. Since nobody has a pre-existing override before this system
//      runs, that meant the Clan Member role's own static allow always won
//      by default and Clan Chat was never actually hidden from anyone.
//
// These use lightweight fakes that only implement the handful of discord.js
// methods the privacy code actually calls — permissionOverwrites.cache (get/
// filter), .set()/.edit()/.delete(), and channels.fetch() — rather than a
// real Discord connection.
const assert = require("assert");
const path = require("path");
const { PermissionFlagsBits, OverwriteType } = require("discord.js");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// ---- Fakes ----
function makeOverwrite(id, type, allow = [], deny = []) {
  return {
    id,
    type,
    allow: { bitfield: allow, has: (f) => allow.includes(f) },
    deny: { bitfield: deny, has: (f) => deny.includes(f) },
  };
}

function makeOverwriteManager(initialRows = []) {
  const store = new Map();
  for (const row of initialRows) store.set(row.id, makeOverwrite(row.id, row.type, row.allow || [], row.deny || []));
  return {
    cache: {
      get: (id) => store.get(id),
      values: () => store.values(),
      filter: (fn) => [...store.values()].filter(fn),
    },
    set: async (rows) => {
      store.clear();
      for (const row of rows) store.set(row.id, makeOverwrite(row.id, row.type, row.allow || [], row.deny || []));
    },
    edit: async (id, perms) => {
      const existing = store.get(id);
      const allow = new Set(existing?.allow.bitfield || []);
      const deny = new Set(existing?.deny.bitfield || []);
      for (const [flag, val] of Object.entries(perms)) {
        const bit = PermissionFlagsBits[flag];
        if (val === true) { allow.add(bit); deny.delete(bit); }
        else if (val === false) { deny.add(bit); allow.delete(bit); }
      }
      store.set(id, makeOverwrite(id, OverwriteType.Member, [...allow], [...deny]));
    },
    delete: async (id) => { store.delete(id); },
  };
}

function makeFakeChannel(id, name, initialOverwriteRows = [], childrenMap = null) {
  const channel = { id, name, permissionOverwrites: makeOverwriteManager(initialOverwriteRows) };
  if (childrenMap) channel.children = { cache: childrenMap };
  return channel;
}

function makeFakeGuild(channelsById) {
  const guild = {
    roles: { everyone: { id: "everyone-role" } },
    members: { me: { id: "bot-id" } },
    channels: { fetch: async (id) => channelsById.get(id) || null },
  };
  for (const ch of channelsById.values()) ch.guild = guild;
  return guild;
}

const EVERYONE_ROLE = "everyone-role";
const CLAN_MEMBER_ROLE = "1546403975656505354";
const UNVERIFIED_ROLE = "1547278787815804928";
const CLAN_FRIEND_ROLE = "1559320122223493151";
const LEADER_ROLE = "1546401937883402293";
const OWNER_ROLE = "1546401420453085204";
const CLAN_CHAT_CATEGORY_ID = "1545654996928823377";
const ORIENTATION_CHANNEL_ID = "1559995329825472542";

async function main() {
  // ---- Bug 1a: explicitly-listed Clan Chat channels must be corrected even
  //      when NOT discoverable as a live child of their category. ----
  {
    const channelsById = new Map();
    channelsById.set(CLAN_CHAT_CATEGORY_ID, makeFakeChannel(CLAN_CHAT_CATEGORY_ID, "Clan Chat", [], new Map()));

    for (const id of [bot.CLAN_CHAT_CHANNEL_ID, bot.RECRUITMENT_DRIVE_CHANNEL_ID, bot.RANK_LIST_CHANNEL_ID]) {
      channelsById.set(id, makeFakeChannel(id, `channel-${id}`, [
        { id: EVERYONE_ROLE, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] },
        { id: CLAN_FRIEND_ROLE, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] },
      ]));
    }

    const guild = makeFakeGuild(channelsById);
    await bot.applyServerPrivacyCategory(guild, CLAN_CHAT_CATEGORY_ID, bot.SERVER_PRIVACY_CATEGORIES[CLAN_CHAT_CATEGORY_ID]);

    for (const id of [bot.CLAN_CHAT_CHANNEL_ID, bot.RECRUITMENT_DRIVE_CHANNEL_ID, bot.RANK_LIST_CHANNEL_ID]) {
      const ch = channelsById.get(id);
      check(`${id}: Clan Friend's old allow is gone even though it wasn't a discoverable category child`, !ch.permissionOverwrites.cache.get(CLAN_FRIEND_ROLE));
      check(`${id}: @everyone is now denied`, ch.permissionOverwrites.cache.get(EVERYONE_ROLE).deny.has(PermissionFlagsBits.ViewChannel));
      check(`${id}: Clan Member is explicitly allowed`, ch.permissionOverwrites.cache.get(CLAN_MEMBER_ROLE).allow.has(PermissionFlagsBits.ViewChannel));
    }
  }

  // ---- Bug 1b: same fix, for the orientation channel's legacy static role allow ----
  {
    const channelsById = new Map();
    channelsById.set(bot.STAFF_AREA_CATEGORY_ID, makeFakeChannel(bot.STAFF_AREA_CATEGORY_ID, "Staff Area", [], new Map()));
    // Legacy state: Leader role statically allowed forever, regardless of
    // verification — this is the pre-existing bug, now it must be wiped.
    channelsById.set(ORIENTATION_CHANNEL_ID, makeFakeChannel(ORIENTATION_CHANNEL_ID, "orientation", [
      { id: EVERYONE_ROLE, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      { id: LEADER_ROLE, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] },
    ]));

    const guild = makeFakeGuild(channelsById);
    await bot.applyServerPrivacyCategory(guild, bot.STAFF_AREA_CATEGORY_ID, bot.SERVER_PRIVACY_CATEGORIES[bot.STAFF_AREA_CATEGORY_ID]);

    const ch = channelsById.get(ORIENTATION_CHANNEL_ID);
    check("Orientation channel: the old permanent Leader-role allow is gone even though it wasn't a discoverable category child", !ch.permissionOverwrites.cache.get(LEADER_ROLE));
    check("Orientation channel: Owner is statically allowed instead", !!ch.permissionOverwrites.cache.get(OWNER_ROLE));
  }

  // ---- Bug 2: Clan Chat must EXPLICITLY block a pending (Unverified) Clan
  //      Member, not just "remove an override that was never set". ----
  {
    const channelsById = new Map();
    channelsById.set(CLAN_CHAT_CATEGORY_ID, makeFakeChannel(CLAN_CHAT_CATEGORY_ID, "Clan Chat", [
      { id: EVERYONE_ROLE, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      { id: CLAN_MEMBER_ROLE, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] },
    ], new Map()));
    const guild = makeFakeGuild(channelsById);
    const clanChatCategory = channelsById.get(CLAN_CHAT_CATEGORY_ID);

    const pendingMember = {
      id: "pending-member-id",
      guild,
      roles: { cache: { has: (id) => [CLAN_MEMBER_ROLE, UNVERIFIED_ROLE].includes(id) } }, // Clan Member + Unverified
    };
    await bot.syncClanChatAccessForMember(pendingMember);
    const override = clanChatCategory.permissionOverwrites.cache.get("pending-member-id");
    check(
      "A fresh Unverified Clan Member (no pre-existing override) gets an EXPLICIT per-member deny, not a silent no-op",
      !!override && override.deny.has(PermissionFlagsBits.ViewChannel)
    );

    // Now simulate them completing the nickname step.
    const verifiedMember = {
      id: "pending-member-id",
      guild,
      roles: { cache: { has: (id) => id === CLAN_MEMBER_ROLE } }, // Clan Member only, Unverified gone
    };
    await bot.syncClanChatAccessForMember(verifiedMember);
    check("Once verified, the explicit block is removed and they fall back to the Clan Member role's allow", !clanChatCategory.permissionOverwrites.cache.get("pending-member-id"));
  }

  console.log(`[server-privacy-channel-coverage.test.js] ${passed} checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
