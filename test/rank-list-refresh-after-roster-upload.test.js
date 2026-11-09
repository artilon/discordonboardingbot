// Regression coverage for: "i just uploaded a new updated list of members
// and the * next to non discord members are gone. i need this to be
// replaced every single time a new list of members is uploaded."
//
// Three independent things are covered here, each a real way the Rank
// List's "no matching Discord nickname" asterisk could silently vanish or
// go stale:
//
//   1. syncClanRanks() used to silently no-op if called while another pass
//      was already in flight (e.g. a roster-upload handler calling it right
//      after a heartbeat/realtime-triggered pass had just started) — the
//      caller's freshly-uploaded data would then sit stale until the next
//      scheduled sync. It must now coalesce: queue one more full pass and
//      only resolve once that pass (which is guaranteed to see the latest
//      data) has actually completed.
//   2. The "Chart: 30 Days / 6 Months / All-Time" range buttons rebuilt the
//      Rank List payload directly via buildRankListPayload() without ever
//      computing discordNicknames, which wiped every `*` marker from the
//      list the moment anyone clicked one of them.
//   3. getDiscordDisplayNameSet() falls back to the guild's already-cached
//      member list instead of giving up entirely when a live fetch fails
//      (e.g. a slow moment right after a bulk roster import), so a
//      transient hiccup doesn't blank every marker either.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeChannel() {
  const sent = [];
  return {
    isTextBased: () => true,
    send: async (p) => { sent.push(p); return { id: "msg" }; },
    messages: { fetch: async () => new Map() },
    _sent: sent,
  };
}

function findMemberListText(payload) {
  return payload.embeds.slice(1).map((e) => (e.data ? e.data.description : e.description)).join("\n\n");
}

// A generic, order-agnostic chainable Supabase table mock: every method
// (select/eq/is/order/limit/update/insert/...) just returns the same chain
// object so any call order the real code happens to use works, and the
// chain itself is awaitable (thenable), resolving to whatever `result()`
// returns at that moment (so a test can gate/track exactly when it resolves).
function makeChain(result) {
  const chain = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve, reject) => Promise.resolve(result()).then(resolve, reject);
        }
        return () => chain;
      },
    }
  );
  return chain;
}

function makeFakeSupabase(tables) {
  return {
    from(table) {
      const handler = tables[table];
      if (!handler) return makeChain(() => ({ data: [], error: null }));
      return makeChain(handler);
    },
  };
}

(async () => {
  // ---------------------------------------------------------------------
  // 1. syncClanRanks() coalesces a call made while another is in flight,
  //    instead of dropping it.
  // ---------------------------------------------------------------------
  {
    // Joined "today" (0 days of tenure) with every counter already at zero,
    // so syncClanRanks() finds nothing to update and touches clan_members
    // exactly once per pass (the read) — keeping this test focused purely on
    // whether a second pass actually runs, not on unrelated XP side effects.
    const todayIso = new Date().toISOString().slice(0, 10);
    const members = [
      {
        id: 1,
        rsn: "Coalesced",
        active: true,
        xp: 0,
        tenure_xp: 0,
        bonus_xp: 0,
        eligible_rank: "Bronze",
        confirmed_rank: "Bronze",
        weeks_awarded: 0,
        months_awarded: 0,
        years_awarded: 0,
        joined_date: todayIso,
      },
    ];
    let clanMembersSelectCalls = 0;
    let releaseFirstPass = null;
    const firstPassGate = new Promise((resolve) => { releaseFirstPass = resolve; });

    const fakeSupabase = makeFakeSupabase({
      clan_members: async () => {
        clanMembersSelectCalls++;
        if (clanMembersSelectCalls === 1) await firstPassGate; // hold pass #1 open until we release it
        return { data: members.map((m) => ({ ...m })), error: null };
      },
    });
    bot.config.supabase = fakeSupabase;
    const fakeChannel = makeFakeChannel();
    bot.client.channels.fetch = async () => fakeChannel;
    bot.client.guilds.cache.clear();

    const passA = bot.syncClanRanks(); // pass #1: starts, then blocks until we release the gate
    await sleep(20); // let pass #1 actually begin and flip the in-flight flag
    const passB = bot.syncClanRanks(); // called while pass #1 is still in flight

    await sleep(20);
    check("a second concurrent call does not trigger its own clan_members read yet", clanMembersSelectCalls === 1);

    releaseFirstPass(); // let pass #1 finish
    await passA;
    await passB; // must resolve only once the queued rerun (pass #2) has actually completed

    check(
      "a syncClanRanks() call made while one was already running still triggers its own fresh pass",
      clanMembersSelectCalls === 2
    );
    check(
      "the Rank List was posted/updated after the coalesced call finished",
      fakeChannel._sent.length >= 1
    );
  }

  // ---------------------------------------------------------------------
  // 2. The growth-range buttons must not wipe the asterisk markers.
  // ---------------------------------------------------------------------
  {
    const members = [
      { id: 1, rsn: "HasDiscord", active: true, xp: 10000, confirmed_rank: "Bronze", joined_date: "2024-01-01" },
      { id: 2, rsn: "NoDiscord", active: true, xp: 5000, confirmed_rank: "Bronze", joined_date: "2024-01-01" },
    ];
    bot.config.supabase = makeFakeSupabase({
      clan_members: () => ({ data: members, error: null }),
    });
    bot.client.guilds.cache.clear();
    bot.client.guilds.cache.set("g1", {
      id: "g1",
      members: {
        fetch: async () => new Map([["u1", { user: { bot: false }, displayName: "HasDiscord" }]]),
        cache: new Map(),
      },
    });

    let editedWith = null;
    const fakeInteraction = {
      deferUpdate: async () => {},
      editReply: async (payload) => { editedWith = payload; },
    };

    await bot.onGrowthRangeButton(fakeInteraction, "30d");
    const text = findMemberListText(editedWith);

    check(
      "switching the chart range keeps the asterisk on a member with no Discord match",
      text.includes("NoDiscord\\*")
    );
    check(
      "switching the chart range does not mark a member who does have a Discord match",
      text.includes("**1. HasDiscord**") && !text.includes("HasDiscord\\*")
    );
  }

  // ---------------------------------------------------------------------
  // 3. getDiscordDisplayNameSet() falls back to cached members on a fetch
  //    failure instead of marking everyone as "no Discord match".
  // ---------------------------------------------------------------------
  {
    bot.client.guilds.cache.clear();
    bot.client.guilds.cache.set("g2", {
      id: "g2",
      members: {
        fetch: async () => { throw new Error("simulated transient fetch failure"); },
        cache: new Map([["u1", { user: { bot: false }, displayName: "CachedFallbackMember" }]]),
      },
    });

    const members = [
      { id: 1, rsn: "CachedFallbackMember", active: true, xp: 10000, confirmed_rank: "Bronze", joined_date: "2024-01-01" },
    ];
    bot.config.supabase = makeFakeSupabase({
      clan_members: () => ({ data: members, error: null }),
    });
    const fakeChannel = makeFakeChannel();
    bot.client.channels.fetch = async () => fakeChannel;

    const built = await bot.ensureRankListMessage(members);
    const sentPayload = fakeChannel._sent[fakeChannel._sent.length - 1] || built;
    const text = findMemberListText(sentPayload);

    check(
      "a transient guild.members.fetch() failure falls back to cached members instead of marking everyone",
      text.includes("**1. CachedFallbackMember**") && !text.includes("CachedFallbackMember\\*")
    );
  }

  console.log(`\n[rank-list-refresh-after-roster-upload] ${passed} checks passed.`);
})();
