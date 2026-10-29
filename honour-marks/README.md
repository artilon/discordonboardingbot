# Odinheim — Honour Marks

Discord bot for the Honour Marks quest and shop system. Runs alongside Heimdall
(`../onboarding.js`) and shares one Supabase project with it.

```
Heimdall owns the rank ladder.  This bot owns Honour Marks.
They meet at exactly one table: pending_rank_xp.
```

## Why the split

Heimdall recomputes `tenure_xp` from each member's join date on every sync and
writes `xp = tenure_xp + bonus_xp`. Anything written straight into
`clan_members.xp` from here would be erased within 30 minutes. So Rank XP
leaves this bot only as inserts into `pending_rank_xp`, and Heimdall credits it
to `bonus_xp` on its next pass.

Consequence worth knowing: **the two XP streams never read each other.**
Tenure awards use the tenure multiplier; quest XP is flat. Rank is decided by
the total, so quests can earn you a rank — they just can't accelerate your
tenure income.

## Setup

**1. Database.** Paste `schema.sql` into the Supabase project Heimdall already
uses → SQL Editor → Run. It's idempotent.

**2. Environment.** Copy `.env.example` to `.env` and fill in the Discord token,
client ID, and Supabase URL/key.

**3. Run.**

```bash
cd honour-marks
npm install
npm start
```

**4. `/setup` in Discord.**

- `/setup auto` — creates a `Honour Marks` category with seven channels —
  `#hm-role`, `#hm-guide`, `#hm-quests`, `#hm-shop`, `#hm-database`,
  `#hm-staff`, `#hm-log` — posts every panel (the guide, quest board and shop
  each get their own channel and their own panel now; the guide's
  **📖 How This Works** explainer is also one click away via a button on the
  quest board), seeds the XP rules. Needs **Manage Channels**.
- `/setup manual` — binds to channels you already have. Uses native channel and
  role pickers, so there are no IDs to paste. `quests`, `database` and `shop`
  are required; `claim`, `guide`, `staff` and `log` are optional.
- `/setup repair` — re-verifies channels and reposts any missing panel.
- `/setup status` — shows what's bound.

`/setup repair` reconciles the *existing* binding (fixes permissions, reposts a
panel if its message got deleted) without touching channels. `/setup auto` and
`/setup manual`, on the other hand, **rebind** — they point the bot at whatever
channels you gave them this time and start managing those, but they never
delete anything. Re-running `/setup auto` to pick up new channels (for example,
after upgrading from an older version with fewer channels) always **creates a
brand new category** rather than adding the missing channels to the old one —
delete the old `Honour Marks` category by hand afterward. Nothing in Supabase
is touched either way, so no HM balances, Rank XP, or quest history is ever at
risk from re-running setup.

**5. Members.** `/register rsn:YourName` — verified against the OSRS hiscores
before it's accepted, so nobody ends up with a dead registration.

## Railway

Same repo, second service, separate Root Directory. Step by step:

1. **New service from the same repo.** Railway project → **+ New** →
   **GitHub Repo** → pick `discordonboardingbot`. It will try to build the repo
   root as Heimdall, which is wrong — fix it in step 2.
2. **Set the root directory.** Service → **Settings** → **Source** →
   **Root Directory** = `honour-marks`. Confirm the build now uses
   `honour-marks/package.json`.
3. **Rename it** to `Odinheim Honour Marks` (Settings → General) so the usage
   breakdown is readable.
4. **Add variables.** Service → **Variables** → **Raw Editor**, paste:

   ```
   HM_BOT_TOKEN=...
   HM_CLIENT_ID=...
   SUPABASE_URL=...
   SUPABASE_KEY=...
   ```

   Use the **same** `SUPABASE_URL`/`SUPABASE_KEY` as Heimdall — the two bots
   must share one project or quest XP never reaches the rank ladder.
5. **Deploy.** Start command is `npm start` from `honour-marks/`.
6. **Invite the bot** with the `bot` and `applications.commands` scopes plus
   Manage Channels, Manage Roles, Send Messages, Embed Links, Read Message
   History and Manage Messages.
7. **`/setup auto`** in Discord, then `/register` as each member.

Free plan allows **3 services per project**, so both bots fit without a second
Railway account. Watch the usage graph for the first day or two — the $1 monthly
credit is thin if both services sit at their 0.5 GB cap.

### If `/setup` doesn't appear

Global commands can take up to an hour to propagate. To skip the wait, add:

```
HM_DEV_GUILD_ID=<your server id>
```

and redeploy. The log then reads `Commands registered to guild <id>.` and the
commands are available immediately, in that server only. Leave the variable set
if you like — registration is idempotent.

### If every subcommand appears twice

`/setup auto, /setup auto, /setup manual, /setup manual, …` means two scopes hold
a copy of the same command name: one global, one guild. Discord replaces a
scope's list wholesale but never clears the *other* scope, and the client merges
subcommand lists across same-named commands instead of letting the guild copy
shadow the global one.

`src/register.js` handles this on every boot: it writes the scope you asked for,
and only after that succeeds, empties the other one. So the duplicates clear
themselves on the first restart after this code is deployed. No manual cleanup.

Order is deliberate — registering first means a failed registration never leaves
the server with zero commands.

## Channels and permissions

Seven channels inside an `Honour Marks` category — the guide, quest board and
shop each live in their own channel now, instead of all three being crammed
into one. The category denies `@everyone`, and each child re-allows only what
it needs — because **category overwrites cascade to every child**, so allowing
a role on the category would expose `#hm-log` too.

| Channel | Who can see it | Who can post |
|---|---|---|
| `#hm-role` | Clan Member + Honour Marks | bot only |
| `#hm-guide` | Honour Marks | bot only |
| `#hm-quests` | Honour Marks | bot only |
| `#hm-shop` | Honour Marks | bot only |
| `#hm-database` | Honour Marks | bot only |
| `#hm-staff` | Staff role | bot only |
| `#hm-log` | **the setup runner only** | bot only |

On every member-facing channel, `@everyone`, Clan Member and Honour Marks are
denied `SendMessages`, `SendMessagesInThreads`, `CreatePublicThreads`,
`CreatePrivateThreads`, `AddReactions` and `CreatePoll`. The channels are pure
read-only displays; all interaction happens through buttons and menus.

`#hm-log` defaults to whoever ran `/setup`, and can be pinned with
`HM_LOG_USER_ID`. Staff are explicitly denied it rather than left to inherit.

> **Administrator bypasses channel overwrites.** Discord does not let a channel
> deny anything to an admin — that's platform behaviour, not a setting. If you
> want the read-only channels airtight for admins too, remove Administrator from
> those roles and grant specific permissions instead.

## Claim / Drop Role

`#hm-role` holds one embed with two buttons:

| Button | Effect |
|---|---|
| 🎖️ **Claim Role** | Adds the Honour Marks role, unlocking the guide, quest board, shop and database |
| ✅ **Drop Role** | Removes it. Progress, HM and history are all kept |

Two buttons rather than one toggle because the message is shared by the whole
server, so its components can't differ per viewer. Both actions are named in the
embed body as well, so nobody has to guess.

Assigning the role needs **Manage Roles**, and the bot's role must sit **above**
the Honour Marks role in the hierarchy. `/setup` checks both and tells you if
either is wrong instead of failing silently on first click.

## How the embed limit is handled

A Discord embed description caps at 4,096 characters, so a member database will
outgrow one message. Every panel here is a pure function of the database that
returns an **array of pages**, and `hm_panels` records which message is which
page. A refresh then:

| Situation | Action |
|---|---|
| Page exists, message exists | Edit in place |
| Page exists, message deleted by a moderator | Repost at the same index |
| New page needed | Post it |
| Page no longer needed | Delete it and clear the ledger row |

Growth is automatic, shrinkage cleans up after itself, and a manual delete
self-heals on the next refresh instead of leaving an orphaned "Part 3/4".

## Layout

```
honour-marks/
├── index.js           client, commands, interaction router
├── schema.sql         all HM tables + the hm_member_totals view
└── src/
    ├── config.js      every setting, all from env
    ├── db.js          Supabase client (WebSocket polyfill + timeouts)
    ├── ranks.js       rank ladder, read-only mirror of Heimdall's
    ├── jagex.js       live hiscores, rate-limited and cached
    ├── quests.js      categories, targets, rewards, persistence
    ├── progress.js    completion, partial credit, expiry sweep
    ├── shop.js        perks, boosts, consumables
    ├── panels.js      rendering + the page ledger
    ├── permissions.js channel specs + the read-only overwrite matrix
    ├── commands.js    slash-command definitions, validated before deploy
    ├── register.js    writes one command scope, empties the other
    └── setup.js       auto/manual/repair
```

## The economy

Flat Rank XP per event. Deliberately small: a casual month of questing adds
roughly 3,200 XP against ~28,000 from tenure, so Legacy still lands around 21
months instead of being shortcut to 9.

| Event | Rank XP |
|---|---|
| Daily solo | 100 |
| Weekly solo | 250 |
| Monthly solo | 750 |
| Duo | 750 |
| Trio | 1,200 |
| Quad | 2,000 |

Adjust in `config.js` (`rankXp`). Existing guilds keep their own copy in
`hm_rank_xp_rules` and are seeded on first setup.

### Boosts — real quest-completion XP multipliers

A Boost is bought in the Shop, sits in Inventory until activated, then for its
duration multiplies the **Rank XP** a FINISHED quest in that one category
pays out. It does nothing to HM, nothing to an expired/partial quest, and it
is read fresh at the exact moment a quest completes (`getBoostMultiplier` in
`src/shop.js`, applied in `src/progress.js` before the amount is queued into
`pending_rank_xp`) — so it can never drift out of sync with what Heimdall
actually receives, and the boosted number is what gets written onto the
completion row in `#hm-database`.

| Tier | Cost | Multiplier | Duration |
|---|---|---|---|
| T1 | 750 HM | ×1.5 | 1 week |
| T2 | 2,250 HM | ×2.0 | 2 weeks |
| T3 | 7,500 HM | ×2.5 | 1 week |

Prices are 3x the original tuning, because a boost is now a real ongoing
advantage rather than a display-only number.

## Tests

```bash
npm test
```

83 checks, no network required: rank ladder parity with Heimdall, hiscores diff
maths, quest target generation, boss grouping, the panel ledger (growth,
shrinkage, self-heal, and — now that the guide/quest board/shop live in
separate channels — moving a panel to a new channel cleans up its old copy),
the full permission matrix (including that `guide` and `shop` are genuinely
separate channels from `quests`, not aliases of it), the slash-command payload
against Discord's required-before-optional rule, registration scope sync (the
duplicate-subcommand fix), and — against a fake Supabase client — that an
active Boost actually changes the Rank XP a finished quest queues, that a
party quest writes exactly one completion row with a per-member XP breakdown,
and that the Skip/Choice tokens are real inventory operations.

## Known gaps

- **LFG board** is a placeholder button; team quests currently go straight to
  direct invitations.
