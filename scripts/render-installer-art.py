#!/usr/bin/env python3
"""Render NSIS MUI brand art for the Vale online installer.

Same "vale at sunrise" vocabulary as scripts/render-brand-icon.py
(amber sky, glowing sun, white hills) sized for the MUI wizard:
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
HILL_FAR = (0xFF, 0xFF, 0xFF, 200)
HILL_NEAR = (0xFF, 0xFF, 0xFF, 255)

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
    d = ImageDraw.Draw(img, "RGBA")
    w, h = img.size
    # glow
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse(
        [sun_c[0] - glow_r, sun_c[1] - glow_r, sun_c[0] + glow_r, sun_c[1] + glow_r],
        fill=(255, 248, 225, 110),
    )
    img.alpha_composite(glow) if False else None
    d = ImageDraw.Draw(img, "RGBA")
    # re-draw glow manually (BMP has no alpha; bake onto sky)
    for r in range(glow_r, 0, -1):
        t = r / glow_r
        c = tuple(int(SKY_TOP[i] * 0.0 + 0) for i in range(3))
        col = (
            int(lerp((255, 248, 225), lerp(SKY_TOP, SKY_BOT, sun_c[1] / h), t)[0]),
            int(lerp((255, 248, 225), lerp(SKY_TOP, SKY_BOT, sun_c[1] / h), t)[1]),
            int(lerp((255, 248, 225), lerp(SKY_TOP, SKY_BOT, sun_c[1] / h), t)[2]),
            int(90 * (1 - t)),
        )
        # cheap radial bake: draw concentric circles with decreasing alpha
        tmp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(tmp).ellipse(
            [sun_c[0] - r, sun_c[1] - r, sun_c[0] + r, sun_c[1] + r], fill=col
        )
        img.paste(Image.alpha_composite(img.convert("RGBA"), tmp).convert("RGB"), (0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse(
        [sun_c[0] - sun_r, sun_c[1] - sun_r, sun_c[0] + sun_r, sun_c[1] + sun_r],
        fill=SUN,
    )
    for pts, fill in hills:
        d.polygon(pts, fill=fill[:3])
    return img


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "agent", "deploy", "res"
    )
    os.makedirs(out, exist_ok=True)

    # header 150x57 — compact mark, no text (MUI draws the title beside it)
    h = sky(150, 57)
    scene(
        h,
        sun_c=(118, 20),
        sun_r=9,
        glow_r=20,
        hills=[
            ([(86, 57), (118, 30), (150, 57)], HILL_FAR),
            ([(100, 57), (132, 34), (164, 57)], HILL_NEAR),
        ],
    )
    h.save(os.path.join(out, "header.bmp"))

    # welcome 164x314 — tall panel + product name
    w = sky(164, 314)
    scene(
        w,
        sun_c=(82, 92),
        sun_r=22,
        glow_r=52,
        hills=[
            ([(-20, 314), (55, 190), (130, 314)], HILL_FAR),
            ([(40, 314), (115, 205), (200, 314)], HILL_NEAR),
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
