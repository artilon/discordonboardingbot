// Regression coverage for: the "Change Tracked Account" button on the Honour
// Marks role claim panel. A member who switched to a brand-new in-game
// account uses it to move their HM + rank tracking to the new account name;
// their old account is saved as a backup (hm_members.previous_rsn).
const assert = require("assert");
const path = require("path");

const panels = require(path.join(__dirname, "..", "src", "panels.js"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

function main() {
  const [payload] = panels.renderClaimPanel({});
  const buttons = payload.components.flatMap((r) => r.toJSON().components);
  const ids = buttons.map((b) => b.custom_id);

  check("panel still has Claim Role", ids.includes("hm_claim_role"));
  check("panel still has Drop Role", ids.includes("hm_drop_role"));
  check("panel still has Register RuneScape Name", ids.includes("hm_register_open"));
  check("panel has the new Change Tracked Account button", ids.includes("hm_change_account"));
  check(
    "Change Tracked Account button is labelled clearly",
    buttons.some((b) => b.custom_id === "hm_change_account" && b.label === "Change Tracked Account")
  );
  check(
    "panel description explains the account change + backup",
    /Change Tracked Account/.test(payload.embed.toJSON().description) && /backup/i.test(payload.embed.toJSON().description)
  );

  console.log(`\n[change-tracked-account] ${passed} checks passed.`);
}

main();
