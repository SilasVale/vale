#!/usr/bin/env python3
"""Render the Vale brand mark (gateway/public/favicon.svg) into PNG + ICO.

The brand logo is the "vale at sunrise" mark: amber sky gradient, glowing
sun over the pass, near hill + far ridge in white, glass sheen. This script
is the single source for desktop/installer icons so every surface shows the
same mark as ai.saisi.online.

Usage:
  render-brand-icon.py [out_dir]
"""
import math
import os
import sys
from PIL import Image

# --- SVG spec (from gateway/public/favicon.svg, viewBox 0 0 48 48) ---
SKY_TOP = (0xF5, 0x9F, 0x00)
SKY_BOT = (0xE8, 0x59, 0x0C)
GLOW_C = (21.0, 14.0)
GLOW_R = 7.5
GLOW_COLOR = (0xFF, 0xF8, 0xE1)
GLOW_OP = 0.55
SUN_C = (21.0, 14.0)
SUN_R = 4.0
FAR = ((14, 41), (26, 16), (44, 41))   # white 0.78
NEAR = ((2, 41), (12, 20), (24, 41))   # white 1.0
SHEEN_TOP = (0.25, 0xFF, 0xFF, 0xFF)   # white .25 at top
SHEEN_BOT = (0.10, 0x7C, 0x2D, 0x12)   # #7c2d12 .10 at bottom
CORNER_R = 11


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def quad_pt(p0, p1, p2, t):
    return ((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
            (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1])


def render(size):
    sc = size / 48.0
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    r = CORNER_R
    # rounded-rect background + sky gradient
    for y in range(size):
        for x in range(size):
            xx, yy = x / sc, y / sc
            in_corner = False
            if xx < r and yy < r:
                in_corner = (r - xx) ** 2 + (r - yy) ** 2 > r * r
            elif xx > 48 - r and yy < r:
                in_corner = (xx - (48 - r)) ** 2 + (r - yy) ** 2 > r * r
            elif xx < r and yy > 48 - r:
                in_corner = (r - xx) ** 2 + (yy - (48 - r)) ** 2 > r * r
            elif xx > 48 - r and yy > 48 - r:
                in_corner = (xx - (48 - r)) ** 2 + (yy - (48 - r)) ** 2 > r * r
            if in_corner:
                px[x, y] = (0, 0, 0, 0)
                continue
            t = yy / 48.0
            px[x, y] = lerp(SKY_TOP, SKY_BOT, t) + (255,)
    # radial glow
    for y in range(size):
        for x in range(size):
            d = ((x / sc - GLOW_C[0]) ** 2 + (y / sc - GLOW_C[1]) ** 2) ** 0.5
            if d <= GLOW_R:
                t = d / GLOW_R
                a = int(255 * (1 - t) * GLOW_OP)
                if a > 0:
                    r_, g_, b_, a_ = px[x, y]
                    px[x, y] = (
                        int(r_ * (255 - a) / 255 + GLOW_COLOR[0] * a / 255),
                        int(g_ * (255 - a) / 255 + GLOW_COLOR[1] * a / 255),
                        int(b_ * (255 - a) / 255 + GLOW_COLOR[2] * a / 255), a_)
    # sun core
    for y in range(size):
        for x in range(size):
            d = ((x / sc - SUN_C[0]) ** 2 + (y / sc - SUN_C[1]) ** 2) ** 0.5
            if d <= SUN_R:
                px[x, y] = (0xFF, 0xF8, 0xE1, 255)

    def fill_ridge(p0, p1, p2, color, opacity):
        y0, y1, y2 = p0[1], p1[1], p2[1]
        a = y0 - 2 * y1 + y2
        b = 2 * (y1 - y0)
        c = y0
        alpha = int(255 * opacity)
        for yv in range(int(min(y0, y1, y2)), 48):
            ts = []
            if abs(a) < 1e-9:
                if abs(b) > 1e-9:
                    t = (yv - c) / b
                    if 0 <= t <= 1:
                        ts.append(t)
            else:
                disc = b * b - 4 * a * (c - yv)
                if disc >= 0:
                    sq = math.sqrt(disc)
                    for t in ((-b + sq) / (2 * a), (-b - sq) / (2 * a)):
                        if 0 <= t <= 1:
                            ts.append(t)
            if len(ts) < 2:
                continue
            xs = [quad_pt(p0, p1, p2, t)[0] for t in ts]
            xmin, xmax = min(xs), max(xs)
            py = int(yv * sc)
            x0 = max(0, int(xmin * sc))
            x1 = min(size - 1, int(xmax * sc))
            for x in range(x0, x1 + 1):
                r_, g_, b_, a_ = px[x, py]
                px[x, py] = (
                    int(r_ * (255 - alpha) / 255 + color[0] * alpha / 255),
                    int(g_ * (255 - alpha) / 255 + color[1] * alpha / 255),
                    int(b_ * (255 - alpha) / 255 + color[2] * alpha / 255), a_)

    fill_ridge(FAR[0], FAR[1], FAR[2], (255, 255, 255), 0.78)
    fill_ridge(NEAR[0], NEAR[1], NEAR[2], (255, 255, 255), 1.0)

    # glass sheen: white .25 at top fading out by 45%, then #7c2d12 .10
    # fading in from 45% to bottom
    for y in range(size):
        t = y / (size - 1)
        for x in range(size):
            r_, g_, b_, a_ = px[x, y]
            if a_ == 0:
                continue
            if t < 0.45:
                a = int(255 * 0.25 * (1 - t / 0.45))
                if a > 0:
                    px[x, y] = (
                        int(r_ * (255 - a) / 255 + 255 * a / 255),
                        int(g_ * (255 - a) / 255 + 255 * a / 255),
                        int(b_ * (255 - a) / 255 + 255 * a / 255), a_)
            else:
                a = int(255 * 0.10 * (t - 0.45) / 0.55)
                if a > 0:
                    px[x, y] = (
                        int(r_ * (255 - a) / 255 + 0x7C * a / 255),
                        int(g_ * (255 - a) / 255 + 0x2D * a / 255),
                        int(b_ * (255 - a) / 255 + 0x12 * a / 255), a_)
    return img


def render_aa(size, ss=4):
    """Supersampled render: draw at size*ss then downscale (LANCZOS).

    The base render() sets hard pixels (no AA) — fine at 128+, but at
    16/32/48 the thin white ridges collapse into mush while the in-app
    SVG (browser-rasterized, anti-aliased) stays crisp. Supersampling
    approximates the browser look so the .ico small entries read as the
    same mark (device-caught: 16px entry was an unreadable blob)."""
    big = render(size * ss)
    return big.resize((size, size), Image.LANCZOS)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    png128 = render(128)
    png128.save(os.path.join(out, "icon.png"))
    frames = {
        256: render(256),
        48: render_aa(48),
        32: render_aa(32),
        16: render_aa(16),
    }
    base = frames[256]
    base.save(
        os.path.join(out, "icon.ico"),
        format="ICO",
        append_images=[frames[16], frames[32], frames[48]],
    )
    print(f"rendered {out}/icon.png (128) + {out}/icon.ico (256/48/32/16, small entries AA)")


if __name__ == "__main__":
    main()
