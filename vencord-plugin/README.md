# MessageAvatarStatus

A Vencord (or Equicord) **userplugin** that puts the presence indicator — 🟢 online, 🟡 idle/away,
🔴 do not disturb, ⚪ offline — on the avatars in the **message list**, so you can keep the member
list closed and still see who is around.

```
┌──────────────────────────────────────────────┐
│  (avatar)●  Loki          Today at 21:04   │   ● green  = online
│             hey, raid at 8?                 │   ● yellow = idle / away
│                                             │   ● red    = do not disturb
│  (avatar)●  Freya         Today at 21:05   │   ● grey   = offline
│             works for me                    │   (and a white dash on red, moon on yellow)
└──────────────────────────────────────────────┘
```

Status text is shown in a tooltip on hover (optional), and clicking the dot behaves like clicking
the avatar (opens the profile).

---

## Why the indicator is as reliable as the member list

This is the part worth reading, because "as reliable as the member list" is exactly what the plugin
does — for better and for worse:

* **Same data source.** Discord's own client keeps presence in one place (`PresenceStore`). The
  member list paints its dot from that store; this plugin paints its dot from that same store, with
  the same per-guild lookup (`PresenceStore.getStatus(userId, guildId, "offline")`) and the same
  fallback: no presence known → show offline. It never guesses, polls, or makes extra requests, so
  it cannot disagree with the member list.
* **Same update timing.** The plugin re-paints on `PRESENCE_UPDATE`, on `CONNECTION_OPEN`, and on
  `GUILD_MEMBER_LIST_UPDATE` (the event Discord sends when it lazily syncs a chunk of the member
  list, i.e. the moment new presences become available). So a status change lands on the avatar at
  the same time it lands in the member list.
* **The honest caveat (large servers).** Discord does not send you the presence of every member of
  every server. For a **user account**, you receive presence for:
  * everyone, in servers with fewer than ~250 members (all presences arrive when the guild loads), and
  * friends, implicit relationships, people you have a DM open with, and the member-list ranges
    Discord has already synced — in practice the top ~100 members that the client preloads
    (`OP 14` / `[0, 99]`).

  That last bullet is why the member list sometimes shows a stale "offline" for someone far down the
  list — the data was never delivered. The member list can *recover* from that because scrolling it
  makes Discord request a new range; a message avatar cannot request anything, so for members outside
  the synced range the dot will show the same (possibly stale) value the member list would show for
  them. **In clan-sized servers (well under 250 members) everything is live and this caveat never
  applies.** In a 10,000-member server, treat grey as "offline or not delivered yet" — exactly as you
  already have to with the member list.

So: parity with the member list, not a replacement for Discord's gateway subscription model. The
plugin deliberately does not try to fire extra member-list subscriptions, because that is what gets
clients rate-limited.

---

## Install

It is a *userplugin*, so it needs a Vencord built from source (the normal installer install does not
load userplugins).

```bash
git clone https://github.com/Vencord/Vencord.git
cd Vencord
pnpm install

mkdir -p src/userplugins
cp -r /path/to/this/repo/vencord-plugin/messageAvatarStatus src/userplugins/

pnpm build
pnpm inject      # installs the build into the Discord app
```

Then start Discord → **Settings → Vencord → Plugins** → enable **MessageAvatarStatus**. It appears
under its own name and is not part of the official plugin list, which is expected for userplugins.

There is also `install-into-vencord.sh` next to this README, which copies the plugin in for you:

```bash
./install-into-vencord.sh ~/code/Vencord          # copy only
./install-into-vencord.sh ~/code/Vencord --build  # copy, then pnpm build && pnpm inject
```

Notes:

* **Equicord** works the same way (same `src/userplugins` folder, same `definePlugin` API).
* **Vesktop / browser builds:** build for the matching target — `pnpm build` for the desktop app,
  `pnpm buildWeb` for the browser build. Vesktop can be pointed at your own build via
  *Settings → Developer options → Vencord location*.
* After editing the plugin, `pnpm build --watch` (or `pnpm watch`) rebuilds on save; restart Discord
  after a rebuild.

---

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **Show offline indicator** | on | Grey dot for offline members. Turn it off to only see people who are around. |
| **Position** | Bottom right | Bottom right / bottom left / top right / top left. Automatically tucks itself inside the avatar if the wrapper clips overflow. |
| **Size** | Normal | Small (9px) / Normal (12px) / Large (16px). |
| **Show status tooltip** | on | Hover the dot for "Online", "Idle", "Do Not Disturb", "Offline" plus the person's custom status. |

### Theming

The colours match Discord's member list palette and every one of them is a CSS variable, so QuickCSS
or a theme can restyle them:

```css
:root {
    --vc-mas-online: #23a55a;
    --vc-mas-idle: #f0b232;
    --vc-mas-dnd: #f23f43;
    --vc-mas-offline: #80848e;
    --vc-mas-streaming: #593695;

    /* the gap ring around the dot, so it reads over the avatar art */
    --vc-mas-ring-color: var(--background-primary);
}
```

---

## How it works (short version)

It is a DOM decorator rather than a minified-code patch, which is why it keeps working across
Discord updates:

* Watches `[data-list-id="chat-messages"]` (Discord's virtualised message list — a plain attribute,
  not a hashed class) for added/changed avatars.
* Finds the user id in the avatar's CDN URL (`/avatars/<userId>/…`, including per-guild avatars at
  `/guilds/<guildId>/users/<userId>/avatars/…`). For members with a default avatar that URL has no id,
  so it falls back to `chat-messages-<channelId>-<messageId>` + `MessageStore`.
* Appends one `<span class="vc-mas-dot">` per avatar, positioned against the avatar wrapper, with a
  `data-status` attribute that CSS colours. Avatars smaller than 24px (reply previews, embeds) are
  skipped.
* Repaints from `PresenceStore` on presence events; nothing is cached between passes, so recycled
  DOM nodes (scrolling a long channel) can never show the wrong person's status.

## If dots disappear one day

That means Discord changed one of the two selectors at the top of `index.tsx`
(`CHAT_LIST_SELECTOR`, `AVATAR_SELECTOR`). Open DevTools on the chat, inspect a message avatar, and
update the constants — no patch signatures to hunt down. If the dots are there but never change
colour, check that Discord's own member list dot for the same person agrees; if it does, presence was
simply not delivered (see the caveat above).

## Uninstall

Disable the plugin in Vencord settings, or delete `src/userplugins/messageAvatarStatus` and rebuild.

---

Tested against **Vencord 1.15.17**: `tsc --noEmit` clean and `pnpm build` produces a bundle containing
the plugin and its stylesheet. Licensed GPL-3.0-or-later, matching Vencord, since it is written
against Vencord's plugin API.
