// Regression coverage for: "when a user picks the Clan Member role during
// Discord onboarding, the only channels they should see are the onboarding
// server-nickname channel and the Contact Us channel."
//
// A member who has picked Clan Member but hasn't set their nickname yet is
// "pending" (CLAN_MEMBER_ROLE_ID + UNVERIFIED_ROLE_ID). The gate applies an
// explicit per-member View Channel DENY to every channel except the two
// allowed ones, and an explicit ALLOW to those two — the only way to hide
// channels the Clan Member role would otherwise reveal. Once the nickname is
// set (Unverified removed), every override is cleared.
const assert = require("assert");
const path = require("path");
const { PermissionFlagsBits, OverwriteType } = require("discord.js");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// ---- Fakes (mirror test/server-privacy-send-polls.test.js) ----
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
      store.set(id, makeOverwrite(id, OverwriteType.Member, [...allow], [...deny]));
    },
    delete: async (id) => { store.delete(id); },
    _editCalls: editCalls,
  };
}

function makeFakeChannel(id, name) {
  return { id, name, permissionOverwrites: makeOverwriteManager() };
}

function makeMember(userId, roleIds, guild) {
  return { id: userId, roles: [...roleIds], guild };
}

async function main() {
  // ---- The visible set is exactly the two channels ----
  check("the visible set contains the onboarding nickname channel", bot.PENDING_ONBOARDING_VISIBLE_CHANNEL_IDS.has(bot.ONBOARDING_CHANNEL_ID));
  check("the visible set contains the Contact Us channel", bot.PENDING_ONBOARDING_VISIBLE_CHANNEL_IDS.has(bot.TICKET_CONTACT_CHANNEL_ID));
  check("the visible set has exactly two channels", bot.PENDING_ONBOARDING_VISIBLE_CHANNEL_IDS.size === 2);

  // ---- A pending member is blocked everywhere except the two channels ----
  {
    const channels = [
      makeFakeChannel(bot.ONBOARDING_CHANNEL_ID, "onboarding"),
      makeFakeChannel(bot.TICKET_CONTACT_CHANNEL_ID, "contact-us"),
      makeFakeChannel("chan-general", "general"),
      makeFakeChannel("chan-announce", "announcements"),
      makeFakeChannel("chan-voice", "voice"),
    ];
    const guild = { channels: { cache: new Map(channels.map((c) => [c.id, c])) } };
    const member = makeMember("user-1", [bot.CLAN_MEMBER_ROLE_ID, bot.UNVERIFIED_ROLE_ID], guild);

    await bot.syncPendingOnboardingAccessForMember(member);

    const byId = new Map(channels.map((c) => [c.id, c]));
    const onb = byId.get(bot.ONBOARDING_CHANNEL_ID).permissionOverwrites.cache.get("user-1");
    const contact = byId.get(bot.TICKET_CONTACT_CHANNEL_ID).permissionOverwrites.cache.get("user-1");
    check("pending member is explicitly ALLOWED on the nickname channel", !!onb && onb.allow.has(PermissionFlagsBits.ViewChannel));
    check("pending member is explicitly ALLOWED on the Contact Us channel", !!contact && contact.allow.has(PermissionFlagsBits.ViewChannel));

    for (const id of ["chan-general", "chan-announce", "chan-voice"]) {
      const ow = byId.get(id).permissionOverwrites.cache.get("user-1");
      check(`pending member is explicitly DENIED on ${id}`, !!ow && ow.deny.has(PermissionFlagsBits.ViewChannel));
    }
  }

  // ---- A member who finished nickname setup has every override cleared ----
  {
    const channels = [
      makeFakeChannel(bot.ONBOARDING_CHANNEL_ID, "onboarding"),
      makeFakeChannel(bot.TICKET_CONTACT_CHANNEL_ID, "contact-us"),
      makeFakeChannel("chan-general", "general"),
    ];
    // Pre-seed the overrides a pending member would have had.
    for (const c of channels) {
      await c.permissionOverwrites.edit("user-2", { ViewChannel: c.id === "chan-general" ? false : true });
    }
    const guild = { channels: { cache: new Map(channels.map((c) => [c.id, c])) } };
    // No UNVERIFIED role => nickname is done => no longer pending.
    const member = makeMember("user-2", [bot.CLAN_MEMBER_ROLE_ID], guild);

    await bot.syncPendingOnboardingAccessForMember(member);

    for (const c of channels) {
      check(`finished member has no leftover override on ${c.id}`, !c.permissionOverwrites.cache.get("user-2"));
    }
  }

  // ---- A member without the Clan Member role is never gated ----
  {
    const channels = [makeFakeChannel("chan-general", "general")];
    const guild = { channels: { cache: new Map(channels.map((c) => [c.id, c])) } };
    const member = makeMember("user-3", [bot.UNVERIFIED_ROLE_ID], guild); // Unverified but no Clan Member role

    await bot.syncPendingOnboardingAccessForMember(member);

    check("a non-Clan-Member gets no override from this gate", !channels[0].permissionOverwrites.cache.get("user-3"));
  }

  // ---- Channels with no permissionOverwrites are skipped, not crashed ----
  // Regression: the reconcile loop spammed "Cannot read properties of
  // undefined (reading 'cache')" because the gate iterates every guild
  // channel and some cached channels have no permissionOverwrites object.
  {
    const noPermsChannel = { id: "chan-noperms", name: "no-perms" }; // no permissionOverwrites
    const normalChannel = makeFakeChannel("chan-general", "general");
    const guild = { channels: { cache: new Map([[noPermsChannel.id, noPermsChannel], [normalChannel.id, normalChannel]]) } };
    const member = makeMember("user-5", [bot.CLAN_MEMBER_ROLE_ID, bot.UNVERIFIED_ROLE_ID], guild);

    await bot.syncPendingOnboardingAccessForMember(member); // must not throw

    const ow = normalChannel.permissionOverwrites.cache.get("user-5");
    check("a channel without permissionOverwrites is skipped without throwing", !!ow && ow.deny.has(PermissionFlagsBits.ViewChannel));
  }

  // ---- Re-running is idempotent (no redundant API writes) ----
  {
    const channels = [makeFakeChannel("chan-general", "general")];
    const guild = { channels: { cache: new Map(channels.map((c) => [c.id, c])) } };
    const member = makeMember("user-4", [bot.CLAN_MEMBER_ROLE_ID, bot.UNVERIFIED_ROLE_ID], guild);

    await bot.syncPendingOnboardingAccessForMember(member);
    const callsAfterFirst = channels[0].permissionOverwrites._editCalls.length;
    await bot.syncPendingOnboardingAccessForMember(member);
    check("a second sync makes no additional edit calls", channels[0].permissionOverwrites._editCalls.length === callsAfterFirst);
  }

  console.log(`\n[pending-onboarding-gate] ${passed} checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
