# Odinheim — Twitch Discord pop-up overlay

An animated card that slides into your stream, shows your clan Discord invite as a
**scannable QR code**, and disappears on its own. Drop it into OBS as a Browser
Source. One file, no build step, no internet needed at runtime (the QR is
generated in the page).

```
twitch-overlay/
├── index.html        ← the overlay (edit the CONFIG block at the top)
├── preview.html      ← mock stream + chat, just to see it in context
└── vendor/qrcode.js  ← QR encoder, MIT, vendored so OBS can load it offline
```

Open `preview.html` to see the card over a fake gameplay scene with a fake chat
next to it — that's the closest thing to how a viewer experiences it.

---

## First, the honest part: viewers can't click your overlay

This is worth knowing before you spend an evening on it, because it's a hard
limit on Twitch's side, not a missing feature in OBS:

| Where the thing lives | Can **viewers** click it? |
| --- | --- |
| Anything drawn inside OBS (image, browser source, animation) | **No.** Viewers receive encoded video pixels. Only *you* can click a browser source, via OBS's **Interact** window. |
| Twitch **video-overlay extension** over the player | **No off-site links.** Twitch's extension policy: "Video-overlay extensions may not contain links of any kind." Discord is not an exception. |
| Twitch **panel extension** / plain **channel panel** below the player | **Yes.** Panels are real web content. A plain panel needs no code at all; a panel *extension* can link out once you whitelist the domain and pass review. |
| **Chat** message with a link | **Yes.** Clickable by anyone in your chat. |

So a *clickable* pop-up on the video itself isn't something you can build — which
is exactly why the QR code exists. A phone camera is the one "click" every
viewer always has.

## The three things that actually work, best first

1. **This overlay + a QR code** (what's in this folder). Pops up, looks good,
   viewers scan it with the phone they're already holding. No policy risk.
2. **A Twitch panel.** `twitch.tv/<you>` → **Edit Panels** → add a **Text or
   Image** panel → paste your Discord invite. Clickable, free, 60 seconds, sits
   under the stream forever. This is the one people actually use.
3. **A chat command.** Add Nightbot / StreamElements / Fossabot and set
   `!discord` → your invite. Post it whenever someone asks, and put
   "type !discord" as the CTA text in the overlay (see `CTA` below).

Do all three. They cover each other: overlay for attention, panel for people who
scroll down, chat for people who just ask.

---

## Setup in OBS

1. **Add** → **Browser** source.
2. Tick **Local file** → browse to `twitch-overlay/index.html`.
3. Width **1920**, height **1080**. Untick **Shutdown source when not visible**
   and **Refresh browser when scene becomes active**, so the overlay doesn't
   restart the animation every scene switch.
4. Right-click the source → **Interact** to poke it while you're live, or press
   **D** in that window to pop the card manually.

Background is transparent, so the card floats over your game with no box
around it. Keep the source above your game capture and below any webcam frame
you want on top of it.

## Customising

Everything you'd want to change is the `CONFIG` block at the top of
`index.html`:

```js
const CONFIG = {
  LINK: "https://discord.gg/odinheim",     // your permanent invite
  CLAN:    "ODINHEIM",
  EYEBROW: "OSRS Clan",
  TAGLINE: "Raids · PvM · Skilling · 18+",
  CTA:     "Scan to join",                 // try "or type !discord"
  SHOW_SECONDS: 14,                        // how long it stays up
  INTERVAL_SECONDS: 0,                     // auto pop every N seconds (0 = off)
  START_VISIBLE: true,
  POSITION: "pos-bottom-right"             // …-bottom-left | -top-right | -top-left | pos-center
};
```

You can also override any of it per-scene with URL params instead of editing the
file — handy if you want it centred during a "join the clan" segment and in the
corner the rest of the time:

```
index.html?link=https://discord.gg/abcd1234&clan=ODINHEIM&seconds=20&interval=0&pos=pos-center&cta=Type%20!discord
```

Colours live in the `:root` block (`--gold`, `--ink`, etc.) if you want to move
off the clan gold.

## Triggering it on demand

- **Hotkey / click:** press `D` in the OBS Interact window, or click the card.
  `Esc` hides it. Leave `INTERVAL_SECONDS: 0` for a purely manual card.
- **On a channel-point reward:** point a **Streamer.bot** or **Mix It Up**
  action at the sound/overlay, or simply refresh the browser source — the card
  pops on load.
- **Every N minutes:** leave `INTERVAL_SECONDS` at something like `300`.

## Notes

- 1080p-safe: the card is 600 px wide inside a 1920×1080 canvas, ~13 s on
  screen. Don't shorten `SHOW_SECONDS` below ~10 — people need a beat to unlock
  their phone.
- QR is error-correction level **M** and sized to your link, so a short
  `discord.gg/<code>` invite keeps the modules chunky and easy to scan. Avoid
  the long `/invite/…` form.
- Set the invite to **never expire** in Discord (Invites → Edit → Expire After:
  Never) or the QR goes dead mid-stream.
- `prefers-reduced-motion` is respected, and there are no external fonts,
  scripts, or requests — nothing to break if OBS is offline or your PC is
  loaded.
