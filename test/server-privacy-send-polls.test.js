// Regression coverage for: "all of the staff/leader/owner roles should be
// able to create polls [in the announcements channel], but for some reason
// i dont have that ability even as admin?"
//
// Root cause: Discord polls require the Send Polls permission, which none
// of the staff-tier roles had — and any manual channel-settings grant
// never stuck, because the server-privacy sync's wholesale
// permissionOverwrites.set() (every 60s) replaces a managed channel's
// overwrites with ViewChannel-only rows, wiping the SendPolls bit.
// Fix: ensureSendPollsGrants() additively grants SendPolls to the
// staff-tier roles on the announcements channel, running after the static
// sync in the same cycle, without ever touching ViewChannel/visibility.
//
// Uses lightweight fakes mirroring test/server-privacy-channel-coverage.test.js
// — permissionOverwrites.cache (get/filter) and edit() with merge semantics.
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
  const editCalls = [];
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
    // Mirrors discord.js: edit() merges with the existing overwrite,
    // preserving every bit it isn't asked to change.
    edit: async (id, perms) => {
      editCalls.push(id);
      const existing = store.get(id);
      const allow = new Set(existing?.allow.bitfield || []);
      const deny = new Set(existing?.deny.bitfield || []);
      for (const [flag, val] of Object.entries(perms)) {
        const bit = PermissionFlagsBits[flag];
        if (val === true) { allow.add(bit); deny.delete(bit); }
        else if (val === false) { deny.add(bit); allow.delete(bit); }
      }
      store.set(id, makeOverwrite(id, OverwriteType.Role, [...allow], [...deny]));
    },
    delete: async (id) => { store.delete(id); },
    _editCalls: editCalls,
  };
}

function makeFakeChannel(id, name, initialOverwriteRows = []) {
  return { id, name, permissionOverwrites: makeOverwriteManager(initialOverwriteRows) };
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

const CLAN_MEMBER_ROLE = "clan-member-role"; // deliberately NOT in the grant set

async function main() {
  // ---- The grant configuration itself ----
  check("the Send Polls grant targets the announcements channel", !!bot.SEND_POLLS_GRANTS[bot.WEEKLY_RECAP_CHANNEL_ID]);
  check("the Send Polls grant also targets the dedicated Announcements channel", !!bot.SEND_POLLS_GRANTS[bot.CLAN_ANNOUNCEMENTS_CHANNEL_ID]);
  check(
    "the grant set covers every staff-tier role (Jr Staff through Owner)",
    bot.STAFF_AND_ABOVE_ROLE_IDS.length === 7 && bot.STAFF_AND_ABOVE_ROLE_IDS.includes("1546401420453085204") // OWNER_ROLE_ID
  );
  check("the grant set does not include the plain Clan Member role", !bot.STAFF_AND_ABOVE_ROLE_IDS.includes(CLAN_MEMBER_ROLE));

  // ---- Grants are added to every staff-tier role ----
  {
    const channelsById = new Map();
    const channel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID, "osrs-discussion");
    channelsById.set(bot.WEEKLY_RECAP_CHANNEL_ID, channel);
    const guild = makeFakeGuild(channelsById);

    await bot.ensureSendPollsGrants(guild);

    for (const roleId of bot.STAFF_AND_ABOVE_ROLE_IDS) {
      const ow = channel.permissionOverwrites.cache.get(roleId);
      check(`role ${roleId} now allows Send Polls`, !!ow && ow.allow.has(PermissionFlagsBits.SendPolls));
    }
    check("exactly one edit per staff-tier role", channel.permissionOverwrites._editCalls.length === bot.STAFF_AND_ABOVE_ROLE_IDS.length);
    check("no overwrite was created for roles outside the grant set", !channel.permissionOverwrites.cache.get(CLAN_MEMBER_ROLE));
  }

  // ---- The dedicated Announcements channel gets the same grants ----
  {
    const channelsById = new Map();
    // This channel is privacy-managed, so it already carries the static
    // ViewChannel rows the sync maintains — the grant must layer on top.
    const channel = makeFakeChannel(bot.CLAN_ANNOUNCEMENTS_CHANNEL_ID, "announcements", [
      { id: "1546402959049359360", type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] }, // STAFF_ROLE_ID
    ]);
    channelsById.set(bot.CLAN_ANNOUNCEMENTS_CHANNEL_ID, channel);
    const guild = makeFakeGuild(channelsById);

    await bot.ensureSendPollsGrants(guild);

    for (const roleId of bot.STAFF_AND_ABOVE_ROLE_IDS) {
      const ow = channel.permissionOverwrites.cache.get(roleId);
      check(`Announcements: role ${roleId} now allows Send Polls`, !!ow && ow.allow.has(PermissionFlagsBits.SendPolls));
    }
    const staffOw = channel.permissionOverwrites.cache.get("1546402959049359360");
    check("Announcements: the static ViewChannel allow survives the grant", staffOw.allow.has(PermissionFlagsBits.ViewChannel));
  }

  // ---- Existing overwrites are preserved (visibility untouched) ----
  {
    const channelsById = new Map();
    const channel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID, "osrs-discussion", [
      // Staff role already has its ViewChannel allow from the privacy sync.
      { id: "1546402959049359360", type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] }, // STAFF_ROLE_ID
    ]);
    channelsById.set(bot.WEEKLY_RECAP_CHANNEL_ID, channel);
    const guild = makeFakeGuild(channelsById);

    await bot.ensureSendPollsGrants(guild);

    const staffOw = channel.permissionOverwrites.cache.get("1546402959049359360");
    check("the grant is additive: the existing ViewChannel allow survives", staffOw.allow.has(PermissionFlagsBits.ViewChannel) && staffOw.allow.has(PermissionFlagsBits.SendPolls));
  }

  // ---- Already-granted roles are skipped (no redundant API call) ----
  {
    const channelsById = new Map();
    const channel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID, "osrs-discussion", [
      { id: "1546401420453085204", type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendPolls] }, // OWNER_ROLE_ID
    ]);
    channelsById.set(bot.WEEKLY_RECAP_CHANNEL_ID, channel);
    const guild = makeFakeGuild(channelsById);

    await bot.ensureSendPollsGrants(guild);

    check("a role that already allows Send Polls is not re-edited", !channel.permissionOverwrites._editCalls.includes("1546401420453085204"));
    check("the other staff roles still got their grants", channel.permissionOverwrites._editCalls.length === bot.STAFF_AND_ABOVE_ROLE_IDS.length - 1);
  }

  // ---- An explicit Send Polls deny is overridden to allow ----
  {
    const channelsById = new Map();
    const channel = makeFakeChannel(bot.WEEKLY_RECAP_CHANNEL_ID, "osrs-discussion", [
      { id: "1546401937883402293", type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendPolls] }, // LEADER_ROLE_ID
    ]);
    channelsById.set(bot.WEEKLY_RECAP_CHANNEL_ID, channel);
    const guild = makeFakeGuild(channelsById);

    await bot.ensureSendPollsGrants(guild);

    const leaderOw = channel.permissionOverwrites.cache.get("1546401937883402293");
    check("an explicit Send Polls deny is flipped to allow", leaderOw.allow.has(PermissionFlagsBits.SendPolls) && !leaderOw.deny.has(PermissionFlagsBits.SendPolls));
    check("the ViewChannel allow survives the flip", leaderOw.allow.has(PermissionFlagsBits.ViewChannel));
  }

  // ---- A missing channel degrades gracefully (no throw) ----
  {
    const guild = makeFakeGuild(new Map());
    await bot.ensureSendPollsGrants(guild);
    check("a missing grant channel does not throw", true);
  }

  console.log(`\n[server-privacy-send-polls] ${passed} checks passed.`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
