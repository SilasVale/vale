#!/usr/bin/env python3
"""Render NSIS MUI brand art for the Vale online installer.

Same "vale at sunrise" vocabulary as scripts/render-brand-icon.py
(amber sky, glowing sun, rounded white hills — near hill solid, far hill
78% haze) sized for the MUI wizard:
  header.bmp  150x57   (top-right of every page)
  welcome.bmp 164x314  (left rail of welcome/finish pages)

Latin-only text (the wizard font handles Chinese; DejaVu has no CJK).
24-bit BMP, exact sizes — makensis rejects anything else.

Usage:
  render-installer-art.py [out_dir]   # default: agent/deploy/res/
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

SKY_TOP = (0xF5, 0x9F, 0x00)
SKY_BOT = (0xE8, 0x59, 0x0C)
SUN = (0xFF, 0xF8, 0xE1)
GLOW_COLOR = (0xFF, 0xF8, 0xE1)
HILL_FAR = (255, 255, 255, 0.78)
HILL_NEAR = (255, 255, 255, 1.0)

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def sky(w, h):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        c = lerp(SKY_TOP, SKY_BOT, y / max(h - 1, 1))
        for x in range(w):
            px[x, y] = c
    return img


def scene(img, sun_c, sun_r, glow_r, hills):
    """Bake glow per-pixel (like the brand renderer), then sun, then hills."""
    w, h = img.size
    px = img.load()
    for y in range(h):
        for x in range(w):
            d = ((x - sun_c[0]) ** 2 + (y - sun_c[1]) ** 2) ** 0.5
            if d <= glow_r:
                t = d / glow_r
                a = int(255 * (1 - t) * 0.55)
                if a > 0:
                    r_, g_, b_ = px[x, y]
                    px[x, y] = (
                        int(r_ * (255 - a) / 255 + GLOW_COLOR[0] * a / 255),
                        int(g_ * (255 - a) / 255 + GLOW_COLOR[1] * a / 255),
                        int(b_ * (255 - a) / 255 + GLOW_COLOR[2] * a / 255),
                    )
    d = ImageDraw.Draw(img)
    d.ellipse(
        [sun_c[0] - sun_r, sun_c[1] - sun_r, sun_c[0] + sun_r, sun_c[1] + sun_r],
        fill=SUN,
    )
    for mound, fill in hills:
        # rounded hill = wide ellipse sunk below the bottom edge; the visible
        # top arc reads as the brand's quadratic ridge (not a sharp triangle)
        cx, cy, rx, ry = mound
        _draw_hill(img, cx, cy, rx, ry, fill)
    return img


def _draw_hill(img, cx, cy, rx, ry, fill):
    """Fill an ellipse region with a (r,g,b,opacity) white blend."""
    w, h = img.size
    px = img.load()
    r_c, g_c, b_c, op = fill
    for y in range(max(0, int(cy - ry)), min(h, int(cy + ry) + 1)):
        dy = (y - cy) / ry
        if abs(dy) >= 1:
            continue
        half = int(rx * (1 - dy * dy) ** 0.5)
        for x in range(max(0, int(cx) - half), min(w, int(cx) + half + 1)):
            r_, g_, b_ = px[x, y]
            px[x, y] = (
                int(r_ * (1 - op) + r_c * op),
                int(g_ * (1 - op) + g_c * op),
                int(b_ * (1 - op) + b_c * op),
            )


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "agent", "deploy", "res"
    )
    os.makedirs(out, exist_ok=True)

    # header 150x57 — brand layout: sun left-of-center, twin hills centered
    h = sky(150, 57)
    scene(
        h,
        sun_c=(62, 20),
        sun_r=8,
        glow_r=18,
        hills=[
            ((88, 78, 34, 30), HILL_FAR),    # far ridge (haze), right of center
            ((58, 82, 30, 34), HILL_NEAR),   # near hill, left, overlapping
        ],
    )
    h.save(os.path.join(out, "header.bmp"))

    # welcome 164x314 — tall panel, brand layout + product name
    w = sky(164, 314)
    scene(
        w,
        sun_c=(72, 96),
        sun_r=20,
        glow_r=48,
        hills=[
            ((104, 340, 62, 58), HILL_FAR),
            ((58, 348, 58, 66), HILL_NEAR),
        ],
    )
    d = ImageDraw.Draw(w)
    try:
        f1 = ImageFont.truetype(FONT, 21)
        f2 = ImageFont.truetype(FONT, 11)
    except OSError:
        f1 = f2 = ImageFont.load_default()
    d.text((18, 238), "Vale Agent", font=f1, fill=(255, 255, 255))
    d.text((19, 264), "Windows online setup", font=f2, fill=(255, 243, 224))
    w.save(os.path.join(out, "welcome.bmp"))
    print("wrote", out + "/header.bmp", out + "/welcome.bmp")


if __name__ == "__main__":
    main()
