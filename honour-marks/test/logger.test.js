"use strict";
/**
 * Tests the #hm-log logger: resolves the guild's log channel from setup
 * config, posts an embed with the given title/fields, and never throws —
 * including before initLogger, with no setup, or when the channel fetch
 * fails. Runs against a fake Supabase client and a fake Discord client.
 *
 * Run: node test/logger.test.js
 */
const assert = require("assert");
const path = require("path");

const { createFakeSupabase } = require("./fake-supabase");

const fake = createFakeSupabase({
  bot_config: [
    { guild_id: "g1", key: "setup", value: JSON.stringify({ channels: { log: "log-chan" } }) },
  ],
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
    getConfigValue: async (guildId, key) => {
      const { data } = await fake.from("bot_config").select("value").eq("guild_id", guildId).eq("key", key).maybeSingle();
      return data?.value || null;
    },
    getConfigJson: async (guildId, key) => {
      const { data } = await fake.from("bot_config").select("value").eq("guild_id", guildId).eq("key", key).maybeSingle();
      if (!data?.value) return null;
      try { return JSON.parse(data.value); } catch { return null; }
    },
    setConfigValue: async () => true,
  },
};

const { initLogger, logEvent } = require("../src/logger.js");

const sent = [];
const fakeChannel = { send: async (payload) => { sent.push(payload); return {}; } };
const fakeGuild = { channels: { fetch: async (id) => (id === "log-chan" ? fakeChannel : null) } };
const fakeClient = { guilds: { fetch: async () => fakeGuild } };

let passed = 0;
function check(name, cond) {
  assert(cond, name);
  passed++;
  console.log(`  ok - ${name}`);
}

async function main() {
  // Before initLogger: a no-op that never throws.
  await logEvent("g1", { title: "💰 HM Awarded", fields: [{ name: "Member", value: "<@u1>" }] });
  check("no-op before initLogger", sent.length === 0);

  initLogger(fakeClient);

  await logEvent("g1", {
    title: "💰 HM Awarded",
    color: 0x57f287,
    fields: [
      { name: "Member", value: "<@u1>", inline: true },
      { name: "Amount", value: "**50 HM**", inline: true },
      { name: "Reason", value: "daily skill quest complete" },
    ],
  });
  check("posts one embed to the setup log channel", sent.length === 1);
  const embed = sent[0].embeds[0].toJSON();
  check("embed title", embed.title === "💰 HM Awarded");
  check("embed color", embed.color === 0x57f287);
  check("embed fields", embed.fields.length === 3 && embed.fields[0].value === "<@u1>" && embed.fields[1].value === "**50 HM**");
  check("embed has a timestamp", typeof embed.timestamp === "string" && embed.timestamp.length > 0);

  // Guild with no setup row: no channel, no send, no throw.
  await logEvent("g-unknown", { title: "should not send" });
  check("no setup = no send, no throw", sent.length === 1);

  // Channel fetch returns null (deleted channel): no throw.
  fake.db.bot_config.push({ guild_id: "g2", key: "setup", value: JSON.stringify({ channels: { log: "gone" } }) });
  await logEvent("g2", { title: "should not send" });
  check("missing channel = no send, no throw", sent.length === 1);

  console.log(`\n[logger] ${passed} checks passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
