# Counter overlay (keyboard-driven)

A HUD that counts up and down while you stream — deaths, KC, dry streaks, "how
many times did I forget my rune pouch". Press a key, the number moves.

```
node twitch-overlay/counter/counter-server.js
```

Then add an OBS **Browser** source pointing at **`http://127.0.0.1:7391/`**.

## Why there's a server

An OBS browser source only receives keystrokes while its **Interact** window has
focus. Pressing a key in-game does nothing, by design — the source is a web page
in a hidden browser, and OBS doesn't forward input to it. So the count can't live
in the page.

Instead the page *listens*, and something that can see your keys *pushes*:

```
  your keyboard ──▶ hotkeys.ps1 / Streamer.bot ──▶ HTTP ──▶ counter-server ──▶ overlay
                     (sees keys system-wide)                (holds the count)    (OBS)
```

That's also why it survives: close OBS, restart the PC, the count is still there
(it's written to `counter-state.json`).

## Quick start

```bash
# 1. start the server (leave this window open, or run it on boot)
node twitch-overlay/counter/counter-server.js
#    → overlay  http://127.0.0.1:7391/
#    → buttons  http://127.0.0.1:7391/app

# 2. in OBS: + → Browser → URL http://127.0.0.1:7391/ → 1920x1080
#    (a Local file will NOT work — it has to be the server's URL)

# 3. Windows: right-click hotkeys.ps1 → Run with PowerShell
```

Default keys: **Numpad +** adds one, **Numpad −** subtracts one, **Numpad 0**
resets. Change them at the top of `hotkeys.ps1` — the numbers are Windows virtual
key codes, and there's a cheat sheet in the file. `F7/F8/F9` are the other
popular choice; numpad is safer because games rarely claim it.

`hotkeys.ps1` uses `GetAsyncKeyState`, needs no admin rights, installs nothing,
and only polls ~28 times a second.

## Fixing a wrong count

Open **`http://127.0.0.1:7391/app`** — three big buttons, live count. Bookmark it
on your phone (same Wi-Fi, `http://<your-pc-ip>:7391/app`) and you have a remote
control. Also handy on a Stream Deck's web-browser button.

## API (for Streamer.bot, a Stream Deck, curl, anything)

All plain GETs, CORS-open:

| Call | Effect |
| --- | --- |
| `/api/bump` or `/api/bump?d=1` | add 1 |
| `/api/bump?d=-1` | subtract 1 |
| `/api/bump?d=25` | add 25 |
| `/api/reset` | back to 0 |
| `/api/set?n=42` | jump to 42 |
| `/api/state` | `{"count":42}` |
| `/events` | Server-Sent Events stream (the overlay's feed) |

**Streamer.bot:** action → sub-action **Core → HTTP Request** → `GET` →
`http://127.0.0.1:7391/api/bump?d=1` → attach it to a hotkey or a channel-point
reward. Same for Mix It Up. Or skip this whole server and let Streamer.bot's own
globals drive a Text source — fewer moving parts, less pretty HUD.

## Overlay options

Append to the browser source URL:

| Param | Default | |
| --- | --- | --- |
| `?label=Deaths` | `Deaths` | text above the number |
| `&suffix=KC` | *(none)* | small text after the number |
| `&pos=pos-top-left` | `pos-bottom-left` | also `-bottom-right`, `-top-right`, `pos-center` |
| `&scale=1.4` | `1` | bigger HUD |
| `&hideWhenZero=true` | `false` | invisible until the count leaves 0 |

e.g. `http://127.0.0.1:7391/?label=Kills&suffix=KC&pos=pos-top-right&scale=1.3`

The gold dot next to the label turns **red** if the overlay loses the server, so
you can see at a glance that the counter has gone deaf.

## Notes

- **Port 7391 is hardcoded by default.** Override with `COUNTER_PORT=7500` before
  starting, e.g. `set COUNTER_PORT=7500 && node counter-server.js`.
- **Node must be on the streaming PC** for this version. You already have it for
  the Discord bot — just check it's the same machine. If it isn't, Streamer.bot's
  built-in counters are the no-Node route.
- Two scenes both showing the counter works fine — every overlay page subscribes
  to the same server.
- If the HUD sits at 0 and never moves: the server isn't running (dot will be
  red). If it moves but the number doesn't change in OBS, the source is probably
  pointed at the **file**, not the URL.
