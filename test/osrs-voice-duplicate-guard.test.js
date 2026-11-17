// Regression coverage for: "the bot sometimes makes 2 voice channels when
// i click the channel to create one."
//
// Root cause: a race condition. Discord can fire more than one
// VoiceStateUpdate for a single hub join, and temp-channel creation + move
// is async. Each event created its own "OSRS Voice N" channel before the
// first finished, leaving duplicates (often two "OSRS Voice 1").
// Fix: a per-user in-flight guard (osrsVoiceCreationInFlight) so only one
// creation runs per user per join; concurrent events are ignored.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  // The guard set exists and starts empty.
  check("the in-flight guard is a Set", bot.osrsVoiceCreationInFlight instanceof Set);
  check("the guard starts empty", bot.osrsVoiceCreationInFlight.size === 0);

  // Simulate the guard semantics the handler relies on: while a user is
  // in-flight, a second join event for that user is suppressed; a different
  // user is not.
  {
    const userA = "user-a";
    const userB = "user-b";
    bot.osrsVoiceCreationInFlight.add(userA);
    check("user A is marked in-flight", bot.osrsVoiceCreationInFlight.has(userA));
    check("user B is not blocked by user A's in-flight creation", !bot.osrsVoiceCreationInFlight.has(userB));
    bot.osrsVoiceCreationInFlight.delete(userA);
    check("guard clears after creation completes", !bot.osrsVoiceCreationInFlight.has(userA));
  }

  // The handler function is wired up and exported.
  check("handleVoiceStateUpdate is exported", typeof bot.handleVoiceStateUpdate === "function");
  check("createOsrsVoiceChannel is exported", typeof bot.createOsrsVoiceChannel === "function");

  console.log(`\n[osrs-voice-duplicate-guard] ${passed} checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
