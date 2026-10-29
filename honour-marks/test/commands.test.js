"use strict";
/**
 * Validates the slash-command payload against Discord's rules BEFORE deploy.
 *
 * Why this exists: a single optional-before-required option made Discord reject
 * the entire registration payload with "Invalid Form Body". Every command
 * disappeared from the server while the bot still logged in and looked online,
 * so it presented as a permissions or invite problem rather than a data error.
 *
 * Run: node test/commands.test.js
 */
const assert = require("assert");
const { commands } = require("../src/commands");

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

const TYPE_SUBCOMMAND = 1;
const TYPE_SUBCOMMAND_GROUP = 2;

/** Discord's rule: within any one option list, required comes before optional. */
function assertRequiredFirst(options, path) {
  let firstOptional = null;
  for (const opt of options || []) {
    if (opt.required) {
      assert.strictEqual(
        firstOptional, null,
        `${path}: required option "${opt.name}" appears after optional option "${firstOptional}"`
      );
    } else if (firstOptional === null) {
      firstOptional = opt.name;
    }
    if (opt.options) assertRequiredFirst(opt.options, `${path} > ${opt.name}`);
  }
}

function validateCommand(cmd) {
  assert.ok(cmd.name, "a command has no name");
  assert.ok(cmd.description, `/${cmd.name} has no description`);
  assert.ok(cmd.description.length <= 100, `/${cmd.name} description exceeds 100 chars`);
  assert.ok(!/\s/.test(cmd.name), `/${cmd.name} contains whitespace`);
  assert.ok(cmd.name === cmd.name.toLowerCase(), `/${cmd.name} is not lowercase`);

  assertRequiredFirst(cmd.options, cmd.name);

  // Subcommands cannot be mixed with plain options in the same list.
  const kinds = new Set((cmd.options || []).map((o) => o.type));
  const hasSub = kinds.has(TYPE_SUBCOMMAND) || kinds.has(TYPE_SUBCOMMAND_GROUP);
  if (hasSub) {
    assert.ok(
      [...kinds].every((k) => k === TYPE_SUBCOMMAND || k === TYPE_SUBCOMMAND_GROUP),
      `/${cmd.name} mixes subcommands with plain options`
    );
  }

  for (const opt of cmd.options || []) {
    if (opt.type !== TYPE_SUBCOMMAND && opt.type !== TYPE_SUBCOMMAND_GROUP) {
      assert.ok(opt.description, `/${cmd.name} option "${opt.name}" has no description`);
      assert.ok(opt.description.length <= 100, `/${cmd.name} option "${opt.name}" description too long`);
    }
    if (opt.options) assertRequiredFirst(opt.options, `/${cmd.name} > ${opt.name}`);
  }
}

console.log("\n[command payload]");
console.log(`  ${commands.length} command(s): ${commands.map((c) => "/" + c.name).join(", ")}`);

check("payload is non-empty", () => {
  assert.ok(Array.isArray(commands) && commands.length >= 3);
});

check("every command is structurally valid", () => {
  for (const cmd of commands) validateCommand(cmd);
});

check("no optional option precedes a required one anywhere", () => {
  const walk = (opts, path) => {
    for (const o of opts || []) {
      walk(o.options, `${path} > ${o.name}`);
    }
    const flags = (opts || []).map((o) => !!o.required);
    const lastReq = flags.lastIndexOf(true);
    const firstOpt = flags.indexOf(false);
    if (lastReq !== -1 && firstOpt !== -1) {
      assert.ok(lastReq < firstOpt, `${path}: ${JSON.stringify((opts || []).map((o) => [o.name, !!o.required]))}`);
    }
  };
  for (const cmd of commands) walk(cmd.options, cmd.name);
});

check("/setup manual puts required options first", () => {
  const setup = commands.find((c) => c.name === "setup");
  assert.ok(setup, "/setup missing");
  const manual = setup.options.find((o) => o.name === "manual");
  assert.ok(manual, "/setup manual missing");
  const names = manual.options.map((o) => [o.name, !!o.required]);
  console.log("    /setup manual:", JSON.stringify(names));
  const firstOptional = names.findIndex(([, req]) => !req);
  const lastRequired = names.map(([, req]) => req).lastIndexOf(true);
  assert.ok(firstOptional === -1 || lastRequired < firstOptional, "required after optional");
});

check("all expected commands present", () => {
  const names = commands.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ["hm", "register", "setup"]);
});

check("each command has at least one option or subcommand", () => {
  for (const cmd of commands) {
    assert.ok(Array.isArray(cmd.options) && cmd.options.length > 0, `/${cmd.name} has no options`);
  }
});

console.log(`\n${passed} checks passed.\n`);
