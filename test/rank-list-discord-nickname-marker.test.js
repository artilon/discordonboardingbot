// Regression coverage for: "for the list of members we have, can you add
// something like an asterisk or something next to clan member names that do
// not have a matching server nickname in the discord? that way we can tell
// by looking at the list who is a discord member and who is not?"
//
// buildRankListPayload() is a pure function (no network/DB calls), so this
// test calls it directly with a hand-built `discordNicknames` Set — exactly
// what ensureRankListMessage() computes at runtime via getDiscordDisplayNameSet()
// — and inspects the rendered embed description text.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

function findMemberListEmbed(payload) {
  // embeds[0] is always the Growth Chart; the member list starts at embeds[1].
  return payload.embeds.slice(1).map((e) => e.data.description).join("\n\n");
}

const members = [
  { rsn: "HasDiscord", active: true, xp: 500000, confirmed_rank: "Bronze", joined_date: "2024-01-01" },
  { rsn: "NoDiscord", active: true, xp: 400000, confirmed_rank: "Bronze", joined_date: "2024-01-01" },
  { rsn: "CaseInsensitive", active: true, xp: 300000, confirmed_rank: "Bronze", joined_date: "2024-01-01" },
];

// --- 1. With live Discord data: matched members get no marker, unmatched do ---
const discordNicknames = new Set(["hasdiscord", "casesensitive placeholder", "caseinsensitive"]);
const payloadWithData = bot.buildRankListPayload(members, new Date("2024-06-01"), { discordNicknames });
const textWithData = findMemberListEmbed(payloadWithData);

check(
  "a member with a matching Discord nickname shows no asterisk",
  textWithData.includes("**1. HasDiscord**") && !textWithData.includes("HasDiscord\\*")
);
check(
  "a member with NO matching Discord nickname gets a trailing escaped asterisk",
  textWithData.includes("NoDiscord\\*")
);
check(
  "nickname matching is case-insensitive",
  textWithData.includes("**3. CaseInsensitive**") && !textWithData.includes("CaseInsensitive\\*")
);
check(
  "the embed explains what the asterisk means when Discord data is available",
  textWithData.includes("no matching Discord server member found")
);

// --- 2. Without Discord data (discordNicknames omitted / null): nobody is marked ---
const payloadNoData = bot.buildRankListPayload(members, new Date("2024-06-01"), {});
const textNoData = findMemberListEmbed(payloadNoData);

check(
  "when Discord data is unavailable, no member is marked with an asterisk",
  !textNoData.includes("\\*")
);
check(
  "when Discord data is unavailable, the legend line is omitted entirely",
  !textNoData.includes("no matching Discord server member found")
);

// --- 3. An explicitly empty Set (fetched successfully, but server is empty) marks everyone ---
const payloadEmptySet = bot.buildRankListPayload(members, new Date("2024-06-01"), { discordNicknames: new Set() });
const textEmptySet = findMemberListEmbed(payloadEmptySet);

check(
  "an empty-but-real Discord nickname Set marks every member (distinct from 'unknown')",
  textEmptySet.includes("HasDiscord\\*") && textEmptySet.includes("NoDiscord\\*") && textEmptySet.includes("CaseInsensitive\\*")
);

console.log(`\n[rank-list-discord-nickname-marker] ${passed} checks passed.`);
