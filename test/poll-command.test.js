// Regression coverage for the bot-based /poll command.
//
// Root cause of the original bug: Discord's native poll composer does not
// work in Announcement Channels (nor voice/stage/forum/media channels) — the
// Send Polls permission shows as allowed there but has no effect, so staff
// saw "everything green checked" yet no poll option. Fix: a bot-based /poll
// slash command that works in any channel type, restricted to staff-tier
// roles, with click-to-vote buttons and an in-memory vote tally.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// ---- Fake member (roles as an array, matching memberHasRole's fast path) ----
function makeMember(roleIds) {
  return { roles: [...roleIds] };
}

async function main() {
  // ---- parsePollOptions ----
  check("parses a simple comma-separated list", JSON.stringify(bot.parsePollOptions("Yes, No, Maybe")) === JSON.stringify(["Yes", "No", "Maybe"]));
  check("trims whitespace around each option", JSON.stringify(bot.parsePollOptions("  Alpha ,  Beta  ")) === JSON.stringify(["Alpha", "Beta"]));
  check("drops empty entries", JSON.stringify(bot.parsePollOptions("A,, B, ,C")) === JSON.stringify(["A", "B", "C"]));
  check("returns [] for empty input", bot.parsePollOptions("").length === 0);
  check("returns [] for null input", bot.parsePollOptions(null).length === 0);
  check("caps the option count at 10", bot.parsePollOptions(Array.from({ length: 15 }, (_, i) => "o" + i).join(",")).length === 10);

  // ---- parsePollDuration ----
  check("parses minutes", bot.parsePollDuration("30m") === 30 * 60 * 1000);
  check("parses hours", bot.parsePollDuration("12h") === 12 * 60 * 60 * 1000);
  check("parses days", bot.parsePollDuration("7d") === 7 * 24 * 60 * 60 * 1000);
  check("defaults to 24h when omitted", bot.parsePollDuration("") === 24 * 60 * 60 * 1000);
  check("defaults to 24h when null", bot.parsePollDuration(null) === 24 * 60 * 60 * 1000);
  check("rejects an unknown unit", bot.parsePollDuration("5w") === null);
  check("rejects zero", bot.parsePollDuration("0h") === null);
  check("rejects non-numeric input", bot.parsePollDuration("soon") === null);

  // ---- canCreatePoll (staff-tier gate) ----
  check("Owner can create polls", bot.canCreatePoll(makeMember([bot.OWNER_ROLE_ID])) === true);
  check("Staff can create polls", bot.canCreatePoll(makeMember([bot.STAFF_ROLE_ID])) === true);
  check("Jr Staff can create polls", bot.canCreatePoll(makeMember([bot.JR_STAFF_ROLE_ID])) === true);
  check("Leader can create polls", bot.canCreatePoll(makeMember([bot.LEADER_ROLE_ID])) === true);
  check("plain Clan Member cannot create polls", bot.canCreatePoll(makeMember([bot.CLAN_MEMBER_ROLE_ID])) === false);
  check("a member with no roles cannot create polls", bot.canCreatePoll(makeMember([])) === false);
  check("null member cannot create polls", bot.canCreatePoll(null) === false);

  // ---- pollTotalVotes ----
  {
    const poll = { options: [{ voters: new Set(["a", "b"]) }, { voters: new Set(["c"]) }, { voters: new Set() }] };
    check("sums voters across all options", bot.pollTotalVotes(poll) === 3);
  }

  // ---- buildPollEmbed ----
  {
    const poll = {
      question: "Best boss?",
      options: [
        { label: "Zulrah", voters: new Set(["u1", "u2"]) },
        { label: "Vorkath", voters: new Set(["u3"]) },
      ],
      closed: false,
      endsAt: null,
    };
    const embed = bot.buildPollEmbed(poll);
    const json = embed.toJSON();
    check("embed title contains the question", json.title.includes("Best boss?"));
    check("embed lists each option with its count", json.description.includes("Zulrah") && json.description.includes("2 votes"));
    check("embed shows percentages", json.description.includes("67%") && json.description.includes("33%"));
    check("open poll footer mentions voting", json.footer.text.includes("Click an option to vote"));
  }

  // ---- buildPollComponents ----
  {
    const poll = {
      question: "Q?",
      options: [{ label: "A", voters: new Set() }, { label: "B", voters: new Set() }],
      closed: false,
    };
    const rows = bot.buildPollComponents(poll, "msg123");
    const buttons = rows.flatMap((r) => r.toJSON().components);
    check("one vote button per option", buttons.filter((b) => b.custom_id.startsWith("poll_vote")).length === 2);
    check("vote buttons carry the message id and option index", buttons.some((b) => b.custom_id === "poll_vote:msg123:0") && buttons.some((b) => b.custom_id === "poll_vote:msg123:1"));
    check("a Close Poll button is present while open", buttons.some((b) => b.custom_id === "poll_close:msg123"));
    check("vote buttons are enabled while open", buttons.filter((b) => b.custom_id.startsWith("poll_vote")).every((b) => !b.disabled));
  }
  {
    const poll = { question: "Q?", options: [{ label: "A", voters: new Set() }], closed: true };
    const rows = bot.buildPollComponents(poll, "msg123");
    const buttons = rows.flatMap((r) => r.toJSON().components);
    check("vote buttons are disabled once closed", buttons.filter((b) => b.custom_id.startsWith("poll_vote")).every((b) => b.disabled === true));
    check("no Close Poll button once closed", !buttons.some((b) => b.custom_id.startsWith("poll_close")));
  }

  // ---- onPollVote: toggle / move semantics ----
  {
    bot.activePolls.clear();
    const poll = {
      question: "Q?",
      options: [{ label: "A", voters: new Set() }, { label: "B", voters: new Set() }],
      authorId: "author",
      closed: false,
    };
    bot.activePolls.set("m1", poll);

    const mkInteraction = (userId) => ({
      user: { id: userId },
      update: async () => {},
      reply: async () => {},
    });

    await bot.onPollVote(mkInteraction("u1"), "m1", "0");
    check("first vote lands on the chosen option", poll.options[0].voters.has("u1") && poll.options[0].voters.size === 1);

    await bot.onPollVote(mkInteraction("u1"), "m1", "1");
    check("voting for another option moves the vote", !poll.options[0].voters.has("u1") && poll.options[1].voters.has("u1"));

    await bot.onPollVote(mkInteraction("u1"), "m1", "1");
    check("clicking the same option again removes the vote", poll.options[1].voters.size === 0);

    await bot.onPollVote(mkInteraction("u2"), "m1", "0");
    await bot.onPollVote(mkInteraction("u3"), "m1", "0");
    check("different users vote independently", poll.options[0].voters.size === 2);
  }

  // ---- onPollVote: closed / unknown poll ----
  {
    bot.activePolls.clear();
    const poll = { question: "Q?", options: [{ label: "A", voters: new Set() }], authorId: "a", closed: true };
    bot.activePolls.set("m2", poll);
    let replied = false;
    await bot.onPollVote({ user: { id: "u9" }, reply: async () => { replied = true; }, update: async () => {} }, "m2", "0");
    check("voting on a closed poll is rejected without changing tallies", replied === true && poll.options[0].voters.size === 0);

    let repliedUnknown = false;
    await bot.onPollVote({ user: { id: "u9" }, reply: async () => { repliedUnknown = true; }, update: async () => {} }, "nope", "0");
    check("voting on an unknown poll is rejected", repliedUnknown === true);
  }

  // ---- onPollClose: author / staff only ----
  {
    bot.activePolls.clear();
    const poll = { question: "Q?", options: [{ label: "A", voters: new Set() }], authorId: "author1", closed: false };
    bot.activePolls.set("m3", poll);
    let updated = false;
    await bot.onPollClose({ user: { id: "author1" }, member: makeMember([]), update: async () => { updated = true; }, reply: async () => {} }, "m3");
    check("the poll author can close it", updated === true && poll.closed === true);
  }
  {
    bot.activePolls.clear();
    const poll = { question: "Q?", options: [{ label: "A", voters: new Set() }], authorId: "author1", closed: false };
    bot.activePolls.set("m4", poll);
    let replied = false;
    await bot.onPollClose({ user: { id: "random" }, member: makeMember([bot.CLAN_MEMBER_ROLE_ID]), update: async () => {}, reply: async () => { replied = true; } }, "m4");
    check("a random member cannot close someone else's poll", replied === true && poll.closed === false);
  }

  console.log(`\n[poll-command] ${passed} checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
