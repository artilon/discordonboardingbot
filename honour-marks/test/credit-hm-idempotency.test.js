"use strict";
/**
 * Tests creditHm idempotency: a retry carrying the same idempotency key
 * must not credit the balance twice (the ledger's idempotency_key is
 * unique — if the award already landed, the balance was already updated).
 * Runs against a fake Supabase client.
 *
 * Run: node test/credit-hm-idempotency.test.js
 */
const assert = require("assert");
const path = require("path");

const { createFakeSupabase } = require("./fake-supabase");

const fake = createFakeSupabase({
  hm_balances: [{ user_id: "u1", guild_id: "g1", balance: 100, total_earned: 100 }],
  hm_transactions: [],
});
const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    getSupabase: () => fake,
    safeQuery: async (_l, fn, fb = null) => {
      try { const r = await fn(); return r?.error ? fb : r; } catch { return fb; }
    },
    getConfigValue: async () => null,
    getConfigJson: async () => null,
  },
};

const { creditHm } = require("../src/quests.js");

let passed = 0;
function check(name, cond) {
  assert(cond, name);
  passed++;
  console.log(`  ok - ${name}`);
}

async function main() {
  const args = { guildId: "g1", userId: "u1", amount: 50, kind: "bounty", reason: "test", idempotencyKey: "bounty:1:u1" };

  const first = await creditHm(args);
  check("first credit succeeds", first.ok === true && first.balance === 150);

  const retry = await creditHm(args);
  check("retry with same key reports duplicate", retry.ok === true && retry.duplicate === true);
  check("retry does not move the balance", retry.balance === 150);

  const bal = fake.db.hm_balances.find((r) => r.user_id === "u1");
  check("stored balance credited exactly once", bal.balance === 150 && bal.total_earned === 150);
  check("exactly one ledger row", fake.db.hm_transactions.length === 1);

  // A different key credits normally (regular operation unaffected).
  const other = await creditHm({ ...args, idempotencyKey: "bounty:2:u1" });
  check("new key credits normally", other.ok === true && other.balance === 200);

  console.log(`\n[credit-hm-idempotency] ${passed} checks passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
