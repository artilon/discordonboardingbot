// Regression coverage for: "i need to be able to remove someone from the
// recruitment drive leaderboard. a hidden / command only i can use please."
//
// /remove-recruiter is restricted to Owner, Co-Owner & Leader roles (same
// gate as /upload-roster), and is registered with a restrictive
// defaultMemberPermissions so it's hidden from regular members by default.
// Using it permanently wipes every one of the target's Recruitment Drive
// submissions, their thread-mapping row, and deletes their Discord thread —
// gated behind a double ("1 of 2" / "2 of 2") confirmation, matching the
// same destructive-action pattern used elsewhere in this bot (e.g. the
// Member Left alert).
//
// No real Discord connection or Supabase project is used for the in-memory
// path; a lightweight fake Supabase client is used separately to cover the
// Supabase-backed deletion path.
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
  return { roles: roleIds };
}

function makeFakeThread(id) {
  const deleted = { called: false, reason: null };
  return {
    id,
    delete: async (reason) => {
      deleted.called = true;
      deleted.reason = reason;
    },
    _deleted: deleted,
  };
}

function makeFakeChannel(thread) {
  return {
    isTextBased: () => true,
    threads: {
      fetch: async (id) => (id === thread.id ? thread : null),
    },
    messages: {
      fetch: async () => new Map(),
    },
    send: async () => ({ id: "leaderboard-msg" }),
  };
}

function makeFakeCommandInteraction(userId, member, targetUser) {
  const replies = [];
  return {
    member,
    user: { id: userId },
    options: { getUser: () => targetUser },
    reply: async (payload) => { replies.push(payload); },
    _replies: replies,
  };
}

function makeFakeButtonInteraction(userId, member) {
  const updates = [];
  const edits = [];
  const replies = [];
  return {
    member,
    user: { id: userId },
    update: async (payload) => { updates.push(payload); },
    deferUpdate: async () => {},
    editReply: async (payload) => { edits.push(payload); },
    reply: async (payload) => { replies.push(payload); },
    _updates: updates,
    _edits: edits,
    _replies: replies,
  };
}

function firstEmbedText(payload) {
  return payload.embeds
    .map((e) => {
      const fieldsText = (e.data.fields || []).map((f) => `${f.name}: ${f.value}`).join("\n");
      return `${e.data.title || ""}\n${e.data.description || ""}\n${fieldsText}\n${e.data.footer?.text || ""}`;
    })
    .join("\n");
}

// ================= canManageRecruitmentDrive: exact role gate =================

check("Owner can manage the Recruitment Drive leaderboard", bot.canManageRecruitmentDrive(makeMember([bot.OWNER_ROLE_ID])));
check("Co-Owner can manage the Recruitment Drive leaderboard", bot.canManageRecruitmentDrive(makeMember([bot.CO_OWNER_ROLE_ID])));
check("Leader can manage the Recruitment Drive leaderboard", bot.canManageRecruitmentDrive(makeMember([bot.LEADER_ROLE_ID])));
check("Verified Leader can manage the Recruitment Drive leaderboard", bot.canManageRecruitmentDrive(makeMember([bot.VERIFIED_LEADER_ROLE_ID])));
check("A regular clan member CANNOT manage the Recruitment Drive leaderboard", !bot.canManageRecruitmentDrive(makeMember(["some-random-role"])));
check("Someone with no roles CANNOT manage the Recruitment Drive leaderboard", !bot.canManageRecruitmentDrive(makeMember([])));

// ================= The command is registered hidden-by-default =================
// (registerRemoveRecruiterCommand() itself needs a live guild connection to
// actually register with Discord, so this just locks in that the function
// exists and is exported for ClientReady to call.)
check("registerRemoveRecruiterCommand is exported for wiring into ClientReady", typeof bot.registerRemoveRecruiterCommand === "function");

(async () => {
  bot.config.supabase = null; // exercise the in-memory fallback store
  bot.recruitmentMemoryStore.submissions = [];
  bot.recruitmentMemoryStore.threads.clear();

  const thread = makeFakeThread("thread-123");
  const channel = makeFakeChannel(thread);
  bot.client.channels.fetch = async (id) => (id === bot.RECRUITMENT_DRIVE_CHANNEL_ID ? channel : null);
  bot.client.users.fetch = async (id) => ({ id, tag: `User-${id}#0001` });

  const owner = makeMember([bot.OWNER_ROLE_ID]);
  const regular = makeMember(["some-random-role"]);

  // ---- Seed one recruiter with 2 submissions + a bonus, via the real recording helpers ----
  const firstSubId = await bot.recordRecruitmentSubmission({ recruiterId: "recruit-1", recruiterTag: "User-recruit-1#0001", threadId: thread.id, screenshotNumber: 1, note: "n1" });
  const secondSubId = await bot.recordRecruitmentSubmission({ recruiterId: "recruit-1", recruiterTag: "User-recruit-1#0001", threadId: thread.id, screenshotNumber: 2, note: "n2" });
  // Both screenshots need to be staff-verified before they count toward the leaderboard.
  await bot.markRecruitmentSubmissionVerified(firstSubId, "staff-1", "Staff#0001");
  await bot.markRecruitmentSubmissionVerified(secondSubId, "staff-1", "Staff#0001");
  await bot.markRecruitmentBonusAwarded(secondSubId, "staff-1", "Staff#0001");
  bot.recruitmentMemoryStore.threads.set("recruit-1", thread.id);

  const standingsBefore = await bot.getRecruitmentStandings();
  const before = standingsBefore.find((s) => s.recruiterId === "recruit-1");
  check("seed data: recruiter has 2 recruits before removal", before.recruits === 2);
  check("seed data: recruiter has 1 bonus before removal", before.bonuses === 1);
  check("seed data: recruiter has 3 total points before removal (2 recruits + 1 bonus)", before.points === 3);

  // ================= Permission gate on the slash command =================
  const deniedInteraction = makeFakeCommandInteraction("someone", regular, { id: "recruit-1", tag: "User-recruit-1#0001" });
  await bot.onRemoveRecruiterSlashCommand(deniedInteraction);
  check("a non-staff member is denied with an ephemeral reply", deniedInteraction._replies.length === 1 && deniedInteraction._replies[0].flags === MessageFlags.Ephemeral);
  check("the denial message explains who the command IS available to", /Leaders.*Co-Owners.*Owner/s.test(firstEmbedText(deniedInteraction._replies[0])));

  // ================= "Nothing to remove" path =================
  const nothingToRemove = makeFakeCommandInteraction("owner-1", owner, { id: "nobody-here", tag: "Nobody#0000" });
  await bot.onRemoveRecruiterSlashCommand(nothingToRemove);
  check("a recruiter with zero submissions gets a 'nothing to remove' reply, not the confirm flow", /no Recruitment Drive submissions/i.test(firstEmbedText(nothingToRemove._replies[0])));
  check("the 'nothing to remove' reply is ephemeral", nothingToRemove._replies[0].flags === MessageFlags.Ephemeral);

  // ================= Step 1: staff member runs the command on someone with points =================
  const target = { id: "recruit-1", tag: "User-recruit-1#0001" };
  const step1Interaction = makeFakeCommandInteraction("owner-1", owner, target);
  await bot.onRemoveRecruiterSlashCommand(step1Interaction);

  check("step 1 reply is ephemeral", step1Interaction._replies[0].flags === MessageFlags.Ephemeral);
  const step1Text = firstEmbedText(step1Interaction._replies[0]);
  check("step 1 shows the recruit count", step1Text.includes("2"));
  check("step 1 mentions it's permanent/irreversible", /permanently|cannot be undone/i.test(step1Text));
  check("step 1 has exactly one button (acknowledge)", step1Interaction._replies[0].components[0].components.length === 1);
  const step1ButtonId = step1Interaction._replies[0].components[0].components[0].data.custom_id;
  check("step 1's button uses the dedicated custom id with the recruiter's id", step1ButtonId === `${bot.ID.RECRUITMENT_REMOVE_C1}:recruit-1`);

  // ================= Step 2: clicking acknowledge shows the final double-confirmation =================
  const c1Interaction = makeFakeButtonInteraction("owner-1", owner);
  await bot.onRecruitmentRemoveConfirm1(c1Interaction, "recruit-1");
  check("clicking step 1 updates (not replies) the ephemeral message", c1Interaction._updates.length === 1 && c1Interaction._replies.length === 0);
  const step2Payload = c1Interaction._updates[0];
  const step2Text = firstEmbedText(step2Payload);
  check("step 2 footer signals '2 of 2'", /2 of 2/i.test(step2Text));
  check("step 2 has two buttons: confirm + cancel", step2Payload.components[0].components.length === 2);
  const step2ButtonIds = step2Payload.components[0].components.map((c) => c.data.custom_id);
  check("step 2's confirm button uses the dedicated custom id", step2ButtonIds.includes(`${bot.ID.RECRUITMENT_REMOVE_C2}:recruit-1`));
  check("step 2's cancel button uses the dedicated custom id", step2ButtonIds.includes(`${bot.ID.RECRUITMENT_REMOVE_CANCEL}:recruit-1`));

  // ================= Cancel: goes back to step 1, doesn't delete anything =================
  const cancelInteraction = makeFakeButtonInteraction("owner-1", owner);
  await bot.onRecruitmentRemoveCancel(cancelInteraction, "recruit-1");
  check("cancel goes back to the step-1 view", cancelInteraction._updates.length === 1 && /2 of 2/i.test(firstEmbedText(cancelInteraction._updates[0])) === false);
  const standingsAfterCancel = await bot.getRecruitmentStandings();
  check("cancelling does NOT remove the recruiter's submissions", standingsAfterCancel.some((s) => s.recruiterId === "recruit-1"));

  // ================= Permission gate re-checked on the actual destructive step =================
  const deniedC2 = makeFakeButtonInteraction("sneaky", regular);
  await bot.onRecruitmentRemoveConfirm2(deniedC2, "recruit-1");
  check("a non-staff user cannot slip through to the actual deletion step", deniedC2._replies.length === 1 && deniedC2._edits.length === 0);
  const standingsAfterDeniedC2 = await bot.getRecruitmentStandings();
  check("the denied deletion attempt did not remove anything", standingsAfterDeniedC2.some((s) => s.recruiterId === "recruit-1"));

  // ================= Confirm 2/2: actually performs the removal =================
  const c2Interaction = makeFakeButtonInteraction("owner-1", owner);
  await bot.onRecruitmentRemoveConfirm2(c2Interaction, "recruit-1");

  check("confirming step 2 edits the deferred reply with a success embed", c2Interaction._edits.length === 1);
  const doneText = firstEmbedText(c2Interaction._edits[0]);
  check("the success embed confirms the removal", /removed/i.test(doneText));
  check("the success embed reports the 2 deleted submissions", doneText.includes("2"));
  check("the success embed confirms the thread was deleted", /thread deleted/i.test(doneText));
  check("the final view has no buttons left", c2Interaction._edits[0].components.length === 0);

  check("the recruiter's thread was actually deleted", thread._deleted.called === true);

  const standingsAfterRemoval = await bot.getRecruitmentStandings();
  check("the recruiter no longer appears on the leaderboard at all", !standingsAfterRemoval.some((s) => s.recruiterId === "recruit-1"));
  check("the recruiter's thread mapping was cleared from the in-memory store", !bot.recruitmentMemoryStore.threads.has("recruit-1"));

  // Removing again should now report "nothing to remove."
  const secondRemovalAttempt = makeFakeCommandInteraction("owner-1", owner, target);
  await bot.onRemoveRecruiterSlashCommand(secondRemovalAttempt);
  check("removing the same recruiter again reports nothing left to remove", /no Recruitment Drive submissions/i.test(firstEmbedText(secondRemovalAttempt._replies[0])));

  // ---- cleanup ----
  bot.config.supabase = null;
  bot.recruitmentMemoryStore.submissions = [];
  bot.recruitmentMemoryStore.threads.clear();

  console.log(`\n[recruitment-drive-remove-recruiter] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
