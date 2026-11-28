# ToA dry counter (keyboard-driven)

A HUD that counts **chests since your last purple** at Tombs of Amascut.

- One press per chest → the number goes up.
- One press when the purple lands → the streak gets banked, your **best** updates,
  and the counter drops back to zero.
- It also remembers how many purples you've had and every streak length, so
  "how dry have I actually been" stops being a vibe and becomes a number.

```
node twitch-overlay/counter/counter-server.js
```

Then add an OBS **Browser** source pointing at **`http://127.0.0.1:7391/`**.

## Why there's a server

An OBS browser source only receives keystrokes while its **Interact** window has
focus. Pressing a key in-game does nothing — the source is a web page in a hidden
browser, and OBS doesn't forward input to it. So the count can't live in the page.

Instead the page *listens*, and something that can see your keys *pushes*:

```
  your keyboard ──▶ hotkeys.ps1 / Streamer.bot ──▶ HTTP ──▶ counter-server ──▶ overlay
                     (sees keys system-wide)                (holds the count)    (OBS)
```

Which is also why it survives: close OBS, reboot, the streak is still there
(it's written to `counter-state.json`).

## Quick start

```bash
# 1. start the server (leave the window open, or run it at login)
node twitch-overlay/counter/counter-server.js
#    → overlay  http://127.0.0.1:7391/
#    → buttons  http://127.0.0.1:7391/app

# 2. in OBS: + → Browser → URL http://127.0.0.1:7391/ → 1920x1080
#    (a Local file will NOT work — it has to be the server's URL)

# 3. Windows: double-click run-hotkeys.bat
#    (NOT hotkeys.ps1 — see below)
```

| Key | Does |
| --- | --- |
| **Numpad +** | chest opened, count +1 |
| **Numpad −** | undo one (miscounted) |
| **Numpad 0** or **Numpad .** | **GOT A PURPLE** — banks the streak, back to 0 |

Change the keys at the top of `hotkeys.ps1`; the numbers are Windows virtual key
codes and there's a cheat sheet in the file. `GetAsyncKeyState` polling needs no
admin rights, installs nothing, and runs at ~28 Hz.

### "I ran it and the window closed instantly"

That's PowerShell refusing the script before it gets to the listening loop —
almost always the script-execution policy, or the file still marked as "came
from the internet" after unzipping. A double-clicked `.ps1` shows the error for
about 200 ms and vanishes, which is why it looks like nothing happened.

**Use `run-hotkeys.bat` instead.** It runs PowerShell with
`-NoProfile -ExecutionPolicy Bypass`, unblocks the `.ps1` first, and then
**pauses** — so an error stays on screen and can be read.

### Numpad + does nothing, no errors

Run **`test-keys.bat`**. It prints the virtual-key code of every key you press:

```
  key down: VK 107 (0x6B)      <- that's Numpad +
  key down: VK 109 (0x6D)      <- that's Numpad -
```

- **Lines appear** when you press Numpad + → Windows sees the key; the binding
  or the server is the problem, not the keyboard.
- **No lines at all** → the key isn't reaching Windows as a numpad key (laptops
  without a numpad, or NumLock oddities). Use the codes it *does* report: paste
  them into `$Bindings` at the top of `hotkeys.ps1`.
- **`Add-Type failed`** → your PowerShell can't compile the key-polling call.
  Run it with PowerShell 7 (`pwsh.exe`) instead, or drive the counter from the
  `/app` buttons page / Streamer.bot.

## Fixing a wrong count

Open **`http://127.0.0.1:7391/app`** — big buttons, live count, best and purple
total. Bookmark it on your phone (same Wi-Fi: `http://<your-pc-ip>:7391/app`).
There's **Reset (no purple)** for a genuine miscount — it zeroes the live number
*without* recording a streak or touching your best.

## API (Streamer.bot, Stream Deck, curl, anything)

All plain GETs, CORS-open:

| Call | Effect |
| --- | --- |
| `/api/bump` or `/api/bump?d=1` | chest opened |
| `/api/bump?d=-1` | undo one |
| `/api/purple` | **purple** — banks the streak, returns `{count:0, streak:N, best, purples}` |
| `/api/reset` | zero the count, record nothing |
| `/api/set?n=12` | jump to 12 |
| `/api/state` | `{"count":12,"best":41,"purples":3,"lastStreak":41,"history":[...]}` |
| `/events` | Server-Sent Events stream (the overlay's feed) |

**Streamer.bot:** action → **Core → HTTP Request** → `GET`
`http://127.0.0.1:7391/api/bump?d=1`, attach it to a hotkey; duplicate it for
`/api/purple`. Same for Mix It Up. (You could also run the whole thing off
Streamer.bot's own globals and a Text source — fewer moving parts, plainer HUD.)

## Overlay options

Append to the browser source URL:

| Param | Default | |
| --- | --- | --- |
| `?eyebrow=Tombs of Amascut` | `Tombs of Amascut` | small gold line on top |
| `&sub=chests since purple` | `chests since purple` | small line under the number |
| `&stats=false` | shown | hide the `best 41 · 3 purples` line |
| `&pos=pos-top-left` | `pos-bottom-left` | also `-bottom-right`, `-top-right`, `pos-center` |
| `&scale=1.3` | `1` | bigger HUD |
| `&wander=20` | `20` | every N minutes the HUD bounces around the screen for a few seconds, then springs back home (`0` = off) |
| `&wander-seconds=20` | `20` | how long it roams before springing back home |
| `&purple-seconds=45` | `45` | how long the HUD stays violet after a purple, then defaults back to gold |

e.g. `http://127.0.0.1:7391/?pos=pos-top-right&scale=1.25&stats=false`

On a purple the HUD flashes violet, fires a shockwave ring, pops a big
`PURPLE!` banner with a confetti burst, and floats `PURPLE! 41 dry` above the
number while it drops back to 0. The gold dot beside
the label turns **red** if the overlay loses the server, so a frozen HUD looks
different from a dead one.

## Notes

- **A dry streak can't go negative.** Undo below zero clamps at 0; the purple
  count and best are never touched by undo or reset.
- **History is capped at 200 streaks** (oldest dropped) so
  `counter-state.json` stays a few KB.
- `COUNTER_ROOT=demo` serves the try-it page at `/` instead of the bare HUD —
  that's how the hosted demo runs; you never need it locally.
- **Port 7391 by default.** Override with `COUNTER_PORT=7500` before starting.
- **Node must be on the gaming PC.** You already have it for the Discord bot —
  just check it's the same machine.
- Two scenes showing the counter works fine; every overlay page subscribes to
  the same server.
- HUD stuck at 0 and never moves → server isn't running (dot will be red).
  Moves on the buttons page but not in OBS → the source points at the **file**
  instead of the URL.
- **Two different overlays live in this pack.** The Discord pop-up (`index.html`
  / `odinheim-overlay-single-file.html`) is a **Local file** source. The counter
  is a **URL** source (`http://127.0.0.1:7391/`). Pointing OBS at the wrong one
  is the most common "the counter never moves".
- Nothing here needs you to be live. It's all `127.0.0.1` — Twitch isn't
  involved until the pixels leave OBS.
