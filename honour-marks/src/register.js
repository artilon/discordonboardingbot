"use strict";
/**
 * Slash-command registration — and, just as importantly, de-registration.
 *
 * Discord stores commands per scope. `PUT /applications/{id}/commands` and
 * `PUT /applications/{id}/commands/guilds/{guild}/commands` both REPLACE that
 * scope's whole list, but neither touches the other scope. So a bot that has
 * ever registered globally AND to a guild keeps both copies forever, and the
 * client's command picker merges the subcommand lists of same-named commands
 * rather than letting the guild copy shadow the global one. The visible symptom
 * is every subcommand listed twice:
 *
 *   /setup auto, /setup auto, /setup manual, /setup manual, ...
 *
 * The fix is to always write the scope we want and empty the scope we don't.
 *
 * Ordering matters: the wanted scope is written FIRST, and only after it
 * succeeds does anything get cleared. A failed registration therefore never
 * leaves the guild with zero commands — the worst case is the duplicates you
 * already had.
 *
 * `rest` and `routes` are injected rather than imported so the logic is
 * testable without booting a client (see test/register.test.js).
 */

/**
 * @param {object}   opts
 * @param {object}   opts.rest      REST client exposing put(route, { body }).
 * @param {object}   opts.routes    { global(): route, guild(guildId): route }.
 * @param {string}   opts.clientId  Application ID.
 * @param {object[]} opts.commands  Serialised command payload.
 * @param {?string}  opts.devGuildId  Guild to register to for instant visibility.
 * @param {string[]} opts.guildIds  Guilds the bot is in (cleared when global).
 * @param {function} [opts.log]     Info logger.
 * @param {function} [opts.warn]    Warning logger.
 * @returns {Promise<{scope: string, registered: string[], cleared: string[]}>}
 */
async function syncCommands({
  rest,
  routes,
  clientId,
  commands,
  devGuildId = null,
  guildIds = [],
  log = () => {},
  warn = () => {},
}) {
  if (!clientId) throw new Error("clientId is required to register commands");

  const cleared = [];

  /** Emptying a scope is best-effort: failing to tidy must not break boot. */
  const clear = async (route, label, scopeKey) => {
    try {
      await rest.put(route, { body: [] });
      cleared.push(scopeKey);
      if (label) log(`Cleared stale ${label}.`);
    } catch (e) {
      warn(`Could not clear ${label || scopeKey}: ${e.message}`);
    }
  };

  if (devGuildId) {
    // Register to the one guild for instant availability...
    await rest.put(routes.guild(devGuildId), { body: commands });
    log(`Commands registered to guild ${devGuildId}.`);

    // ...then drop the global copy that would otherwise double every subcommand.
    await clear(routes.global(), "global commands", "global");
    return { scope: "guild", registered: [devGuildId], cleared };
  }

  await rest.put(routes.global(), { body: commands });
  log("Commands registered globally (can take up to an hour to appear).");

  // ...then drop guild copies from every server the bot is in.
  const unique = [...new Set(guildIds.filter(Boolean))];
  for (const guildId of unique) {
    await clear(routes.guild(guildId), `guild commands in ${guildId}`, guildId);
  }

  return { scope: "global", registered: [], cleared };
}

/**
 * The scope-cleanup operations are cheap but not free; Discord allows 200
 * command writes per guild per day. One write per boot is far under that, but
 * a crash loop would multiply it, so the boot path calls this once.
 */
module.exports = { syncCommands };
