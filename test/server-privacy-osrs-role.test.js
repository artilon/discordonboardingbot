// Covers the OSRS role fix:
//
//   1. The OSRS role (OSRS_ROLE_ID) is now automatically granted to:
//        - a Clan Friend, as soon as they are one (reached via onboarding
//          completion, a manual role change, or the heartbeat reconciler),
//        - a Clan Member once they finish nickname verification (already
//          granted directly by the nickname flow; this is the self-healing
//          backstop for anyone whose state drifts or who predates the fix).
//
//   2. The OSRS category's general channels are now visible to that role —
//      but Clan Chat, Recruitment Drive, and Rank List are each listed
//      explicitly WITHOUT the OSRS role, so holding it never unlocks those
//      three. Before this fix, the category's default rule didn't include
//      the OSRS role at all, so Clan Friends/newly-verified members could
//      see NONE of the OSRS channels no matter what role they held.
//
// Same lightweight-fake approach as the other server-privacy tests.
const assert = require("assert");
const path = require("path");
const { PermissionFlagsBits, OverwriteType } = require("discord.js");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

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

function makeMember(id, roleIds) {
  return { id, roles: { cache: { has: (rid) => roleIds.includes(rid) } } };
}

const CLAN_MEMBER_ROLE = bot.CLAN_MEMBER_ROLE_ID;
const UNVERIFIED_ROLE = bot.UNVERIFIED_ROLE_ID;
const CLAN_FRIEND_ROLE = bot.CLAN_FRIEND_ROLE_ID;
const OSRS_ROLE = bot.OSRS_ROLE_ID;
const OSRS_CATEGORY_ID = bot.OSRS_VOICE_CATEGORY_ID;

async function main() {
  // ---- isEligibleForOsrsRole ----
  check("a Clan Friend is eligible", bot.isEligibleForOsrsRole(makeMember("m1", [CLAN_FRIEND_ROLE])));
  check(
    "a verified Clan Member (no Unverified) is eligible",
    bot.isEligibleForOsrsRole(makeMember("m2", [CLAN_MEMBER_ROLE]))
  );
  check(
    "a pending (still Unverified) Clan Member is NOT eligible yet",
    !bot.isEligibleForOsrsRole(makeMember("m3", [CLAN_MEMBER_ROLE, UNVERIFIED_ROLE]))
  );
  check(
    "someone with neither role is not eligible",
    !bot.isEligibleForOsrsRole(makeMember("m4", []))
  );

  // ---- syncOsrsRoleForMember: additive grant ----
  {
    let added = null;
    const member = makeMember("friend-1", [CLAN_FRIEND_ROLE]);
    member.roles.add = async (roleId, reason) => { added = { roleId, reason }; };
    await bot.syncOsrsRoleForMember(member);
    check("a newly-eligible Clan Friend gets the OSRS role granted", added && added.roleId === OSRS_ROLE);
  }

  {
    let addCalled = false;
    const member = makeMember("friend-2", [CLAN_FRIEND_ROLE, OSRS_ROLE]);
    member.roles.add = async () => { addCalled = true; };
    await bot.syncOsrsRoleForMember(member);
    check("a Clan Friend who already has the OSRS role is left alone (no redundant API call)", !addCalled);
  }

  {
    let addCalled = false;
    const member = makeMember("rando-1", []);
    member.roles.add = async () => { addCalled = true; };
    await bot.syncOsrsRoleForMember(member);
    check("someone not eligible (no Clan Friend/verified Clan Member role) never gets the OSRS role", !addCalled);
  }

  {
    let addCalled = false;
    const member = makeMember("pending-1", [CLAN_MEMBER_ROLE, UNVERIFIED_ROLE]);
    member.roles.add = async () => { addCalled = true; };
    await bot.syncOsrsRoleForMember(member);
    check("a Clan Member still pending nickname verification does not get the OSRS role yet", !addCalled);
  }

  // ---- Category config: OSRS role unlocks the general category, but NOT
  //      Clan Chat / Recruitment Drive / Rank List ----
  const osrsRule = bot.SERVER_PRIVACY_CATEGORIES[OSRS_CATEGORY_ID];
  check("the OSRS category's default rule includes the OSRS role", osrsRule.default.allowRoleIds.includes(OSRS_ROLE));
  for (const channelId of [bot.CLAN_CHAT_CHANNEL_ID, bot.RECRUITMENT_DRIVE_CHANNEL_ID, bot.RANK_LIST_CHANNEL_ID]) {
    check(
      `explicit channel ${channelId} rule does NOT include the OSRS role (stays Clan-Member-and-above only)`,
      !osrsRule.channels[channelId].allowRoleIds.includes(OSRS_ROLE)
    );
  }

  // ---- Integration: applying the category rule actually grants View Channel
  //      on a generic OSRS channel to the OSRS role, while the explicitly
  //      listed Clan Chat channel is left without it. ----
  {
    const genericChannelId = "generic-osrs-channel";
    const childrenMap = new Map();
    const genericChannel = makeFakeChannel(genericChannelId, "woodcutting-vc");
    childrenMap.set(genericChannelId, genericChannel);

    const channelsById = new Map();
    channelsById.set(OSRS_CATEGORY_ID, makeFakeChannel(OSRS_CATEGORY_ID, "OSRS", [], childrenMap));
    channelsById.set(genericChannelId, genericChannel);
    channelsById.set(bot.CLAN_CHAT_CHANNEL_ID, makeFakeChannel(bot.CLAN_CHAT_CHANNEL_ID, "clan-chat"));
    channelsById.set(bot.RECRUITMENT_DRIVE_CHANNEL_ID, makeFakeChannel(bot.RECRUITMENT_DRIVE_CHANNEL_ID, "recruitment-drive"));
    channelsById.set(bot.RANK_LIST_CHANNEL_ID, makeFakeChannel(bot.RANK_LIST_CHANNEL_ID, "rank-list"));

    const guild = makeFakeGuild(channelsById);
    await bot.applyServerPrivacyCategory(guild, OSRS_CATEGORY_ID, osrsRule);

    const generic = channelsById.get(genericChannelId);
    check(
      "a generic (non-explicitly-listed) OSRS channel grants View Channel to the OSRS role",
      !!generic.permissionOverwrites.cache.get(OSRS_ROLE)?.allow.has(PermissionFlagsBits.ViewChannel)
    );

    for (const channelId of [bot.CLAN_CHAT_CHANNEL_ID, bot.RECRUITMENT_DRIVE_CHANNEL_ID, bot.RANK_LIST_CHANNEL_ID]) {
      const ch = channelsById.get(channelId);
      check(
        `explicitly-listed ${channelId} does NOT grant the OSRS role View Channel`,
        !ch.permissionOverwrites.cache.get(OSRS_ROLE)
      );
      check(
        `explicitly-listed ${channelId} still allows Clan Member`,
        !!ch.permissionOverwrites.cache.get(CLAN_MEMBER_ROLE)?.allow.has(PermissionFlagsBits.ViewChannel)
      );
    }
  }

  console.log(`[server-privacy-osrs-role.test.js] ${passed} checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
