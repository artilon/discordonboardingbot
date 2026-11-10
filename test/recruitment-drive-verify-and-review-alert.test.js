// Regression coverage for: "instead of just a single green button press to
// verify that someone has joined the discord, have 1 for just Verify that
// just verifies the screenshot is correct then it awards them their point or
// adds them to the leaderboard if they werent already. then have a 2nd
// follow up asking if the recruited member joined the discord with a 2nd
// confirmation button to double verify. and whenever a screenshot is posted
// in a thread for the event by the bot, make the bot send an alert to the
// staff alert channel just like the rank up alerts with a 2nd confirmation
// that they have verified it. have it link directly to the embed post
// awaiting confirmation."
//
// Three things are covered here:
//   1. A posted screenshot no longer awards a point by itself — only
//      verifying it does (covered more directly in recruitment-drive.test.js
//      too; re-asserted here as part of the full button flow).
//   2. The thread post's buttons: Verify (1 click) -> follow-up "did they
//      join Discord?" button -> double ("1/2"/"2/2") confirm for the bonus.
//   3. A parallel Staff Alert channel post for every new screenshot. Per
//      explicit product decision this session: the alert is a tracker only
//      (its own double confirm does NOT itself verify anything) and
//      auto-clears if the screenshot gets verified via the thread first.
const assert = require("assert");
const path = require("path");
const { MessageFlags } = require("discord.js");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

function makeMember(roleIds) {
  return { roles: roleIds, displayName: "Staffer" };
}

function makeFakeButtonInteraction(userId, member) {
  const updates = [];
  const replies = [];
  return {
    member,
    user: { id: userId, username: "staffer" },
    guildId: "guild-1",
    update: async (payload) => { updates.push(payload); },
    deferUpdate: async () => {},
    reply: async (payload) => { replies.push(payload); },
    message: { deletable: true, delete: async () => {} },
    _updates: updates,
    _replies: replies,
  };
}

function rowCustomIds(payload) {
  return payload.components.map((row) => row.components.map((c) => c.data.custom_id));
}

function rowLabels(payload) {
  return payload.components.map((row) => row.components.map((c) => c.data.label));
}

const staff = makeMember([bot.OWNER_ROLE_ID]);
const nonStaff = makeMember(["random-role"]);

// ================= buildRecruitmentSubmissionComponents: pure state machine =================

{
  const unverified = { id: "s1", verified: false, join_bonus_awarded: false };
  const payload = { components: bot.buildRecruitmentSubmissionComponents(unverified) };
  check("unverified: exactly one row with one button", payload.components.length === 1 && payload.components[0].components.length === 1);
  check("unverified: button uses the Verify custom id", rowCustomIds(payload)[0][0] === `${bot.ID.RECRUITMENT_VERIFY}:s1`);
  check("unverified: button is not disabled", payload.components[0].components[0].data.disabled !== true);
}
{
  const verified = { id: "s2", verified: true, verified_by_tag: "Mod#0001", join_bonus_awarded: false };
  const payload = { components: bot.buildRecruitmentSubmissionComponents(verified) };
  check("verified (awaiting bonus choice): exactly two rows", payload.components.length === 2);
  check("row 1 is the disabled 'Verified' button naming the staffer", rowLabels(payload)[0][0].includes("Mod#0001") && payload.components[0].components[0].data.disabled === true);
  check("row 2 is the 'Did they join Discord?' (1/2) button", rowCustomIds(payload)[1][0] === `${bot.ID.RECRUITMENT_BONUS_C1}:s2`);
}
{
  const verified = { id: "s3", verified: true, verified_by_tag: "Mod#0001", join_bonus_awarded: false };
  const payload = { components: bot.buildRecruitmentSubmissionComponents(verified, { pendingBonusConfirm: true }) };
  check("pending bonus confirm: row 2 has exactly 2 buttons (confirm + cancel)", payload.components[1].components.length === 2);
  const ids = rowCustomIds(payload)[1];
  check("pending bonus confirm: confirm button uses the dedicated (2/2) custom id", ids.includes(`${bot.ID.RECRUITMENT_BONUS_C2}:s3`));
  check("pending bonus confirm: cancel button uses the dedicated cancel custom id", ids.includes(`${bot.ID.RECRUITMENT_BONUS_CANCEL}:s3`));
}
{
  const done = { id: "s4", verified: true, verified_by_tag: "Mod#0001", join_bonus_awarded: true, join_bonus_awarded_by_tag: "Mod#0002" };
  const payload = { components: bot.buildRecruitmentSubmissionComponents(done) };
  check("fully done: row 2 is disabled and names the staffer who confirmed the bonus", rowLabels(payload)[1][0].includes("Mod#0002") && payload.components[1].components[0].data.disabled === true);
}

(async () => {
  bot.config.supabase = null; // exercise the in-memory fallback store
  bot.recruitmentMemoryStore.submissions = [];
  bot.recruitmentMemoryStore.threads.clear();

  const sentToStaffAlert = [];
  const staffAlertChannel = {
    isTextBased: () => true,
    send: async (payload) => {
      const id = `alert-${sentToStaffAlert.length + 1}`;
      const msg = { id, deletable: true, _deleted: false, delete: async function () { this._deleted = true; } };
      sentToStaffAlert.push({ payload, msg });
      return msg;
    },
    messages: { fetch: async (id) => sentToStaffAlert.find((a) => a.msg.id === id)?.msg || null },
  };
  bot.client.channels.fetch = async (id) => (id === bot.STAFF_ALERT_CHANNEL_ID ? staffAlertChannel : null);

  const subId = await bot.recordRecruitmentSubmission({
    recruiterId: "recruiter-9",
    recruiterTag: "Recruiter9#0001",
    threadId: "thread-9",
    screenshotNumber: 1,
    note: "**Recruited:** NewGuy\n**Joined Discord:** yes",
  });
  await bot.attachRecruitmentSubmissionMessageId(subId, "msg-9");

  // ================= Staff Alert tracker: posted alongside the thread submission =================
  const jumpUrl = bot.recruitmentSubmissionJumpUrl("guild-1", "thread-9", "msg-9");
  check("jump url is a real Discord message link shape", jumpUrl === "https://discord.com/channels/guild-1/thread-9/msg-9");

  const submissionForAlert = await bot.getRecruitmentSubmissionById(subId);
  const alertMsgId = await bot.ensureRecruitmentScreenshotAlert(submissionForAlert, jumpUrl);
  check("the alert was actually sent to the Staff Alert channel", sentToStaffAlert.length === 1);
  check("ensureRecruitmentScreenshotAlert returns the sent message id", alertMsgId === sentToStaffAlert[0].msg.id);

  const alertPayload = sentToStaffAlert[0].payload;
  check("the alert embed mentions it's a review-only tracker, not the real verification", /not.*verif|verify.*post below/i.test(alertPayload.embeds[0].data.description));
  check("the alert embed links directly to the screenshot post", alertPayload.embeds[0].data.description.includes(jumpUrl));
  check("the alert footer says 1 of 2, matching the rank-up alert style", /1 of 2/i.test(alertPayload.embeds[0].data.footer.text));

  const storedSubmission = await bot.getRecruitmentSubmissionById(subId);
  check("the submission row remembers its alert message id", storedSubmission.alert_message_id === alertMsgId);

  // ================= Staff Alert's own double confirm: tracker only, does NOT verify =================
  const alertC1Interaction = makeFakeButtonInteraction("mod-1", staff);
  await bot.onRecruitmentAlertConfirm1(alertC1Interaction, subId);
  check("acknowledging step 1 updates to the step-2 view", alertC1Interaction._updates.length === 1);
  const step2Payload = alertC1Interaction._updates[0];
  check("step 2 footer says 2 of 2", /2 of 2/i.test(step2Payload.embeds[0].data.footer.text));
  check("step 2 still links to the screenshot", step2Payload.embeds[0].data.description.includes(jumpUrl));

  const notYetVerified = await bot.getRecruitmentSubmissionById(subId);
  check("acknowledging the alert does NOT verify the screenshot itself", notYetVerified.verified === false);

  const alertC2Interaction = makeFakeButtonInteraction("mod-1", staff);
  alertC2Interaction.message = sentToStaffAlert[0].msg; // the alert click targets the alert message itself
  await bot.onRecruitmentAlertConfirm2(alertC2Interaction, subId);
  check("confirming step 2 deletes the Staff Alert message", sentToStaffAlert[0].msg._deleted === true);

  const stillUnverifiedAfterAlertDone = await bot.getRecruitmentSubmissionById(subId);
  check("the submission is STILL not verified after the alert tracker is fully confirmed", stillUnverifiedAfterAlertDone.verified === false);
  check("the submission's leaderboard points are unaffected by the tracker alone", (await bot.getRecruitmentStandings()).every((s) => s.recruiterId !== "recruiter-9"));

  // ================= A fresh submission + alert, this time resolved via the Verify button =================
  const subId2 = await bot.recordRecruitmentSubmission({
    recruiterId: "recruiter-10",
    recruiterTag: "Recruiter10#0002",
    threadId: "thread-10",
    screenshotNumber: 1,
    note: "**Recruited:** AnotherGuy\n**Joined Discord:** yes",
  });
  const submissionForAlert2 = await bot.getRecruitmentSubmissionById(subId2);
  const jumpUrl2 = bot.recruitmentSubmissionJumpUrl("guild-1", "thread-10", "msg-10");
  await bot.ensureRecruitmentScreenshotAlert(submissionForAlert2, jumpUrl2);
  check("a second alert was sent for the second submission", sentToStaffAlert.length === 2);

  // ---- Permission gate on Verify ----
  const deniedVerify = makeFakeButtonInteraction("random-user", nonStaff);
  await bot.onRecruitmentVerify(deniedVerify, subId2);
  check("a non-staff member cannot Verify", deniedVerify._replies.length === 1 && deniedVerify._replies[0].flags === MessageFlags.Ephemeral && deniedVerify._updates.length === 0);

  // ---- Verifying actually awards the point AND auto-clears the still-open alert ----
  check("before verifying, recruiter-10 is not on the leaderboard", (await bot.getRecruitmentStandings()).every((s) => s.recruiterId !== "recruiter-10"));

  const verifyInteraction = makeFakeButtonInteraction("mod-2", staff);
  await bot.onRecruitmentVerify(verifyInteraction, subId2);

  check("verifying updates the thread message components", verifyInteraction._updates.length === 1);
  check("after verifying, the follow-up 'did they join Discord?' button appears", rowCustomIds(verifyInteraction._updates[0])[1][0] === `${bot.ID.RECRUITMENT_BONUS_C1}:${subId2}`);

  const afterVerify = await bot.getRecruitmentSubmissionById(subId2);
  check("verifying marks the submission verified", afterVerify.verified === true);
  check("verifying records who verified it", afterVerify.verified_by === "mod-2");

  check("verifying auto-deletes the still-open Staff Alert tracker for this submission", sentToStaffAlert[1].msg._deleted === true);
  check("verifying clears the stored alert_message_id", afterVerify.alert_message_id == null);

  const standingsAfterVerify = await bot.getRecruitmentStandings();
  const recruiter10Standing = standingsAfterVerify.find((s) => s.recruiterId === "recruiter-10");
  check("verifying adds the recruiter to the leaderboard with 1 point", !!recruiter10Standing && recruiter10Standing.recruits === 1 && recruiter10Standing.points === 1);

  // ---- Verifying twice is rejected ----
  const reVerify = makeFakeButtonInteraction("mod-2", staff);
  await bot.onRecruitmentVerify(reVerify, subId2);
  check("verifying an already-verified submission is rejected", reVerify._replies.length === 1 && /already been verified/i.test(reVerify._replies[0].content));

  // ================= The join-bonus double confirm, gated behind verification =================

  // Can't confirm the bonus on an unverified submission.
  const unverifiedBonusAttempt = makeFakeButtonInteraction("mod-2", staff);
  await bot.onRecruitmentBonusConfirm1(unverifiedBonusAttempt, subId);
  check("the bonus flow refuses to proceed on an unverified submission", /verify the screenshot first/i.test(unverifiedBonusAttempt._replies[0].content));

  // Permission gates on both steps.
  const deniedBonus1 = makeFakeButtonInteraction("random-user", nonStaff);
  await bot.onRecruitmentBonusConfirm1(deniedBonus1, subId2);
  check("a non-staff member cannot start the bonus confirm", deniedBonus1._replies.length === 1 && deniedBonus1._updates.length === 0);

  // Step 1 of 2: shows the double-confirm row.
  const bonusC1Interaction = makeFakeButtonInteraction("mod-3", staff);
  await bot.onRecruitmentBonusConfirm1(bonusC1Interaction, subId2);
  check("bonus step 1 shows the final confirm + cancel buttons", bonusC1Interaction._updates[0].components[1].components.length === 2);

  const stillNoBonus = await bot.getRecruitmentSubmissionById(subId2);
  check("the bonus is NOT yet awarded after just step 1", stillNoBonus.join_bonus_awarded === false);

  // Cancel goes back to the single "(1/2)" button, not all the way back to Verify.
  const bonusCancelInteraction = makeFakeButtonInteraction("mod-3", staff);
  await bot.onRecruitmentBonusCancel(bonusCancelInteraction, subId2);
  check("cancelling the bonus confirm reverts to the (1/2) button, not back to Verify", rowCustomIds(bonusCancelInteraction._updates[0])[1][0] === `${bot.ID.RECRUITMENT_BONUS_C1}:${subId2}`);

  // A non-staff member can't slip through on the actual award step either.
  const deniedBonus2 = makeFakeButtonInteraction("random-user", nonStaff);
  await bot.onRecruitmentBonusConfirm2(deniedBonus2, subId2);
  check("a non-staff member cannot complete the bonus confirm", deniedBonus2._replies.length === 1);
  const stillNoBonusAfterDenied = await bot.getRecruitmentSubmissionById(subId2);
  check("the denied attempt did not award the bonus", stillNoBonusAfterDenied.join_bonus_awarded === false);

  // Step 2 of 2: actually awards the bonus.
  const bonusC2Interaction = makeFakeButtonInteraction("mod-3", staff);
  await bot.onRecruitmentBonusConfirm2(bonusC2Interaction, subId2);
  const finalSubmission = await bot.getRecruitmentSubmissionById(subId2);
  check("confirming step 2 awards the bonus", finalSubmission.join_bonus_awarded === true);
  check("confirming step 2 records who awarded it", finalSubmission.join_bonus_awarded_by === "mod-3");
  check("the final button row is disabled and names the staffer", rowLabels(bonusC2Interaction._updates[0])[1][0].includes("Staffer") && bonusC2Interaction._updates[0].components[1].components[0].data.disabled === true);

  const standingsAfterBonus = await bot.getRecruitmentStandings();
  const recruiter10Final = standingsAfterBonus.find((s) => s.recruiterId === "recruiter-10");
  check("the leaderboard reflects both the recruit point and the bonus point", recruiter10Final.recruits === 1 && recruiter10Final.bonuses === 1 && recruiter10Final.points === 2);

  // Awarding the bonus twice is rejected.
  const reBonus = makeFakeButtonInteraction("mod-3", staff);
  await bot.onRecruitmentBonusConfirm2(reBonus, subId2);
  check("confirming an already-awarded bonus a second time is rejected", /already been confirmed/i.test(reBonus._replies[0].content));

  // ---- cleanup ----
  bot.config.supabase = null;
  bot.recruitmentMemoryStore.submissions = [];
  bot.recruitmentMemoryStore.threads.clear();

  console.log(`\n[recruitment-drive-verify-and-review-alert] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
