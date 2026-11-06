// Regression coverage for: "new members can see the whole server before
// setting up their nickname" / "I want to list channels and roles and have
// the bot automatically set up privileges."
//
// These tests exercise the pure decision logic (which roles should see what,
// and the two "is this member mid-verification" checks) without touching the
// real Discord API — the live permission-overwrite calls themselves need a
// real guild and aren't practical to unit test here, but every decision that
// drives them is covered.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// ---- Fake GuildMember helper (same roles.cache.has(...) shape the bot reads) ----
function fakeMember(roleIds) {
  const set = new Set(roleIds);
  return { roles: { cache: { has: (id) => set.has(id) } } };
}

// ---- SERVER_PRIVACY_CATEGORIES shape sanity ----
const categories = bot.SERVER_PRIVACY_CATEGORIES;
check("Welcome category is registered", !!categories[bot.WELCOME_CATEGORY_ID]);
check("Clan Chat (OSRS voice) category is registered", !!categories["1545654996928823377"]);
check("Staff Area category is registered", !!categories[bot.STAFF_AREA_CATEGORY_ID]);
check("Social Hub category is registered", !!categories[bot.SOCIAL_HUB_CATEGORY_ID]);
check("Server Logs category is registered", !!categories[bot.SERVER_LOGS_CATEGORY_ID]);
check(
  "Honour Marks category is intentionally NOT managed here (owned by the Honour Marks bot's own /setup)",
  !categories["1565371879320064124"]
);

for (const [id, rule] of Object.entries(categories)) {
  check(`${rule.label} (${id}) has a default rule with a valid everyone mode`, [bot.EVERYONE_OPEN, bot.EVERYONE_DENY].includes(rule.default.everyone));
  check(`${rule.label} (${id}) has a channels override map`, typeof rule.channels === "object");
}

// ---- Welcome category: open by default, onboarding channel is the one exception ----
const welcome = categories[bot.WELCOME_CATEGORY_ID];
check("Welcome is open to everyone by default (rules/contact-staff channels)", welcome.default.everyone === bot.EVERYONE_OPEN);
const onboardingRule = welcome.channels["1546401367004811314"];
check("The onboarding (nickname-setup) channel is the one exception inside Welcome", !!onboardingRule);
check("...and it's locked to Clan Member only, not open to everyone", onboardingRule.everyone === bot.EVERYONE_DENY && onboardingRule.allowRoleIds.includes("1546403975656505354"));
check("...and Clan Friend is NOT in that allow list", !onboardingRule.allowRoleIds.includes(bot.CLAN_FRIEND_ROLE_ID));

// ---- Clan Chat: Clan Member and above, gated by the dynamic unverified check ----
const clanChat = categories["1545654996928823377"];
check("Clan Chat denies @everyone by default", clanChat.default.everyone === bot.EVERYONE_DENY);
check("Clan Chat is marked for the dynamic unverified gate", clanChat.default.dynamicUnverifiedGate === true);
check("Clan Friend is NOT in Clan Chat's allow list", !clanChat.default.allowRoleIds.includes(bot.CLAN_FRIEND_ROLE_ID));
check("Clan Member IS in Clan Chat's allow list", clanChat.default.allowRoleIds.includes("1546403975656505354"));

// ---- Staff Area: tiered exceptions ----
const staffArea = categories[bot.STAFF_AREA_CATEGORY_ID];
const orientationRule = staffArea.channels["1559995329825472542"];
check("Orientation channel is marked for the dynamic orientation gate", orientationRule.dynamicOrientationGate === true);
check("Orientation channel's static allow list includes Owner + Co-Owner for oversight", orientationRule.allowRoleIds.includes("1546401420453085204") && orientationRule.allowRoleIds.includes("1559998510110347274"));

const leaderRule = staffArea.channels[bot.LEADER_CHANNEL_ID];
check("#leader requires Verified Leader (not just the base Leader role)", leaderRule.allowRoleIds.includes("1559994620442710097") && !leaderRule.allowRoleIds.includes("1546401937883402293"));

const ownerChatRule = staffArea.channels[bot.OWNER_CHAT_CHANNEL_ID];
check("#owner-chat is Co-Owner/Owner only", ownerChatRule.allowRoleIds.length === 2 && ownerChatRule.allowRoleIds.includes("1559998510110347274") && ownerChatRule.allowRoleIds.includes("1546401420453085204"));

// ---- Server Logs: locked to a specific Discord account, not a role ----
const serverLogs = categories[bot.SERVER_LOGS_CATEGORY_ID];
check("Server Logs has no role in its allow list", serverLogs.default.allowRoleIds.length === 0);
check("Server Logs is locked to the specific configured Discord user id", serverLogs.default.allowUserIds.includes(bot.SERVER_LOGS_OWNER_USER_ID));
check("...and that id is the one the owner provided", bot.SERVER_LOGS_OWNER_USER_ID === "351190870416031744");

// ---- buildStaticOverwriteRows() ----
const fakeGuild = {
  roles: { everyone: { id: "everyone-id" } },
  members: { me: { id: "bot-id" } },
};
const openRows = bot.buildStaticOverwriteRows(fakeGuild, { everyone: bot.EVERYONE_OPEN, allowRoleIds: [] });
check("An 'open' rule allows @everyone to view", openRows.some((r) => r.id === "everyone-id" && r.allow?.length));
const denyRows = bot.buildStaticOverwriteRows(fakeGuild, { everyone: bot.EVERYONE_DENY, allowRoleIds: ["role-a", "role-b"] });
check("A 'deny' rule denies @everyone", denyRows.some((r) => r.id === "everyone-id" && r.deny?.length));
check("...and explicitly allows every listed role", denyRows.some((r) => r.id === "role-a" && r.allow?.length) && denyRows.some((r) => r.id === "role-b" && r.allow?.length));
check("The bot itself always keeps access", denyRows.some((r) => r.id === "bot-id" && r.allow?.length));
const userRows = bot.buildStaticOverwriteRows(fakeGuild, { everyone: bot.EVERYONE_DENY, allowRoleIds: [], allowUserIds: ["some-user-id"] });
check("allowUserIds produces a member-type allow row", userRows.some((r) => r.id === "some-user-id" && r.allow?.length));

// ---- isPendingNicknameVerification() — the Clan Chat gate ----
check(
  "a brand new join with no roles yet is not 'pending' (nothing to hide beyond the static deny)",
  bot.isPendingNicknameVerification(fakeMember([])) === false
);
check(
  "Clan Member + Unverified together (just picked Clan Member, hasn't set nickname) => pending, Clan Chat stays locked",
  bot.isPendingNicknameVerification(fakeMember(["1546403975656505354", "1547278787815804928"])) === true
);
check(
  "Clan Member WITHOUT Unverified (nickname already set) => not pending, Clan Chat unlocks",
  bot.isPendingNicknameVerification(fakeMember(["1546403975656505354"])) === false
);
check(
  "Clan Friend + Unverified (never gets the nickname gate at all) => not pending",
  bot.isPendingNicknameVerification(fakeMember(["1559320122223493151", "1547278787815804928"])) === false
);

// ---- isPendingOrientation() — the Staff/Leader orientation channel gate ----
check("no roles at all => not pending orientation", bot.isPendingOrientation(fakeMember([])) === false);
check(
  "base Leader role without Verified Leader => pending, sees the orientation channel",
  bot.isPendingOrientation(fakeMember(["1546401937883402293"])) === true
);
check(
  "Leader + Verified Leader (already accepted) => not pending, orientation channel hides again",
  bot.isPendingOrientation(fakeMember(["1546401937883402293", "1559994620442710097"])) === false
);
check(
  "base Staff role without Verified Staff => pending",
  bot.isPendingOrientation(fakeMember(["1546402959049359360"])) === true
);
check(
  "base Jr. Staff role without Verified Staff => pending (same verified role covers both)",
  bot.isPendingOrientation(fakeMember(["1546403383752134656"])) === true
);
check(
  "Staff + Verified Staff => not pending",
  bot.isPendingOrientation(fakeMember(["1546402959049359360", "1559997317325656094"])) === false
);

// ---- isServerPrivacySyncDue() heartbeat gating (same shape as isRankSyncDue) ----
const TEN_MIN = 10 * 60 * 1000;
const THIRTY_ONE_MIN = 31 * 60 * 1000;
check("never synced before => due immediately", bot.isServerPrivacySyncDue(Date.now(), 0, false) === true);
check("a sync is currently in flight => not due", bot.isServerPrivacySyncDue(Date.now(), 0, true) === false);
const now = Date.now();
check("synced 10 minutes ago (< 30 min interval) => not due yet", bot.isServerPrivacySyncDue(now, now - TEN_MIN, false) === false);
check("synced 31 minutes ago (> 30 min interval) => due again", bot.isServerPrivacySyncDue(now, now - THIRTY_ONE_MIN, false) === true);

console.log(`[server-privacy.test.js] ${passed} checks passed.`);
