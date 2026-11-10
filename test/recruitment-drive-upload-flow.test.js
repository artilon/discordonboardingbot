// Regression coverage for: simplifying the Recruitment Drive screenshot
// upload flow. Members used to have to type a specific free-text caption
// ("PlayerName123 - no, not on Discord yet") in the SAME message as their
// screenshot, which was confusing. Now "Upload Screenshot" opens a small
// 2-field modal (recruited player's name, joined Discord yet?) first, and
// afterward the member just posts the plain screenshot image with no
// caption required at all.
//
// No real Discord connection or Supabase project is used — config.supabase
// stays null so the code's in-memory fallback store is exercised, and
// client.channels.fetch / the interaction objects are lightweight fakes.
const assert = require("assert");
const path = require("path");
const { MessageFlags } = require("discord.js");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

function makeFakeThread(id) {
  const sent = [];
  return {
    id,
    send: async (payload) => { sent.push(payload); return { id: `msg-${id}` }; },
    _sent: sent,
  };
}

function makeFakeChannel() {
  const sentToChannel = [];
  const thread = makeFakeThread("thread-1");
  return {
    isTextBased: () => true,
    threads: {
      create: async () => thread,
      fetch: async () => null,
    },
    send: async (payload) => { sentToChannel.push(payload); return { id: "chan-msg", delete: async () => {} }; },
    // Mirrors discord.js's real two call shapes: fetch(id) fetches ONE message (throws if
    // missing), fetch({limit, before}) fetches a page (a Collection, possibly empty).
    messages: {
      fetch: async (arg) => {
        if (typeof arg === "string") throw new Error("Unknown Message");
        return new Map();
      },
    },
    _sentToChannel: sentToChannel,
    _thread: thread,
  };
}

function makeFakeButtonInteraction(userId = "recruiter-1") {
  const shown = [];
  const replies = [];
  return {
    user: { id: userId, tag: "Recruiter#0001", username: "Recruiter" },
    showModal: async (modal) => { shown.push(modal); },
    reply: async (payload) => { replies.push(payload); },
    _shown: shown,
    _replies: replies,
  };
}

function makeFakeModalSubmitInteraction(userId, fieldValues) {
  const replies = [];
  return {
    user: { id: userId, tag: "Recruiter#0001", username: "Recruiter" },
    fields: {
      getTextInputValue: (id) => fieldValues[id],
    },
    reply: async (payload) => { replies.push(payload); },
    _replies: replies,
  };
}

function makeFakeMessage({ authorId, hasImage, content = "", channel }) {
  const deleted = { called: false };
  const attachments = hasImage
    ? { first: () => ({ url: "https://example.com/shot.png", name: "shot.png", contentType: "image/png" }) }
    : { first: () => null };
  return {
    author: { id: authorId, tag: "Recruiter#0001", username: "Recruiter", bot: false },
    member: { id: authorId, displayName: "Recruiter", user: { username: "Recruiter" } },
    content,
    attachments,
    channel,
    delete: async () => { deleted.called = true; },
    _deleted: deleted,
  };
}

(async () => {
  bot.config.supabase = null; // force the in-memory fallback store so no Supabase mocking is needed

  const originalFetch = global.fetch;
  global.fetch = async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });

  const channel = makeFakeChannel();
  bot.client.channels.fetch = async (id) => (id === bot.RECRUITMENT_DRIVE_CHANNEL_ID ? channel : null);

  // ================= Step 1: clicking "Upload Screenshot" shows a modal, not plain text =================
  const btnInteraction = makeFakeButtonInteraction("recruiter-42");
  await bot.onRecruitmentUploadButton(btnInteraction);

  check("clicking Upload Screenshot shows a modal instead of just replying with instructions", btnInteraction._shown.length === 1);
  check("no plain-text reply was sent at this step", btnInteraction._replies.length === 0);

  const modal = btnInteraction._shown[0];
  check("the modal uses the dedicated Recruitment Info custom id", modal.data.custom_id === bot.ID.RECRUITMENT_INFO_MODAL);

  const modalInputs = modal.components.flatMap((row) => row.components.map((c) => c.data));
  check("the modal has exactly two fields", modalInputs.length === 2);
  check(
    "one field asks for the recruited player's name",
    modalInputs.some((f) => f.custom_id === bot.ID.RECRUITMENT_NAME_INPUT)
  );
  check(
    "the other field asks whether they've joined Discord",
    modalInputs.some((f) => f.custom_id === bot.ID.RECRUITMENT_JOINED_DISCORD_INPUT)
  );
  check("both fields are required", modalInputs.every((f) => f.required === true));

  // ================= Step 2: submitting the modal stores the answers and tells them to just post the image =================
  const modalInteraction = makeFakeModalSubmitInteraction("recruiter-42", {
    [bot.ID.RECRUITMENT_NAME_INPUT]: "NewRecruit99",
    [bot.ID.RECRUITMENT_JOINED_DISCORD_INPUT]: "yes",
  });
  await bot.onRecruitmentInfoModalSubmit(modalInteraction);

  const session = bot.pendingRecruitmentUploads.get("recruiter-42");
  check("submitting the modal records a pending session for this member", !!session);
  check("the session remembers the recruited player's name", session.playerName === "NewRecruit99");
  check("the session remembers the Discord-join answer", session.joinedDiscord === "yes");
  check("the session has an expiry in the future", session.expiresAt > Date.now());

  const confirmReply = modalInteraction._replies[0];
  check("the confirmation reply tells them to post the screenshot next", /post your screenshot/i.test(confirmReply.content));
  check("the confirmation reply no longer asks them to type a caption/format", !/same message/i.test(confirmReply.content));
  check("the confirmation reply is ephemeral", confirmReply.flags === MessageFlags.Ephemeral);

  // ================= Step 3: posting ONLY the image (no caption) completes the submission =================
  const message = makeFakeMessage({ authorId: "recruiter-42", hasImage: true, content: "", channel });
  await bot.handleRecruitmentDriveMessage(message);

  check("the original channel message is deleted (keeps the channel from flooding)", message._deleted.called === true);
  check(
    "the screenshot itself never gets posted to the public channel (only the existing leaderboard panel refresh, if any, touches the channel)",
    channel._sentToChannel.every((p) => !p.embeds?.some((e) => e.data?.image))
  );
  check("exactly one message was posted into the member's thread", channel._thread._sent.length === 1);

  const threadPost = channel._thread._sent[0];
  const detailsField = threadPost.embeds[0].data.fields.find((f) => f.name === "Details");
  check("the thread post's Details field includes the recruited player's name", detailsField.value.includes("NewRecruit99"));
  check("the thread post's Details field includes the Discord-join answer", detailsField.value.includes("yes"));
  check("the session is cleared after a successful submission", !bot.pendingRecruitmentUploads.has("recruiter-42"));

  // ================= Edge case: posting an image with NO prior modal submission =================
  const noSessionMessage = makeFakeMessage({ authorId: "recruiter-no-session", hasImage: true, channel });
  await bot.handleRecruitmentDriveMessage(noSessionMessage);
  check("a screenshot with no pending session is deleted rather than accepted", noSessionMessage._deleted.called === true);
  check("no thread post was made for a member with no session", channel._thread._sent.length === 1); // still just the one from before

  // ================= Edge case: active session but the message has no image attached =================
  const btnInteraction2 = makeFakeButtonInteraction("recruiter-99");
  await bot.onRecruitmentUploadButton(btnInteraction2);
  const modalInteraction2 = makeFakeModalSubmitInteraction("recruiter-99", {
    [bot.ID.RECRUITMENT_NAME_INPUT]: "AnotherRecruit",
    [bot.ID.RECRUITMENT_JOINED_DISCORD_INPUT]: "no",
  });
  await bot.onRecruitmentInfoModalSubmit(modalInteraction2);

  const textOnlyMessage = makeFakeMessage({ authorId: "recruiter-99", hasImage: false, content: "oops no image", channel });
  await bot.handleRecruitmentDriveMessage(textOnlyMessage);
  check("a message with an active session but no image is still deleted", textOnlyMessage._deleted.called === true);
  check("the session stays open so they can retry with the actual screenshot", bot.pendingRecruitmentUploads.has("recruiter-99"));

  // Retry with the real screenshot now succeeds using the SAME session (no modal re-submission needed).
  const retryMessage = makeFakeMessage({ authorId: "recruiter-99", hasImage: true, channel });
  await bot.handleRecruitmentDriveMessage(retryMessage);
  check("retrying with the actual screenshot completes the submission", channel._thread._sent.length === 2);
  check("the session is cleared after the retry succeeds", !bot.pendingRecruitmentUploads.has("recruiter-99"));

  // ---- cleanup ----
  global.fetch = originalFetch;
  bot.pendingRecruitmentUploads.clear();

  console.log(`\n[recruitment-drive-upload-flow] ${passed} checks passed.`);
  // This test deliberately exercises the bot's "please retry" warnings, which
  // schedule a real 15-second setTimeout in onboarding.js to auto-delete
  // themselves — exit explicitly so the test runner doesn't idle waiting for
  // those timers instead of moving on to the next test file.
  process.exit(0);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
