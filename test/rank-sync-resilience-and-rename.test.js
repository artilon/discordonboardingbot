// Regression coverage for two related reports:
//
//   1. "Rank XP isn't being auto-awarded based on tenure — it only updates
//      when staff manually uploads the member list. And when it finally does
//      update, members get a pile of rank-up alerts all bunched together
//      instead of spaced out." Root cause: runOneRankSyncPass()'s per-member
//      loop had no error isolation — one member throwing partway through (a
//      transient Discord/Supabase error, a bad record, anything) silently
//      aborted every member still left in the pass, so the sync kept
//      wedging on the same spot pass after pass until something unrelated
//      (like a roster upload rebuilding the member list) happened to clear
//      it — at which point every milestone that piled up during the outage
//      posted in one instant burst. Fixed by wrapping each member's own slice
//      of the pass in its own try/catch, and by spacing consecutive BRAND
//      NEW staff alerts apart with a small delay instead of firing them back
//      to back.
//
//   2. "I need the bot to keep track of who's OSRS name is linked to their
//      Discord username. Someone changed their in-game username and now the
//      database/bot thinks they are two different people." Root cause:
//      clan_members was matched purely by RSN text, so a rename looked
//      exactly like "the old RSN left the clan" plus "a brand new member
//      joined" — losing all tenure/XP history for that person. Fixed by
//      resolving each uploaded RSN to a Discord user_id via Honour Marks'
//      hm_members table (kept current by /register) and matching/updating
//      the SAME clan_members row by that link when possible, instead of
//      only ever matching by RSN text.
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
    send: async (p) => {
      sent.push({ payload: p, at: Date.now() });
      return { id: `msg-${sent.length}` };
    },
    messages: { fetch: async () => null },
    _sent: sent,
  };
}

// A minimal, explicit chain builder — unlike a catch-all Proxy, this lets a
// test see exactly which op (select/insert/update/delete) and which
// row/id/patch a call carried, which the rename + resilience scenarios below
// both need (e.g. "fail the update only for member id 2").
function makeTable(handlers = {}) {
  function chain(pending) {
    const next = (patch) => chain({ ...pending, ...patch });
    return {
      select: (...args) => next({ op: "select", args }),
      insert: (row) => next({ op: "insert", row }),
      update: (patch) => next({ op: "update", patch }),
      delete: () => next({ op: "delete" }),
      eq: (col, val) => next({ eqCol: col, eqVal: val }),
      in: (col, vals) => next({ inCol: col, inVals: vals }),
      is: () => chain(pending),
      ilike: () => chain(pending),
      order: () => chain(pending),
      limit: () => chain(pending),
      maybeSingle: () => next({ single: true }),
      then: (resolve, reject) => {
        Promise.resolve()
          .then(async () => {
            const op = pending.op || "select";
            const fn = handlers[op];
            const result = fn ? await fn(pending) : { data: [], error: null };
            return result;
          })
          .then(resolve, reject);
      },
    };
  }
  return chain({});
}

function makeFakeSupabase(tables) {
  return {
    from(table) {
      return tables[table] ? tables[table] : makeTable({});
    },
  };
}

(async () => {
  // =========================================================================
  // 1. One member throwing mid-pass must not block everyone after them.
  // =========================================================================
  {
    const todayIso = new Date().toISOString().slice(0, 10);
    const members = [
      // Processed first (array order == the order runOneRankSyncPass iterates).
      // Its own update always rejects, simulating a transient failure.
      {
        id: "boom",
        rsn: "BoomMember",
        active: true,
        xp: 0,
        tenure_xp: 0,
        bonus_xp: 3000, // Steel tier (2500 xpNeeded) from bonus XP alone
        confirmed_rank: "Bronze",
        eligible_rank: "Bronze",
        weeks_awarded: 0,
        months_awarded: 0,
        years_awarded: 0,
        joined_date: todayIso,
      },
      // Must still get its own tenure/xp update + rank-up alert even though
      // the member ahead of it in the list just threw.
      {
        id: "fine",
        rsn: "FineMember",
        active: true,
        xp: 0,
        tenure_xp: 0,
        bonus_xp: 3000,
        confirmed_rank: "Bronze",
        eligible_rank: "Bronze",
        weeks_awarded: 0,
        months_awarded: 0,
        years_awarded: 0,
        joined_date: todayIso,
      },
    ];

    const updateCalls = [];
    const clanMembersTable = makeTable({
      select: async () => ({ data: members.map((m) => ({ ...m })), error: null }),
      update: async ({ patch, eqVal }) => {
        updateCalls.push({ id: eqVal, patch });
        if (eqVal === "boom") throw new Error("simulated transient Supabase failure");
        return { data: null, error: null };
      },
    });
    const fakeSupabase = makeFakeSupabase({
      clan_members: clanMembersTable,
      roster_upload: makeTable({ select: async () => ({ data: [], error: null }) }),
      pending_rank_xp: makeTable({ select: async () => ({ data: [], error: null }) }),
      hm_members: makeTable({ select: async () => ({ data: [], error: null }) }),
      hm_audit_log: makeTable({ insert: async () => ({ data: null, error: null }) }),
    });

    bot.config.supabase = fakeSupabase;
    bot.config.rankUpAlertStaggerMs = 0; // keep this part of the test fast
    const fakeChannel = makeFakeChannel();
    bot.client.channels.fetch = async () => fakeChannel;
    bot.client.guilds.cache.clear();

    await bot.syncClanRanks();

    check(
      "the member whose own update throws does not stop the member after them in the same pass from being processed",
      updateCalls.some((c) => c.id === "fine")
    );
    check(
      "the failing member's own update was still attempted (not skipped before it even ran)",
      updateCalls.some((c) => c.id === "boom")
    );
    check(
      "the member after the failure still got its rank-up staff alert posted",
      fakeChannel._sent.some((s) => JSON.stringify(s.payload).includes("FineMember"))
    );
    check(
      "a whole pass completes (Rank List gets posted) even though one member failed partway through",
      fakeChannel._sent.length >= 1
    );
  }

  // =========================================================================
  // 2. Consecutive BRAND NEW rank-up alerts are spaced apart, not bursted.
  // =========================================================================
  {
    const todayIso = new Date().toISOString().slice(0, 10);
    const members = [
      { id: "a", rsn: "AlertOne", active: true, xp: 0, tenure_xp: 0, bonus_xp: 3000, confirmed_rank: "Bronze", eligible_rank: "Bronze", weeks_awarded: 0, months_awarded: 0, years_awarded: 0, joined_date: todayIso },
      { id: "b", rsn: "AlertTwo", active: true, xp: 0, tenure_xp: 0, bonus_xp: 3000, confirmed_rank: "Bronze", eligible_rank: "Bronze", weeks_awarded: 0, months_awarded: 0, years_awarded: 0, joined_date: todayIso },
    ];
    const fakeSupabase = makeFakeSupabase({
      clan_members: makeTable({
        select: async () => ({ data: members.map((m) => ({ ...m })), error: null }),
        update: async () => ({ data: null, error: null }),
      }),
      roster_upload: makeTable({ select: async () => ({ data: [], error: null }) }),
      pending_rank_xp: makeTable({ select: async () => ({ data: [], error: null }) }),
      hm_members: makeTable({ select: async () => ({ data: [], error: null }) }),
      hm_audit_log: makeTable({ insert: async () => ({ data: null, error: null }) }),
    });

    bot.config.supabase = fakeSupabase;
    bot.config.rankUpAlertStaggerMs = 120; // small but measurable for the test
    const fakeChannel = makeFakeChannel();
    bot.client.channels.fetch = async () => fakeChannel;
    bot.client.guilds.cache.clear();

    await bot.syncClanRanks();

    const rankUpSends = fakeChannel._sent.filter(
      (s) => JSON.stringify(s.payload).includes("Rank-Up Alert \u2014 AlertOne") || JSON.stringify(s.payload).includes("Rank-Up Alert \u2014 AlertTwo")
    );
    check("both brand-new rank-up alerts were sent", rankUpSends.length === 2);
    check(
      "the two brand-new alerts were spaced apart by roughly the configured stagger instead of firing back to back",
      rankUpSends[1].at - rankUpSends[0].at >= bot.config.rankUpAlertStaggerMs - 20
    );

    // A second pass where the alert is already pending (not fresh) must NOT
    // pay the stagger cost again — only a genuinely new send should.
    bot.client.channels.fetch = async () => fakeChannel; // existingMsg lookup returns null -> re-sends, still "fresh" by id/type check
    const before = Date.now();
    await bot.syncClanRanks();
    // Nothing should have changed rank-eligibility-wise, so no NEW sends — this
    // mainly guards against the stagger delay applying when there's nothing to
    // actually alert on.
    check("a pass with nothing new to alert on completes quickly (no needless stagger)", Date.now() - before < 500);

    bot.config.rankUpAlertStaggerMs = 3000; // restore default for anything after this
  }

  // =========================================================================
  // 3. In-game rename recognized via the Honour Marks /register link instead
  //    of being treated as one member leaving and a new one joining.
  // =========================================================================
  {
    // 3a. The member's existing clan_members row ALREADY carries a user_id
    // (backfilled from an earlier upload) — a rename must update that same
    // row in place, not create a duplicate and not mark the old row as left.
    const existing = [
      { id: 1, rsn: "OldName", user_id: "discord-42", active: true, joined_date: "2026-01-01", tenure_xp: 5000, bonus_xp: 1000, xp: 6000 },
    ];
    const inserts = [];
    const updates = [];
    const fakeSupabase1 = makeFakeSupabase({
      clan_members: makeTable({
        select: async () => ({ data: existing.map((m) => ({ ...m })), error: null }),
        insert: async ({ row }) => { inserts.push(row); return { data: null, error: null }; },
        update: async ({ patch, eqVal }) => { updates.push({ id: eqVal, patch }); return { data: null, error: null }; },
      }),
      hm_members: makeTable({
        select: async () => ({ data: [{ user_id: "discord-42", rsn: "NewName" }], error: null }),
      }),
    });

    const result1 = await bot.importRosterRows(fakeSupabase1, [{ rsn: "NewName", joined_date: "2026-01-01" }]);

    check("a renamed member is NOT inserted as a brand new row", inserts.length === 0);
    check("a renamed member's existing row is updated instead", updates.some((u) => u.id === 1 && u.patch.rsn === "NewName"));
    check("the rename is reported back for staff visibility", result1.renamed.includes("OldName \u2192 NewName"));
    check("a renamed member is not also reported as marked-left", result1.markedLeft.length === 0);
    check("a renamed member is not reported as a new addition", result1.added.length === 0);

    // 3b. No Honour Marks link available at all (hm_members empty/missing) —
    // must behave exactly like before: plain RSN-text matching, old RSN with
    // no matching upload row gets marked left, new RSN gets added fresh.
    const existing2 = [{ id: 2, rsn: "StillOldName", user_id: null, active: true, joined_date: "2026-01-01" }];
    const inserts2 = [];
    const updates2 = [];
    const fakeSupabase2 = makeFakeSupabase({
      clan_members: makeTable({
        select: async () => ({ data: existing2.map((m) => ({ ...m })), error: null }),
        insert: async ({ row }) => { inserts2.push(row); return { data: null, error: null }; },
        update: async ({ patch, eqVal }) => { updates2.push({ id: eqVal, patch }); return { data: null, error: null }; },
      }),
      hm_members: makeTable({ select: async () => ({ data: [], error: null }) }),
    });

    const result2 = await bot.importRosterRows(fakeSupabase2, [{ rsn: "BrandNewPerson", joined_date: "2026-01-01" }]);
    check(
      "with no Honour Marks link at all, an RSN not in the upload is still marked left (unchanged legacy behavior)",
      result2.markedLeft.includes("StillOldName")
    );
    check(
      "with no Honour Marks link at all, a genuinely new RSN is still added fresh (unchanged legacy behavior)",
      result2.added.includes("BrandNewPerson")
    );

    // 3c. Opportunistic backfill: an existing member has no user_id yet, but
    // their (unchanged) RSN now resolves via hm_members — the link should be
    // written onto their row so a FUTURE rename can be recognized.
    const existing3 = [{ id: 3, rsn: "AlreadyRegistered", user_id: null, active: true, joined_date: "2026-01-01" }];
    const updates3 = [];
    const fakeSupabase3 = makeFakeSupabase({
      clan_members: makeTable({
        select: async () => ({ data: existing3.map((m) => ({ ...m })), error: null }),
        insert: async () => ({ data: null, error: null }),
        update: async ({ patch, eqVal }) => { updates3.push({ id: eqVal, patch }); return { data: null, error: null }; },
      }),
      hm_members: makeTable({
        select: async () => ({ data: [{ user_id: "discord-99", rsn: "AlreadyRegistered" }], error: null }),
      }),
    });

    const result3 = await bot.importRosterRows(fakeSupabase3, [{ rsn: "AlreadyRegistered", joined_date: "2026-01-01" }]);
    check(
      "a member's Discord link is backfilled onto their row even when their RSN didn't change this upload",
      updates3.some((u) => u.id === 3 && u.patch.user_id === "discord-99")
    );
    check("backfilling a link alone is not reported as a rename", result3.renamed.length === 0);

    // 3d. The `clan_members.user_id` column doesn't exist yet (migration not
    // run) — inserts/updates must NOT reference it at all, or Postgrest would
    // reject the whole write and break every ordinary roster upload, not just
    // renames. Detected by the existing rows simply not carrying the key.
    const existing4 = [{ id: 4, rsn: "NoMigrationYet", active: true, joined_date: "2026-01-01" }]; // no user_id key at all
    const inserts4 = [];
    const updates4 = [];
    const fakeSupabase4 = makeFakeSupabase({
      clan_members: makeTable({
        select: async () => ({ data: existing4.map((m) => ({ ...m })), error: null }),
        insert: async ({ row }) => { inserts4.push(row); return { data: null, error: null }; },
        update: async ({ patch, eqVal }) => { updates4.push({ id: eqVal, patch }); return { data: null, error: null }; },
      }),
      hm_members: makeTable({
        select: async () => ({ data: [{ user_id: "discord-7", rsn: "BrandNewOnMigrationlessDb" }], error: null }),
      }),
    });

    await bot.importRosterRows(fakeSupabase4, [{ rsn: "BrandNewOnMigrationlessDb", joined_date: "2026-01-01" }]);
    check(
      "before the user_id migration runs, a new member's insert payload never references the column",
      inserts4.length === 1 && !Object.prototype.hasOwnProperty.call(inserts4[0], "user_id")
    );
  }

  console.log(`\n[rank-sync-resilience-and-rename] ${passed} checks passed.`);
})();
