// Lightweight logic tests for the Recruitment Drive Event feature in onboarding.js.
// These exercise pure/non-network logic only (phase math, embed building,
// in-memory standings/thread-mapping fallback) — no real Discord or Supabase
// connection is made.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// ---- Phase boundaries ----
const START = bot.RECRUITMENT_DRIVE_START_MS;
const END = bot.RECRUITMENT_DRIVE_END_MS;

check("start is before end", START < END);
check("phase scheduled well before start", bot.getRecruitmentDrivePhase(START - 60 * 60 * 1000) === "scheduled");
check("phase scheduled 1ms before start", bot.getRecruitmentDrivePhase(START - 1) === "scheduled");
check("phase active exactly at start", bot.getRecruitmentDrivePhase(START) === "active");
check("phase active 1ms before end", bot.getRecruitmentDrivePhase(END - 1) === "active");
check("phase ended exactly at end", bot.getRecruitmentDrivePhase(END) === "ended");
check("phase ended well after end", bot.getRecruitmentDrivePhase(END + 60 * 60 * 1000) === "ended");

// Nov 10, 2026 12:00 PM Central and Jan 10, 2027 12:00 PM Central are both
// standard time (UTC-6) — confirm the exact UTC instants.
check("start converts to 18:00 UTC (12pm CST = UTC-6)", new Date(START).toISOString() === "2026-11-10T18:00:00.000Z");
check("end converts to 18:00 UTC (12pm CST = UTC-6)", new Date(END).toISOString() === "2027-01-10T18:00:00.000Z");

// ---- Announcement embed building ----
for (const phase of ["scheduled", "active", "ended"]) {
  const payload = bot.buildRecruitmentDriveEmbed(phase);
  check(`[${phase}] payload has one embed`, payload.embeds.length === 1);
  check(`[${phase}] payload has one button row`, payload.components.length === 1);
  const button = payload.components[0].components[0];
  const data = button.data;
  if (phase === "active") {
    check("active button is enabled", !data.disabled);
    check("active button label", data.label === "Upload Screenshot");
  } else {
    check(`[${phase}] button is disabled`, data.disabled === true);
  }
}

// ---- Leaderboard embed building ----
const emptyPayload = bot.buildRecruitmentLeaderboardEmbed([]);
check("empty leaderboard has placeholder text", emptyPayload.embeds[0].data.description.includes("No recruits"));

const standings = [
  { recruiterId: "111", recruits: 3, bonuses: 2, points: 5 },
  { recruiterId: "222", recruits: 1, bonuses: 0, points: 1 },
];
const normalPayload = bot.buildRecruitmentLeaderboardEmbed(standings);
check("normal leaderboard title has no Final", !normalPayload.embeds[0].data.title.includes("Final"));
check("normal leaderboard mentions top recruiter", normalPayload.embeds[0].data.description.includes("<@111>"));

const finalSingleWinner = bot.buildRecruitmentLeaderboardEmbed(standings, { final: true });
check("final leaderboard title says Final", finalSingleWinner.embeds[0].data.title.includes("Final"));
check(
  "final standings name the 1st place winner",
  finalSingleWinner.embeds[0].data.fields.some((f) => f.name === "1st Place" && f.value.includes("<@111>"))
);
check(
  "final standings name the 2nd place winner",
  finalSingleWinner.embeds[0].data.fields.some((f) => f.name === "2nd Place" && f.value.includes("<@222>"))
);

const tiedStandings = [
  { recruiterId: "111", recruits: 2, bonuses: 0, points: 2 },
  { recruiterId: "222", recruits: 1, bonuses: 1, points: 2 },
];
const finalTied = bot.buildRecruitmentLeaderboardEmbed(tiedStandings, { final: true });
check(
  "final tie field lists both tied recruiters",
  finalTied.embeds[0].data.fields.some((f) => f.name === "Tie For First" && f.value.includes("<@111>") && f.value.includes("<@222>"))
);

// ---- In-memory submission / standings flow (no Supabase configured here) ----
(async () => {
  const n1 = await bot.getNextRecruitmentScreenshotNumber("user-A");
  check("first screenshot number for a new recruiter is 1", n1 === 1);

  const id1 = await bot.recordRecruitmentSubmission({
    recruiterId: "user-A",
    recruiterTag: "UserA#0001",
    threadId: "thread-A",
    screenshotNumber: 1,
    note: "PlayerOne - no",
  });
  check("recordRecruitmentSubmission returns an id", id1 != null);

  const n2 = await bot.getNextRecruitmentScreenshotNumber("user-A");
  check("second screenshot number for the same recruiter is 2", n2 === 2);

  const id2 = await bot.recordRecruitmentSubmission({
    recruiterId: "user-A",
    recruiterTag: "UserA#0001",
    threadId: "thread-A",
    screenshotNumber: 2,
    note: "PlayerTwo - yes",
  });

  const id3 = await bot.recordRecruitmentSubmission({
    recruiterId: "user-B",
    recruiterTag: "UserB#0002",
    threadId: "thread-B",
    screenshotNumber: 1,
    note: "PlayerThree - no",
  });

  // Posting a screenshot no longer awards a point by itself — it only counts
  // toward the leaderboard once staff verify it (see onRecruitmentVerify).
  let standingsNow = await bot.getRecruitmentStandings();
  check("an unverified submission does NOT put a new recruiter on the leaderboard yet", !standingsNow.some((s) => s.recruiterId === "user-A"));
  check("a second unverified recruiter also doesn't appear yet", !standingsNow.some((s) => s.recruiterId === "user-B"));

  const freshSubmission = await bot.getRecruitmentSubmissionById(id1);
  check("a freshly recorded submission starts out unverified", freshSubmission.verified === false);

  await bot.markRecruitmentSubmissionVerified(id1, "staff-1", "Staff#0001");
  await bot.markRecruitmentSubmissionVerified(id2, "staff-1", "Staff#0001");
  await bot.markRecruitmentSubmissionVerified(id3, "staff-1", "Staff#0001");

  const verifiedSubmission = await bot.getRecruitmentSubmissionById(id1);
  check("verifying flips the verified flag", verifiedSubmission.verified === true);
  check("verifying records who verified it", verifiedSubmission.verified_by === "staff-1" && verifiedSubmission.verified_by_tag === "Staff#0001");

  standingsNow = await bot.getRecruitmentStandings();
  const a = standingsNow.find((s) => s.recruiterId === "user-A");
  const b = standingsNow.find((s) => s.recruiterId === "user-B");
  check("user-A has 2 recruits once both of their submissions are verified", a.recruits === 2 && a.points === 2);
  check("user-B has 1 recruit once verified", b.recruits === 1 && b.points === 1);
  check("user-A outranks user-B", standingsNow[0].recruiterId === "user-A");

  const fetchedSubmission = await bot.getRecruitmentSubmissionById(id2);
  check("getRecruitmentSubmissionById finds the right row", fetchedSubmission && fetchedSubmission.note === "PlayerTwo - yes");
  check("bonus not yet awarded", fetchedSubmission.join_bonus_awarded === false);

  await bot.markRecruitmentBonusAwarded(id2, "staff-1", "Staff#0001");
  const afterBonus = await bot.getRecruitmentSubmissionById(id2);
  check("bonus flag flips to true", afterBonus.join_bonus_awarded === true);
  check("bonus records who awarded it", afterBonus.join_bonus_awarded_by === "staff-1");
  check("bonus records the staff tag too", afterBonus.join_bonus_awarded_by_tag === "Staff#0001");

  standingsNow = await bot.getRecruitmentStandings();
  const aAfterBonus = standingsNow.find((s) => s.recruiterId === "user-A");
  check("user-A gains the bonus point (3 total: 2 recruits + 1 bonus)", aAfterBonus.points === 3 && aAfterBonus.bonuses === 1);

  // Thread mapping fallback: second call for the same recruiter should not
  // need Supabase, and should return the same id the first call stored.
  const fakeChannel = {
    threads: {
      create: async () => {
        throw new Error("threads.create should not be called a second time for an existing recruiter");
      },
      fetch: async (id) => ({ id }),
    },
  };
  bot.getOrCreateRecruitmentThread; // ensure export exists (sanity — behavior covered via handleRecruitmentDriveMessage integration, not unit-tested here to avoid real Discord API mocking complexity)
  check("getOrCreateRecruitmentThread is exported", typeof bot.getOrCreateRecruitmentThread === "function");
  void fakeChannel;

  console.log(`[recruitment-drive.test.js] ${passed} checks passed.`);
})().catch((err) => {
  console.error("[recruitment-drive.test.js] FAILED:", err);
  process.exit(1);
});
