#!/usr/bin/env node
/**
 * Builds the downloadable Twitch pack: a zip a streamer can unzip anywhere,
 * plus a single-file copy of the overlay that needs no sibling `vendor/` folder.
 *
 *   node scripts/build-twitch-pack.js
 *
 * Writes:
 *   ../odinheim-twitch-pack/               (working copy, outside the repo)
 *   ../odinheim-twitch-pack.zip            (hand this to a human)
 *
 * Not committed — the zip is a build artifact. Re-run any time the overlay or
 * panel changes.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "twitch-overlay");
const OUT = path.resolve(ROOT, "..", "odinheim-twitch-pack");
const ZIP = path.resolve(ROOT, "..", "odinheim-twitch-pack.zip");

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const copy = (rel, destRel = rel) => {
  const dest = path.join(OUT, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), dest);
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(OUT, { recursive: true });

/* ---- 1. the folder version, as-is ---- */
copy("index.html");
copy("vendor/qrcode.js");
copy("preview.html");
copy("README.md");
copy("panel/panel-640x200.png");
copy("panel/panel-320x100.png");
copy("panel/make-panel.py");

/* ---- 2. single-file overlay: same page with the QR encoder inlined ---- */
const indexHtml = read("index.html");
const qrcodeJs = read("vendor/qrcode.js");
const tag = '<script src="vendor/qrcode.js"></script>';
if (!indexHtml.includes(tag)) throw new Error("overlay no longer references vendor/qrcode.js — update the inliner");

// NOTE: replacement is a *function* on purpose. qrcode.js contains `$&`, `$'`
// and friends, which String.replace would expand as replacement patterns and
// silently cripple the file — that bug shipped once already.
const single = indexHtml.replace(tag, () =>
  "<!-- QR encoder (qrcode-generator 2.0.4, MIT, Kazuhiko Arase) inlined so this\n" +
  "     file works on its own with no folder next to it. -->\n" +
  "<script>\n" + qrcodeJs + "\n</script>"
);
// point the drag-me-around hint at the file itself, not the folder
const singleNamed = single.replace(
  "See README.md in this folder",
  "See README.md in this pack"
);
if (!singleNamed.includes("var qrcode = function") || singleNamed.split("</script>").length < 3) {
  throw new Error("inlined overlay looks broken — check the replacement in build-twitch-pack.js");
}
fs.writeFileSync(path.join(OUT, "odinheim-overlay-single-file.html"), singleNamed);

/* ---- 3. START-HERE.txt: the shortest possible path to "it's working" ---- */
fs.writeFileSync(
  path.join(OUT, "START-HERE.txt"),
  `ODINHEIM TWITCH PACK — read this first
======================================

What's in here
--------------
odinheim-overlay-single-file.html   The pop-up overlay. ONE file. Use this one.
odinheim-overlay.html               Same overlay, needs the vendor/ folder.
twitch-overlay/                     The whole folder version, plus preview + source.
panel/panel-640x200.png             The clickable panel image for your channel page.
README.md                           Full setup notes, troubleshooting, the rules about
                                    what Twitch does and doesn't allow.

DO THIS FIRST (2 minutes)
-------------------------
1. Double-click odinheim-overlay-single-file.html. A card pops up and disappears
   after ~14 seconds. That's the overlay working. It loops if you refresh.
2. Open that file in a text editor (Notepad / TextEdit / VS Code) and change one
   line near the top:

       LINK: "https://discord.gg/odinheim",

   to your clan's real invite. Save. Refresh the page — the QR code updates
   itself to the new link. (Set the invite to "Expire After: Never" in Discord
   or you'll be streaming a dead QR in a month.)

ADD IT TO OBS
-------------
1. In your scene, click + under Sources, pick "Browser", OK.
2. Tick "Local file" -> Browse -> pick odinheim-overlay-single-file.html.
3. Width 1920, Height 1080.
4. UNTICK "Shutdown source when not visible".
5. UNTICK "Refresh browser when scene becomes active".
6. Leave the background colour alone (transparent is what makes it float).

Popping it while live: right-click the source -> "Interact", then click the card
or press D. Esc hides it. Right-click -> "Refresh page" also pops it.

ADD THE PANEL (30 seconds)
--------------------------
On twitch.tv/yourname -> About section -> Edit Panels -> + -> Image ->
upload panel/panel-640x200.png -> paste your invite into the panel's LINK field
(that's what makes it clickable) -> Save.

WHY THIS AND NOT A CLICKABLE POP-UP?
------------------------------------
Viewers can't click anything drawn on your video - Twitch sends them video
pixels, and Twitch's rules forbid links inside video-overlay extensions. The QR
code is the workaround (a phone camera always works), and the panel is the one
place on your channel that is genuinely clickable. README.md explains it.

Questions the README answers: customising text/colours, moving the card,
auto-popping every N minutes, channel-point triggers, blurry card, QR not
scanning, card popping on its own.
`
);

/* ---- 4. zip it ---- */
execFileSync("zip", ["-r", "-q", path.basename(ZIP), path.basename(OUT)], {
  cwd: path.dirname(OUT),
  stdio: "inherit",
});

const kb = (p) => (fs.statSync(p).size / 1024).toFixed(0) + " KB";
console.log("pack dir:", OUT);
console.log("zip     :", ZIP, "(" + kb(ZIP) + ")");
