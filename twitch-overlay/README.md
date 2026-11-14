# Odinheim — Twitch Discord pop-up overlay

An animated card that slides into your stream, shows your clan Discord invite as a
**scannable QR code**, and disappears on its own. Drop it into OBS as a Browser
Source. One file, no build step, no internet needed at runtime (the QR is
generated in the page).

```
twitch-overlay/
├── index.html          ← the overlay (edit the CONFIG block at the top)
├── preview.html        ← mock stream + chat, just to see it in context
├── panel/              ← the clickable panel graphic + the script that draws it
│   ├── panel-640x200.png   ← upload this to Twitch
│   └── make-panel.py       ← regenerate it with different text
└── vendor/qrcode.js    ← QR encoder, MIT, vendored so OBS can load it offline
```

Open `preview.html` to see the card over a fake gameplay scene with a fake chat
next to it — that's the closest thing to how a viewer experiences it.

### Just want the files, not a repo?

```bash
node scripts/build-twitch-pack.js
```

From the repo root. Writes `odinheim-twitch-pack.zip` next to the repo (not
inside it) containing everything here, plus:

- **`odinheim-overlay-single-file.html`** — the overlay with the QR encoder
  inlined into the page. One loose file, no `vendor/` folder needed, so you can
  drop it anywhere and point OBS at it. Use this if in doubt.
- **`START-HERE.txt`** — the four steps, plain text, for future you.

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

## The panel (the clickable one)

A **panel** is one of the boxes that sit under your video player on
`twitch.tv/<you>`, in the *About* area — two narrow columns, each panel 320 px
wide. They're ordinary web content, not video, which is why they're the one part
of your channel a viewer can genuinely click. They persist forever, need no
extension, no review, no developer account, and they also show up in the mobile
app's About tab.

`panel/panel-640x200.png` is a matching one — same gold, crest and wordmark as
the overlay. Twitch renders panels at 320 px wide, so the 640-wide file is a 2×
upload that stays crisp on retina screens.

**Adding it:**

1. Open `twitch.tv/<yourname>` while logged in, scroll to the **About** section
   (just under the player) and click **Edit Panels** — or the **+** tile if the
   edit toggle is already on.
2. Choose **Image**.
3. **Upload** `panel/panel-640x200.png`.
4. Put your invite in the **link** field on that panel — that's what makes the
   whole box clickable.
5. Caption is optional and shows as alt text/below the image. Something like
   `Clan Odinheim — OSRS · raids, PvM, skilling` works; anything longer wraps onto
   a second line and pushes the layout down.
6. **Save**, then reload your channel page to check it. Click it yourself before
   you go live.

Order matters a little: panels fill left column first, top to bottom. Put the
Discord one first so it's the first thing under your stream.

**Want different wording on it?** The text is baked into the PNG, so edit the
strings in `make-panel.py` (`ODINHEIM`, `JOIN THE CLAN DISCORD`, `JOIN`) and
rerun it — it only needs Pillow:

```bash
cd twitch-overlay/panel && pip install pillow && python3 make-panel.py
```

**Text panel instead?** Also completely fine and takes ten seconds: add a
**Text** panel, paste the invite, and Twitch auto-links it. The image just looks
better and matches the stream.

## Setup in OBS

**1. Add the source.** In your scene: **+** under *Sources* → **Browser** → name it
`Discord Pop-up` → OK.

**2. Point it at the file.** Tick **Local file**, then **Browse…** and pick
`twitch-overlay/index.html` (wherever you cloned this repo). Don't paste a
`file:///…` URL by hand unless you have to — the checkbox keeps it portable.

**3.** Set **Width** `1920`, **Height** `1080` — the full canvas, not the size of
the card. The card is 600 px wide and sits inside that canvas, so it stays sharp
at 720p/1080p and doesn't need rescaling.

**4. Untick these two boxes** (they're the usual culprits):

| Checkbox | Leave it | Why |
| --- | --- | --- |
| **Shutdown source when not visible** | **off** | Otherwise the page reloads every time you change scenes and the card pops on its own mid-fight. |
| **Refresh browser when scene becomes active** | **off** | Same thing — the card would pop every scene switch instead of when you want it. |

**5. Don't add a background colour.** Transparent is the default and is what
makes the card float over the game with no box around it.

That's it — the source should animate in immediately (it pops once on load, then
hides). From then on you control it.

### Popping it while you're live

- **Right-click the source → Interact.** A window opens with just the overlay in
  it. Click the card or press **D** to pop it, **Esc** to hide. Leave this window
  open on a second monitor — it's the intended remote control.
- **Right-click the source → Refresh page** pops it instantly, always, because
  the card shows on load. Handy if you'd rather not keep the Interact window up.
- **Auto:** set `INTERVAL_SECONDS` (e.g. `300` for every 5 minutes) and forget
  about it.
- **On a channel-point reward:** have Streamer.bot / Mix It Up refresh the source
  (obs-websocket, or a Stream Deck "Refresh Browser Source") when someone redeems
  "post the Discord".

### Putting it somewhere other than the bottom-right corner

The card is anchored inside the 1920×1080 canvas, so dragging the source around
moves the whole canvas, not the card. Two clean options:

- **Another corner/centre** — set `POSITION` in `CONFIG`, or append
  `?pos=pos-top-left` (`pos-center`, `pos-top-right`, `pos-bottom-left`).
- **Anywhere at all** — shrink the *source* to roughly `700 × 420` and drag it
  wherever you want on screen. The card fills that little canvas and the gap
  around it is controlled by `?pad=24` (default `56` px). This is the trick to
  use if you want it tucked beside your webcam or above your alerts.

### Layer order

Put the pop-up **above** your game capture and overlay images, and **below**
anything you want drawn on top of it (webcam frame, alert box) — just drag it in
the Sources list. It renders with a transparent background, so it never punches
a hole in the scene.

### If something looks off

- **Blurry card** — the source isn't 1920×1080. Either set it exactly, or
  right-click → **Transform** → **Fit to screen** and don't scale it by hand.
- **Card never appears** — check `START_VISIBLE` is `true` and that you didn't
  set `?start=false`. Then try **Refresh page** in the source's context menu.
- **Card pops on its own** — you left `Refresh browser when scene becomes active`
  ticked, or `INTERVAL_SECONDS` is above 0.
- **Timing drifts / it reloads alone** — "Shutdown source when not visible" is on.
- **QR won't scan on stream** — the invite is long, so the modules got tiny. Use a
  short `discord.gg/<code>` invite, keep the 1080p source, and give it ~10 s on
  screen. Test by scanning the actual stream preview on your phone, not the file.
- **Nothing renders at all** — OBS is too old; browser sources shipped in OBS 18
  and got much better at 27+, so update.

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

Every key above has a URL-param twin: `link`, `clan`, `eyebrow`, `tagline`,
`cta`, `seconds`, `interval`, `start`, `pos`, `pad`. Colours live in the `:root`
block (`--gold`, `--gold-hot`, etc.) if you want to move off the clan gold.

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
- No audio is played. The QR code is generated in-page, so changing `LINK` is
  the only step to re-point it — never screenshot the QR, just keep the source
  as the file.
