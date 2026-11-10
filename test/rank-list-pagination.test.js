// Regression coverage for: "instead of having all members listed with
// multiple long posts, can we do a page system where you click arrows to
// load 20 members names at a time on each page?"
//
// buildRankListPayload() is a pure function (no network/DB calls) for the
// page-slicing/clamping/button-state behavior, so most of this is exercised
// directly. onRankListPageButton() (the actual button click handler) is
// covered separately with a lightweight fake interaction + fake Supabase.
const assert = require("assert");
const path = require("path");

const bot = require(path.join(__dirname, "..", "onboarding.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

// 45 members, 3 per "full" page-and-a-bit, with strictly descending XP so
// sort order (and therefore page membership) is deterministic.
function makeMembers(count) {
  const members = [];
  for (let i = 1; i <= count; i++) {
    members.push({
      rsn: `Member${String(i).padStart(2, "0")}`,
      active: true,
      xp: (count - i + 1) * 1000, // Member01 has the most XP, MemberNN the least
      confirmed_rank: "Bronze",
      joined_date: "2024-01-01",
    });
  }
  return members;
}

function memberListText(payload) {
  // embeds[0] = growth chart, embeds[1] = header/legend, embeds[2+] = the current page's member list
  return payload.embeds.slice(2).map((e) => e.data.description).join("\n\n");
}

function pageTitle(payload) {
  return payload.embeds[2].data.title;
}

function navButtons(payload) {
  const navRow = payload.components[1];
  return {
    prev: navRow.components[0].data,
    next: navRow.components[1].data,
  };
}

const members45 = makeMembers(45);

// ================= Page slicing & numbering =================

// Reset shared pagination state before each independent scenario below.
bot.config.rankListPage = 0;

const page1 = bot.buildRankListPayload(members45, new Date("2024-06-01"), { page: 0 });
const page1Text = memberListText(page1);
check("page 1 shows the first member", page1Text.includes("**1. Member01**"));
check("page 1 shows exactly 20 members (the 20th, not the 21st)", page1Text.includes("**20. Member20**") && !page1Text.includes("**21. Member21**"));
check("page 1's title reports page 1 of 3", pageTitle(page1) === "Member Standings — Page 1 of 3");
check("page 1's Prev button is disabled (nothing before the first page)", navButtons(page1).prev.disabled === true);
check("page 1's Next button is enabled (there's more to see)", navButtons(page1).next.disabled !== true);

const page2 = bot.buildRankListPayload(members45, new Date("2024-06-01"), { page: 1 });
const page2Text = memberListText(page2);
check("page 2 does NOT repeat page 1's members", !page2Text.includes("Member01") && !page2Text.includes("Member20"));
check("page 2 shows members 21-40", page2Text.includes("**21. Member21**") && page2Text.includes("**40. Member40**"));
check(
  "page 2 numbering continues the overall rank position, it doesn't restart at 1",
  !page2Text.includes("**1. Member21**")
);
check("page 2's title reports page 2 of 3", pageTitle(page2) === "Member Standings — Page 2 of 3");
check("page 2's Prev button is enabled", navButtons(page2).prev.disabled !== true);
check("page 2's Next button is enabled", navButtons(page2).next.disabled !== true);

const page3 = bot.buildRankListPayload(members45, new Date("2024-06-01"), { page: 2 });
const page3Text = memberListText(page3);
check("page 3 (the last, partial page) shows the remaining 5 members", page3Text.includes("**41. Member41**") && page3Text.includes("**45. Member45**"));
check("page 3's title reports page 3 of 3", pageTitle(page3) === "Member Standings — Page 3 of 3");
check("page 3's Next button is disabled (it's the last page)", navButtons(page3).next.disabled === true);
check("page 3's Prev button is enabled", navButtons(page3).prev.disabled !== true);

// ================= Clamping out-of-range page requests =================

const pageTooHigh = bot.buildRankListPayload(members45, new Date("2024-06-01"), { page: 999 });
check("a page number past the end clamps to the last real page", pageTitle(pageTooHigh) === "Member Standings — Page 3 of 3");

const pageNegative = bot.buildRankListPayload(members45, new Date("2024-06-01"), { page: -5 });
check("a negative page number clamps to page 1", pageTitle(pageNegative) === "Member Standings — Page 1 of 3");

// ================= Defaulting to config.rankListPage when no page option is given =================

bot.config.rankListPage = 1;
const defaultedToConfig = bot.buildRankListPayload(members45, new Date("2024-06-01"), {});
check("omitting `page` falls back to config.rankListPage", pageTitle(defaultedToConfig) === "Member Standings — Page 2 of 3");

// ================= Small rosters: no pagination noise =================

const smallRoster = makeMembers(5);
bot.config.rankListPage = 0;
const smallPayload = bot.buildRankListPayload(smallRoster, new Date("2024-06-01"), {});
check("a roster smaller than one page reports exactly 1 page", pageTitle(smallPayload) === "Member Standings — Page 1 of 1");
check("both nav buttons are disabled when there's only one page", navButtons(smallPayload).prev.disabled === true && navButtons(smallPayload).next.disabled === true);

// ================= The nav buttons are their own row, separate from the existing controls =================
check("there are exactly two action rows (existing controls + new page nav)", page1.components.length === 2);
check("the nav row has exactly the Prev/Next buttons", page1.components[1].components.length === 2);
check("the nav buttons use the dedicated page custom ids", navButtons(page1).prev.custom_id === bot.ID.RANK_LIST_PAGE_PREV && navButtons(page1).next.custom_id === bot.ID.RANK_LIST_PAGE_NEXT);

// ================= onRankListPageButton: the actual click handler =================

function makeFakeInteraction() {
  const edits = [];
  return {
    deferUpdate: async () => {},
    editReply: async (payload) => { edits.push(payload); },
    _edits: edits,
  };
}

function makeChain(result) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (resolve) => Promise.resolve(result()).then(resolve);
        return () => makeChain(result);
      },
    }
  );
}

(async () => {
  bot.config.supabase = {
    from(table) {
      if (table === "clan_members") return makeChain(() => ({ data: members45, error: null }));
      return makeChain(() => ({ data: [], error: null }));
    },
  };
  bot.client.guilds.cache.clear();

  bot.config.rankListPage = 0;
  const btnInteraction = makeFakeInteraction();
  await bot.onRankListPageButton(btnInteraction, 1); // click "Next 20 ▶"

  const clickedPayload = btnInteraction._edits[0];
  check("clicking Next advances the stored page", bot.config.rankListPage === 1);
  check("clicking Next edits the message to show page 2", pageTitle(clickedPayload) === "Member Standings — Page 2 of 3");

  const btnInteraction2 = makeFakeInteraction();
  await bot.onRankListPageButton(btnInteraction2, -1); // click "◀ Prev 20"
  check("clicking Prev goes back to page 1", bot.config.rankListPage === 0);

  // Clicking Prev again at the first page has nowhere to go — stays clamped at page 1.
  const btnInteraction3 = makeFakeInteraction();
  await bot.onRankListPageButton(btnInteraction3, -1);
  check("clicking Prev at the first page stays clamped at page 1", bot.config.rankListPage === 0);

  // ---- cleanup ----
  bot.config.rankListPage = 0;
  bot.config.supabase = null;

  console.log(`\n[rank-list-pagination] ${passed} checks passed.`);
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
