"use strict";
/**
 * Tests the panel ledger — the part that actually decides whether the bot
 * survives the embed character limit. Runs against a fake Supabase client and
 * a fake channel, so it exercises the real reconciliation logic end to end.
 *
 * Run: node test/ledger.test.js
 */
const assert = require("assert");
const path = require("path");

const { createFakeSupabase } = require("./fake-supabase");

// Point ./src/db at the fake before anything requires it.
const fake = createFakeSupabase({
  hm_panels: [],
  bot_config: [],
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
    setConfigValue: async () => true,
    deleteConfigValue: async () => {},
  },
};

const { syncPanel } = require("../src/panels");

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

/**
 * Discord's Collection has .fetch(id) on the messages manager, so the double
 * has to expose the same shape: channel.messages.fetch(id).
 */
class MessageStore extends Map {
  constructor(channel) {
    super();
    this.channel = channel;
  }
  async fetch(id) {
    const msg = this.get(id);
    if (!msg) return null;
    const channel = this.channel;
    return {
      id,
      edit: async (p) => { Object.assign(msg, p); channel.edits += 1; },
      delete: async () => { this.delete(id); channel.deletes += 1; },
    };
  }
}

/** Minimal channel double: tracks messages by id, supports send/fetch/delete. */
function makeChannel() {
  const channel = {
    id: "chan-1",
    deletes: 0,
    sends: 0,
    edits: 0,
    async send(payload) {
      const id = `msg-${++channel._nextId}`;
      channel._nextId = channel._nextId || 0;
      channel.messages.set(id, { id, ...payload });
      channel.sends += 1;
      return {
        id,
        edit: async (p) => { Object.assign(channel.messages.get(id), p); channel.edits += 1; return true; },
        delete: async () => { channel.messages.delete(id); channel.deletes += 1; return true; },
      };
    },
  };
  channel._nextId = 1;
  channel.messages = new MessageStore(channel);
  return channel;
}

function page(n) {
  return { embed: { page: n }, components: [] };
}

(async () => {
  const guildId = "g1";
  const channel = makeChannel();

  console.log("\n[panel ledger]");

  // ── 1. first render posts every page ──────────────────────────────────────
  let res = await syncPanel(guildId, channel, "database", [page(0), page(1), page(2)]);
  assert.strictEqual(res.posted, 3, "should post 3 pages");
  assert.strictEqual(channel.messages.size, 3);
  check("first render posts all pages", () => {});

  // ── 2. re-render edits in place, posts nothing new ────────────────────────
  const before = channel.sends;
  res = await syncPanel(guildId, channel, "database", [page(0), page(1), page(2)]);
  assert.strictEqual(res.edited, 3);
  assert.strictEqual(channel.sends, before, "should not post again");
  check("re-render edits in place", () => {});

  // ── 3. growth adds exactly one page ───────────────────────────────────────
  res = await syncPanel(guildId, channel, "database", [page(0), page(1), page(2), page(3)]);
  assert.strictEqual(res.posted, 1, "should add one page");
  assert.strictEqual(channel.messages.size, 4);
  check("growth adds a page", () => {});

  // ── 4. shrinkage deletes the surplus and clears the ledger ────────────────
  res = await syncPanel(guildId, channel, "database", [page(0), page(1)]);
  assert.strictEqual(res.deleted, 2, "should delete two surplus pages");
  assert.strictEqual(channel.messages.size, 2);
  assert.strictEqual(fake.db.hm_panels.length, 2, "ledger must not keep stale rows");
  check("shrinkage deletes surplus and prunes ledger", () => {});

  // ── 5. a moderator deleting a message self-heals ──────────────────────────
  const firstId = [...channel.messages.keys()][0];
  channel.messages.delete(firstId); // simulate manual deletion
  res = await syncPanel(guildId, channel, "database", [page(0), page(1)]);
  assert.strictEqual(res.posted, 1, "deleted page should be reposted");
  assert.strictEqual(channel.messages.size, 2);
  check("manually deleted page is reposted", () => {});

  // ── 6. ledger rows survive and point at live messages ─────────────────────
  const liveIds = new Set(channel.messages.keys());
  for (const row of fake.db.hm_panels) {
    assert.ok(liveIds.has(row.message_id), `ledger row points at dead message ${row.message_id}`);
  }
  check("every ledger row points at a live message", () => {});

  // ── 7. two panels in one channel don't collide ────────────────────────────
  await syncPanel(guildId, channel, "shop", [page("shop-0")]);
  await syncPanel(guildId, channel, "quest_board", [page("qb-0"), page("qb-1")]);
  const dbRows = fake.db.hm_panels.filter((r) => r.panel_key === "database");
  assert.strictEqual(dbRows.length, 2, "database pages untouched by other panels");
  assert.strictEqual(fake.db.hm_panels.filter((r) => r.panel_key === "shop").length, 1);
  assert.strictEqual(fake.db.hm_panels.filter((r) => r.panel_key === "quest_board").length, 2);
  check("panels are isolated by panel_key", () => {});

  // ── 8. an empty panel still leaves exactly one page ───────────────────────
  await syncPanel(guildId, channel, "quest_board", [page("only")]);
  assert.strictEqual(fake.db.hm_panels.filter((r) => r.panel_key === "quest_board").length, 1);
  check("shrinking to one page prunes the rest", () => {});

  console.log(`\n${passed} checks passed.\n`);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
