#!/usr/bin/env python3
"""
Regenerates the Twitch panel graphics for the Odinheim Discord invite.

    pip install pillow
    python3 make-panel.py

Writes panel-640x200.png (upload this one — Twitch scales it to 320 px wide and
the extra resolution keeps the Text crisp on retina displays) and
panel-320x100.png (the 1x reference size).

Design matches twitch-overlay/index.html: near-black card, clan gold, serif
"ODINHEIM" wordmark, shield crest, and a gold link pill on the right. Panels are
real web content, so the whole box is clickable once you attach a link in
Twitch's panel editor — the pill is a visual cue, not a separate target.
"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 640, 200                      # designed at 2x, downscaled to 320x100
GOLD = (240, 201, 107)
GOLD_HOT = (255, 230, 168)
GOLD_DEEP = (168, 121, 42)
PARCHMENT = (245, 236, 216)
MUTED = (169, 180, 194)

SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
SANS_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

f_title = ImageFont.truetype(SERIF, 46)
f_sub = ImageFont.truetype(SANS_BOLD, 18)
f_pill = ImageFont.truetype(SANS_BOLD, 17)


def vgradient(size, top, bottom):
    """Vertical linear gradient as an RGB image."""
    w, h = size
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize((w, h), Image.BILINEAR)


def tracked(draw, xy, text, font, fill, tracking=0.0, anchor_left=True):
    """Draws text with letter-spacing. Returns total width."""
    x, y = xy
    total = sum(draw.textlength(c, font=font) + tracking for c in text) - (tracking if text else 0)
    if not anchor_left:
        x -= total
    for c in text:
        draw.text((x, y), c, font=font, fill=fill)
        x += draw.textlength(c, font=font) + tracking
    return total


def gradient_text(base, xy, text, font, top, bottom):
    """Paints text filled with a vertical gradient (chrome/gold look)."""
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).text(xy, text, font=font, fill=255)
    bbox = mask.getbbox()
    if not bbox:
        return
    grad = vgradient((bbox[2] - bbox[0], bbox[3] - bbox[1]), top, bottom)
    full = Image.new("RGB", base.size, (0, 0, 0))
    full.paste(grad, (bbox[0], bbox[1]))
    base.paste(full, (0, 0), mask)


def shield(img, x, y, w, h):
    draw = ImageDraw.Draw(img)
    """Clan crest: gold shield outline with the rune mark from the overlay."""
    cx = x + w / 2
    pts = [(cx, y), (x + w, y + h * 0.161), (x + w, y + h * 0.5),
           (x + w * 0.83, y + h * 0.83), (cx, y + h),
           (x + w * 0.17, y + h * 0.83), (x, y + h * 0.5), (x, y + h * 0.161)]
    draw.line(pts + [pts[0]], fill=GOLD, width=4, joint="curve")
    inner = [(cx, y + h * 0.146), (x + w * 0.86, y + h * 0.246),
             (x + w * 0.86, y + h * 0.5), (cx, y + h * 0.82),
             (x + w * 0.14, y + h * 0.5), (x + w * 0.14, y + h * 0.246)]
    fill_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(fill_layer).polygon(inner, fill=GOLD + (40,))
    img.alpha_composite(fill_layer)
    draw = ImageDraw.Draw(img)
    # rune: upright stave with a chevron and a base bar
    draw.line([(cx, y + h * 0.31), (cx, y + h * 0.70)], fill=GOLD, width=4)
    draw.line([(cx - w * 0.15, y + h * 0.43), (cx, y + h * 0.30),
               (cx + w * 0.15, y + h * 0.43)], fill=GOLD, width=4, joint="curve")
    draw.line([(cx - w * 0.13, y + h * 0.66), (cx + w * 0.13, y + h * 0.66)],
              fill=GOLD, width=4)


def build():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    # card body: dark gradient, gold hairline, rounded
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    body = vgradient((W, H), (23, 30, 40), (8, 12, 17)).convert("RGBA")
    halo = Image.new("L", (W, H), 0)
    ImageDraw.Draw(halo).ellipse([-180, -190, 320, 150], fill=34)
    halo = halo.filter(ImageFilter.GaussianBlur(46))
    warm = Image.new("RGBA", (W, H), GOLD + (255,))
    warm.putalpha(halo)
    body = Image.alpha_composite(body, warm)
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], radius=26, fill=255)
    card.paste(body, (0, 0), mask)
    img = Image.alpha_composite(img, card)

    d = ImageDraw.Draw(img)
    d.rounded_rectangle([1, 1, W - 2, H - 2], radius=26, outline=GOLD + (110,), width=2)
    d.rounded_rectangle([5, 5, W - 6, H - 6], radius=22, outline=(255, 255, 255, 20), width=1)

    # crest
    shield(img, 40, 56, 78, 88)
    d = ImageDraw.Draw(img)

    # wordmark + subtitle
    tx = 138
    gradient_text(img, (tx, 46), "ODINHEIM", f_title, GOLD_HOT, GOLD_DEEP)
    tracked(d, (tx + 2, 108), "JOIN THE CLAN DISCORD", f_sub, MUTED + (235,), tracking=1.8)

    # gold link pill on the right
    pw, ph = 112, 50
    px0, py0 = W - 36 - pw, (H - ph) / 2
    d.rounded_rectangle([px0, py0, px0 + pw, py0 + ph], radius=ph / 2, fill=GOLD)
    label = "JOIN"
    arrow = 15
    tw = d.textlength(label, font=f_pill)
    start = px0 + (pw - (tw + 6 + arrow)) / 2
    d.text((start, py0 + ph / 2 - 12), label, font=f_pill, fill=(26, 18, 4))
    ax = start + tw + 6
    ay = py0 + ph / 2
    d.line([(ax, ay + 5), (ax + arrow, ay - 6)], fill=(26, 18, 4), width=3)
    d.line([(ax + arrow - 7, ay - 6), (ax + arrow, ay - 6)], fill=(26, 18, 4), width=3)
    d.line([(ax + arrow, ay - 6), (ax + arrow, ay + 1)], fill=(26, 18, 4), width=3)

    print(f"title ends at x={tx + d.textlength('ODINHEIM', font=f_title):.0f}, "
          f"pill starts at x={px0:.0f}")
    img.save("panel-640x200.png")
    img.resize((320, 100), Image.LANCZOS).save("panel-320x100.png")
    print("wrote panel-640x200.png and panel-320x100.png")


if __name__ == "__main__":
    build()
