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

- `/setup auto` — creates a `Honour Marks` category with `#honour-marks`,
  `#hm-database`, `#hm-staff`, `#hm-log`, posts every panel, seeds the XP rules.
  Needs **Manage Channels**.
- `/setup manual` — binds to channels you already have. Uses native channel and
  role pickers, so there are no IDs to paste.
- `/setup repair` — re-verifies channels and reposts any missing panel.
- `/setup status` — shows what's bound.

You can run `/setup` again at any time; it reconciles rather than duplicating.

**5. Members.** `/register rsn:YourName` — verified against the OSRS hiscores
before it's accepted, so nobody ends up with a dead registration.

## Railway

Add a **second service** to the existing project, pointing **Root Directory**
at `honour-marks/`. Free plan allows 3 services per project, so both bots fit.
Environment variables live on the service, not the repo.

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

## Known gaps

- **Choice token** is purchasable and consumable but doesn't yet force a target
  — the selection flow needs a target picker.
- **LFG board** is a placeholder button; team quests currently go straight to
  direct invitations.
- **Skip token** is purchasable but not yet wired to cancel a quest.
