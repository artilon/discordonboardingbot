"use strict";
const { createClient } = require("@supabase/supabase-js");
const { config } = require("./config");

/**
 * Node 18 had no global WebSocket, and @supabase/realtime-js hard-requires one
 * the moment you .subscribe(). Polyfilling here keeps Realtime working on any
 * Node 22+ image without depending on the build target.
 */
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = require("ws");
}

// A default Supabase client has NO request timeout. One stalled connection
// hangs the await forever, and since every interaction path awaits a query,
// that makes the whole bot look frozen for everyone. Fail loudly instead.
const SUPABASE_TIMEOUT_MS = 20000;
function supabaseFetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

let client = null;

function getSupabase() {
  if (client) return client;
  if (!config.supabaseUrl || !config.supabaseKey) return null;
  client = createClient(config.supabaseUrl, config.supabaseKey, {
    global: { fetch: supabaseFetchWithTimeout },
    auth: { persistSession: false },
  });
  return client;
}

/**
 * PostgREST builders are thenables, not promises — they have no `.catch()`.
 * `await supabase.from(..).insert(..).catch(..)` throws "catch is not a
 * function", which is exactly the bug that took Heimdall down on Railway.
 * Always use try/catch around await, never .catch() on a builder.
 */
async function safeQuery(label, fn, fallback = null) {
  try {
    const result = await fn();
    if (result && result.error) {
      console.error(`[DB] ${label}:`, result.error.message);
      return fallback;
    }
    return result;
  } catch (e) {
    console.error(`[DB] ${label} threw:`, e.message);
    return fallback;
  }
}

/** Reads a value from bot_config for a guild. */
async function getConfigValue(guildId, key) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from("bot_config")
    .select("value")
    .eq("guild_id", guildId)
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? null;
}

/** JSON-tolerant config read. */
async function getConfigJson(guildId, key) {
  const raw = await getConfigValue(guildId, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setConfigValue(guildId, key, value) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from("bot_config").upsert(
    {
      guild_id: guildId,
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "guild_id,key" }
  );
  if (error) {
    console.error(`[DB] setConfigValue(${key}):`, error.message);
    return false;
  }
  return true;
}

async function deleteConfigValue(guildId, key) {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.from("bot_config").delete().eq("guild_id", guildId).eq("key", key);
  } catch { /* best effort */ }
}

module.exports = {
  getSupabase,
  safeQuery,
  getConfigValue,
  getConfigJson,
  setConfigValue,
  deleteConfigValue,
};
