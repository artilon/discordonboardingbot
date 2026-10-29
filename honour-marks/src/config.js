"use strict";
require("dotenv").config();

/**
 * All configuration comes from the environment. Nothing is hardcoded to a
 * guild, because the previous bot's biggest structural problem was that
 * GUILD_ID / channel IDs / role IDs were constants — which makes a second
 * server impossible without a fork.
 *
 * Channel and role IDs are optional. When they're absent, /setup creates them
 * (see src/setup.js). When present, /setup binds to them instead.
 */

function envStr(key, fallback = null) {
  const v = (process.env[key] || "").trim();
  return v.length ? v : fallback;
}

function envInt(key, fallback) {
  const n = parseInt(envStr(key, ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  token: envStr("HM_BOT_TOKEN"),
  clientId: envStr("HM_CLIENT_ID"),

  // Supabase — SAME project as Heimdall, so quest XP can reach the rank ladder.
  supabaseUrl: envStr("SUPABASE_URL"),
  supabaseKey: envStr("SUPABASE_KEY"),

  // Optional: register slash commands to one guild for instant availability.
  // Leave blank for global registration.
  devGuildId: envStr("HM_DEV_GUILD_ID"),

  // Optional pre-existing channels. Blank => /setup creates them.
  channels: {
    quests: envStr("HM_QUESTS_CHANNEL_ID"),
    shop: envStr("HM_SHOP_CHANNEL_ID"),
    database: envStr("HM_DATABASE_CHANNEL_ID"),
    staff: envStr("HM_STAFF_CHANNEL_ID"),
    log: envStr("HM_LOG_CHANNEL_ID"),
  },

  // Optional pre-existing roles.
  roles: {
    staff: envStr("HM_STAFF_ROLE_ID"),
  },

  // ── Economy ───────────────────────────────────────────────────────────────
  // Flat Rank XP per event. Rank is tenure + these; the multiplier is never
  // applied here, because tenure is the only stream that has one.
  rankXp: {
    quest_solo_daily: 100,
    quest_solo_weekly: 250,
    quest_solo_monthly: 750,
    quest_party_duo: 750,
    quest_party_trio: 1200,
    quest_party_quad: 2000,
    tutorial_complete: 500,
  },

  // ── Timers ────────────────────────────────────────────────────────────────
  syncIntervalMs: 30 * 60 * 1000,
  panelRefreshDebounceMs: 8000,
  expirySweepMs: 5 * 60 * 1000,

  // ── Reset boundaries (UTC, fixed to match the original bot) ───────────────
  timezoneLabel: "UTC",
};

/** Throws with a readable message instead of failing later at the first API call. */
function assertConfig() {
  const missing = [];
  if (!config.token) missing.push("HM_BOT_TOKEN");
  if (!config.clientId) missing.push("HM_CLIENT_ID");
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseKey) missing.push("SUPABASE_KEY");
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}.\n` +
        `Copy honour-marks/.env.example to honour-marks/.env and fill it in.`
    );
  }
}

module.exports = { config, assertConfig };
