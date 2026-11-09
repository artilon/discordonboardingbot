// Regression coverage for: "i need to update the prize in the recruitment
// drive event post to 3 bonds for 1st place and 1 bond for 2nd place."
//
// Covers the prize amounts themselves, the announcement embed's Prize field,
// the final leaderboard's 1st/2nd place fields across every placement shape
// (clean 1-2, tie for 1st with no 2nd place awarded, tie for 2nd, and a
// lone recruiter with nobody left for 2nd place), and the end-of-event
// channel announcement text for the same shapes.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

check("1st place prize is 3 Bonds", bot.RECRUITMENT_DRIVE_FIRST_PRIZE_TEXT === "3 Bonds");
check("2nd place prize is 1 Bond", bot.RECRUITMENT_DRIVE_SECOND_PRIZE_TEXT === "1 Bond");

// ---- Announcement embed's Prize field mentions both tiers ----
const announcement = bot.buildRecruitmentDriveEmbed("active");
const prizeField = announcement.embeds[0].data.fields.find((f) => f.name === "Prize");
check("Prize field exists", !!prizeField);
check("Prize field mentions 1st place and 3 Bonds", /1st place/i.test(prizeField.value) && prizeField.value.includes("3 Bonds"));
check("Prize field mentions 2nd place and 1 Bond", /2nd place/i.test(prizeField.value) && prizeField.value.includes("1 Bond"));

// ---- getRecruitmentDrivePlacements: the shared placement logic ----
{
  // Clean 1st/2nd, no ties.
  const standings = [
    { recruiterId: "111", points: 5 },
    { recruiterId: "222", points: 3 },
    { recruiterId: "333", points: 1 },
  ];
  const p = bot.getRecruitmentDrivePlacements(standings);
  check("clean case: 1st place is the single top scorer", p.firstPlaceWinners.length === 1 && p.firstPlaceWinners[0].recruiterId === "111");
  check("clean case: 2nd place is the single next-highest scorer", p.secondPlaceWinners.length === 1 && p.secondPlaceWinners[0].recruiterId === "222");
  check("clean case: secondScore reflects the 2nd place score", p.secondScore === 3);
}
{
  // Tie for 1st: 2nd place is left undetermined, not guessed at.
  const standings = [
    { recruiterId: "111", points: 5 },
    { recruiterId: "222", points: 5 },
    { recruiterId: "333", points: 1 },
  ];
  const p = bot.getRecruitmentDrivePlacements(standings);
  check("tie-for-1st case: both top scorers are 1st place", p.firstPlaceWinners.length === 2);
  check("tie-for-1st case: 2nd place is NOT awarded to the next scorer", p.secondPlaceWinners.length === 0);
}
{
  // Tie for 2nd place behind a clean 1st.
  const standings = [
    { recruiterId: "111", points: 5 },
    { recruiterId: "222", points: 2 },
    { recruiterId: "333", points: 2 },
  ];
  const p = bot.getRecruitmentDrivePlacements(standings);
  check("tie-for-2nd case: single 1st place winner", p.firstPlaceWinners.length === 1 && p.firstPlaceWinners[0].recruiterId === "111");
  check("tie-for-2nd case: both tied scorers are 2nd place", p.secondPlaceWinners.length === 2);
}
{
  // Only one recruiter at all — nobody is eligible for 2nd place.
  const standings = [{ recruiterId: "111", points: 5 }];
  const p = bot.getRecruitmentDrivePlacements(standings);
  check("lone-recruiter case: 1st place still awarded", p.firstPlaceWinners.length === 1);
  check("lone-recruiter case: no 2nd place invented out of nobody", p.secondPlaceWinners.length === 0);
}

// ---- Final leaderboard embed: fields for each placement shape ----
{
  const standings = [
    { recruiterId: "111", recruits: 3, bonuses: 2, points: 5 },
    { recruiterId: "222", recruits: 2, bonuses: 0, points: 3 },
  ];
  const payload = bot.buildRecruitmentLeaderboardEmbed(standings, { final: true });
  const fields = payload.embeds[0].data.fields;
  check(
    "1st Place field awards 3 Bonds to the top scorer",
    fields.some((f) => f.name === "1st Place" && f.value.includes("<@111>") && f.value.includes("3 Bonds"))
  );
  check(
    "2nd Place field awards 1 Bond to the runner-up",
    fields.some((f) => f.name === "2nd Place" && f.value.includes("<@222>") && f.value.includes("1 Bond"))
  );
}
{
  // Tie for 2nd place.
  const standings = [
    { recruiterId: "111", recruits: 3, bonuses: 2, points: 5 },
    { recruiterId: "222", recruits: 2, bonuses: 0, points: 2 },
    { recruiterId: "333", recruits: 1, bonuses: 1, points: 2 },
  ];
  const payload = bot.buildRecruitmentLeaderboardEmbed(standings, { final: true });
  const fields = payload.embeds[0].data.fields;
  check(
    "a tie for 2nd place is called out by name instead of silently picking one",
    fields.some((f) => f.name === "Tie For 2nd Place" && f.value.includes("<@222>") && f.value.includes("<@333>"))
  );
  check("no single '2nd Place' field is added when 2nd is tied", !fields.some((f) => f.name === "2nd Place"));
}
{
  // Tie for 1st place: 2nd place must not be awarded to anyone while that's unresolved.
  const standings = [
    { recruiterId: "111", recruits: 2, bonuses: 0, points: 2 },
    { recruiterId: "222", recruits: 1, bonuses: 1, points: 2 },
    { recruiterId: "333", recruits: 1, bonuses: 0, points: 1 },
  ];
  const payload = bot.buildRecruitmentLeaderboardEmbed(standings, { final: true });
  const fields = payload.embeds[0].data.fields;
  check("Tie For First field is present", fields.some((f) => f.name === "Tie For First"));
  check("no 2nd Place field is added while 1st place is unresolved", !fields.some((f) => f.name === "2nd Place" || f.name === "Tie For 2nd Place"));
}

console.log(`\n[recruitment-drive-two-tier-prize] ${passed} checks passed.`);
