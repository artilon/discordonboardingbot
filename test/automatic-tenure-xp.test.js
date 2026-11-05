// Regression coverage for: "XP isn't updated for time in the clan until I
// upload a new member list." Two things are tested here:
//
//   1. calculateTenureProgression() is a pure, stateless replay from
//      joined_date to "as of now" — it does NOT require a roster re-upload
//      to reflect newly-elapsed tenure. Calling it again later with a later
//      `asOfDate` must show growth on its own.
//   2. isRankSyncDue() — the new 60-second heartbeat check that decides
//      when the next automatic tenure/rank sync should run — correctly
//      gates on "never synced yet", "still in flight", and "interval not
//      elapsed yet" vs "due".
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// ---- 1. Tenure XP grows automatically over elapsed time, no re-upload needed ----
const joinedDate = "2026-10-11"; // Clan Creation Date
const after6Days = new Date("2026-10-17T00:00:00Z"); // before the first weekly milestone
const after8Days = new Date("2026-10-19T00:00:00Z"); // after the first weekly milestone (day 7)
const after40Days = new Date("2026-11-20T00:00:00Z"); // after week 5 + month 1 milestones

const prevAwards = { weeks_awarded: 0, months_awarded: 0, years_awarded: 0 };

const calc6 = bot.calculateTenureProgression(joinedDate, after6Days, prevAwards);
const calc8 = bot.calculateTenureProgression(joinedDate, after8Days, prevAwards);
const calc40 = bot.calculateTenureProgression(joinedDate, after40Days, prevAwards);

check("day 6: no weekly milestone hit yet, xp is 0", calc6.xp === 0);
check("day 8: the day-7 weekly milestone is now reflected automatically", calc8.xp > 0);
check(
  "the SAME prevAwards + member record produces strictly more xp as wall-clock time passes, with no re-upload involved",
  calc40.xp > calc8.xp
);
check("day 40 includes both a weekly and the first monthly milestone", calc40.weeksAwarded >= 5 && calc40.monthsAwarded >= 1);

// Simulate two consecutive automatic background syncs, like the heartbeat
// loop would perform: the second call uses the first call's own awarded
// counters as `prevAwards`, exactly like syncClanRanks() does, and time has
// simply moved forward — nothing else changed, no manual action taken.
const simulatedMember = { weeks_awarded: calc8.weeksAwarded, months_awarded: calc8.monthsAwarded, years_awarded: calc8.yearsAwarded };
const nextAutomaticPass = bot.calculateTenureProgression(joinedDate, after40Days, simulatedMember);
check(
  "a second automatic pass (no upload) further along in time keeps growing xp from where the first pass left off",
  nextAutomaticPass.xp === calc40.xp
);
check(
  "the second automatic pass reports the newly-crossed milestones as new events (for the XP log), not a no-op",
  nextAutomaticPass.newEvents.length > 0
);

// ---- 2. isRankSyncDue() heartbeat gating ----
const TEN_MIN = 10 * 60 * 1000;
const THIRTY_ONE_MIN = 31 * 60 * 1000; // config.rankSyncIntervalMs default is 30 minutes

check("never synced before (lastSyncAt falsy) => due immediately", bot.isRankSyncDue(Date.now(), 0, false) === true);
check("a sync is currently in flight => not due, regardless of elapsed time", bot.isRankSyncDue(Date.now(), 0, true) === false);

const now = Date.now();
check("synced 10 minutes ago (< 30 min interval) => not due yet", bot.isRankSyncDue(now, now - TEN_MIN, false) === false);
check("synced 31 minutes ago (> 30 min interval) => due again, automatically", bot.isRankSyncDue(now, now - THIRTY_ONE_MIN, false) === true);

console.log(`[automatic-tenure-xp.test.js] ${passed} checks passed.`);
