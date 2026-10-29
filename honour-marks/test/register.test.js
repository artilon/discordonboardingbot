"use strict";
/**
 * Guards the duplicate-slash-command fix.
 *
 * Symptom this prevents: `/setup` showing four subcommands, each listed twice.
 * Cause: the bot had registered commands globally once and to a guild once.
 * Discord replaces a scope's list wholesale but never touches the other scope,
 * and the client merges subcommand lists across same-named commands instead of
 * shadowing. Writing the wanted scope alone is therefore not enough — the other
 * scope has to be emptied.
 *
 * Run: node test/register.test.js
 */
const assert = require("assert");
const { syncCommands } = require("../src/register");

let passed = 0;
function check(name, fn) { return Promise.resolve(fn()).then(() => { passed += 1; console.log(`  \u2713 ${name}`); }); }

const COMMANDS = [{ name: "setup" }, { name: "register" }, { name: "hm" }];

/** Records every call, in order, and can be told to fail on a route. */
function fakeRest({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async put(route, { body }) {
      calls.push({ route, body });
      if (failOn && route.includes(failOn)) throw new Error("Missing Access");
    },
  };
}

const routes = {
  global: () => "/applications/A/commands",
  guild: (guildId) => `/applications/A/guilds/${guildId}/commands`,
};

function baseArgs(rest, extra = {}) {
  const logs = [];
  const warns = [];
  return {
    logs,
    warns,
    args: {
      rest,
      routes,
      clientId: "A",
      commands: COMMANDS,
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
      ...extra,
    },
  };
}

(async () => {
  console.log("registration scope sync");

  await check("dev guild: registers to the guild first, with the full payload", async () => {
    const rest = fakeRest();
    const { args } = baseArgs(rest, { devGuildId: "G1", guildIds: ["G1", "G2"] });
    await syncCommands(args);
    assert.strictEqual(rest.calls[0].route, "/applications/A/guilds/G1/commands");
    assert.deepStrictEqual(rest.calls[0].body, COMMANDS);
  });

  await check("dev guild: global copy is emptied so subcommands stop doubling", async () => {
    const rest = fakeRest();
    const { args } = baseArgs(rest, { devGuildId: "G1", guildIds: ["G1"] });
    await syncCommands(args);
    const globalCall = rest.calls.find((c) => c.route === "/applications/A/commands");
    assert.ok(globalCall, "expected a global write to clear duplicates");
    assert.deepStrictEqual(globalCall.body, []);
  });

  await check("dev guild: the dev guild's own registration is not wiped", async () => {
    const rest = fakeRest();
    const { args } = baseArgs(rest, { devGuildId: "G1", guildIds: ["G1", "G2"] });
    await syncCommands(args);
    const guildWrites = rest.calls.filter((c) => c.route.startsWith("/applications/A/guilds/"));
    assert.deepStrictEqual(guildWrites.map((c) => c.route), ["/applications/A/guilds/G1/commands"]);
    assert.deepStrictEqual(guildWrites[0].body, COMMANDS);
  });

  await check("dev guild: registration is written before anything is cleared", async () => {
    const rest = fakeRest();
    const { args } = baseArgs(rest, { devGuildId: "G1" });
    await syncCommands(args);
    assert.deepStrictEqual(
      rest.calls.map((c) => c.route),
      ["/applications/A/guilds/G1/commands", "/applications/A/commands"]
    );
  });

  await check("global: registers globally then empties every guild copy", async () => {
    const rest = fakeRest();
    const { args } = baseArgs(rest, { guildIds: ["G1", "G2"] });
    const result = await syncCommands(args);
    assert.deepStrictEqual(result.cleared, ["G1", "G2"]);
    assert.strictEqual(rest.calls[0].route, "/applications/A/commands");
    assert.deepStrictEqual(rest.calls[0].body, COMMANDS);
    assert.deepStrictEqual(
      rest.calls.slice(1).map((c) => c.route),
      ["/applications/A/guilds/G1/commands", "/applications/A/guilds/G2/commands"]
    );
    assert.ok(rest.calls.slice(1).every((c) => c.body.length === 0));
  });

  await check("global: a guild id repeated or blank is only cleared once", async () => {
    const rest = fakeRest();
    const { args } = baseArgs(rest, { guildIds: ["G1", "G1", "", null, "G2"] });
    await syncCommands(args);
    assert.deepStrictEqual(
      rest.calls.map((c) => c.route),
      ["/applications/A/commands", "/applications/A/guilds/G1/commands", "/applications/A/guilds/G2/commands"]
    );
  });

  await check("global: with no guilds, only one request is made", async () => {
    const rest = fakeRest();
    const { args } = baseArgs(rest, { guildIds: [] });
    await syncCommands(args);
    assert.strictEqual(rest.calls.length, 1);
  });

  await check("a failed registration throws and clears nothing", async () => {
    const rest = fakeRest({ failOn: "/guilds/G1/" });
    const { args } = baseArgs(rest, { devGuildId: "G1" });
    await assert.rejects(() => syncCommands(args), /Missing Access/);
    assert.strictEqual(rest.calls.length, 1, "must not empty the global scope after a failed register");
    assert.deepStrictEqual(rest.calls[0].body, COMMANDS);
  });

  await check("a failed cleanup is logged but does not break boot", async () => {
    const rest = fakeRest({ failOn: "/applications/A/commands" });
    const { args, warns } = baseArgs(rest, { devGuildId: "G1" });
    const result = await syncCommands(args);
    assert.deepStrictEqual(result.cleared, []);
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /Could not clear global commands: Missing Access/);
  });

  await check("a missing client id fails before any request", async () => {
    const rest = fakeRest();
    await assert.rejects(
      () => syncCommands({ rest, routes, clientId: null, commands: COMMANDS }),
      /clientId is required/
    );
    assert.strictEqual(rest.calls.length, 0);
  });

  await check("the exact payload registered is the shared command definition", async () => {
    const rest = fakeRest();
    const { args } = baseArgs(rest, { devGuildId: "G1" });
    await syncCommands(args);
    assert.strictEqual(rest.calls[0].body, COMMANDS, "must not clone or mutate the payload");
  });

  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(`\n\u2717 FAILED: ${e.message}`);
  process.exit(1);
});
