"""Generate the iOS app icon + splash screen.

Why a script and not a hand-drawn PNG: the icon needs to be regenerated
any time we tweak colors, and Apple is finicky about exact dimensions
(1024x1024, no transparency, no rounded corners — iOS rounds them).
A reproducible script means we can iterate on the design without
losing the master.

Run with: python3 mobile/scripts/generate_assets.py
"""
from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets"
OUT.mkdir(exist_ok=True)

# Palette — matches src/theme.ts so the launcher and the in-app
# surfaces feel like the same thing on screen.
BG_DARK = (14, 15, 18)       # colors.bg
SURFACE = (29, 32, 39)       # colors.surfaceElevated
TUSK_GOLD = (201, 168, 106)  # colors.accent
GOLD_BRIGHT = (228, 198, 134)
INK = (243, 244, 246)        # colors.text


def _radial_bg(size: int, inner: tuple, outer: tuple) -> Image.Image:
    """Subtle vignette so the icon doesn't read flat at 60×60 on a
    home screen. Center is slightly lifted, edges fall off to the
    backdrop tone — same trick most modern app icons use to avoid
    the "stamped on a flat square" look at small sizes.
    """
    img = Image.new("RGB", (size, size), outer)
    px = img.load()
    cx = cy = size / 2
    max_d = math.sqrt(cx * cx + cy * cy)
    for y in range(size):
        for x in range(size):
            d = math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / max_d
            t = max(0.0, 1.0 - d * 1.4)
            r = int(outer[0] + (inner[0] - outer[0]) * t)
            g = int(outer[1] + (inner[1] - outer[1]) * t)
            b = int(outer[2] + (inner[2] - outer[2]) * t)
            px[x, y] = (r, g, b)
    return img


def _tusk_path(size: int):
    """A stylized tusk curve — two concentric arcs converging to a
    point, evoking an elephant tusk. Coordinates are in icon space
    (size×size); shifted/rotated by the caller for placement.

    Returns a list of (x, y) tuples forming a closed polygon.
    """
    s = size
    # Anchor points: tusk curls from upper-right to lower-left, fat
    # at the top, tapering to a point. Adjust these to reshape.
    points = []
    n = 60
    # Outer curve (the back / fat side).
    for i in range(n + 1):
        t = i / n
        # Bezier-ish: straight along x, curved along y, with the
        # width shrinking as t → 1.
        x = s * (0.18 + 0.62 * t)
        y = s * (0.22 + 0.50 * t * t)
        width = s * (0.18 * (1 - t) ** 1.4)
        # Outer side (top of tusk)
        points.append((x, y - width / 2))
    # Inner curve (the belly / thin side) — walk back the other way.
    for i in range(n + 1):
        t = 1 - i / n
        x = s * (0.18 + 0.62 * t)
        y = s * (0.22 + 0.50 * t * t)
        width = s * (0.18 * (1 - t) ** 1.4)
        points.append((x, y + width / 2))
    return points


def make_icon(size: int = 1024) -> Image.Image:
    """The 1024×1024 master icon. iOS auto-generates smaller sizes."""
    img = _radial_bg(size, SURFACE, BG_DARK)
    draw = ImageDraw.Draw(img, "RGBA")

    # Draw the gold tusk shape, with a darker shadow underneath for
    # depth. Both are rendered with antialiasing via the polygon
    # primitive (no extra anti-alias step needed — PIL handles it
    # at draw-time on RGBA).
    pts = _tusk_path(size)
    # Shadow — offset down-right, semi-transparent black.
    shadow = [(x + size * 0.012, y + size * 0.018) for (x, y) in pts]
    draw.polygon(shadow, fill=(0, 0, 0, 90))

    # Tusk body — solid gold, with a brighter highlight near the top.
    draw.polygon(pts, fill=TUSK_GOLD + (255,))

    # Highlight stripe along the top edge of the tusk for the "polished
    # ivory" feel. Offset the outer curve slightly inward and draw a
    # thin lighter polygon on top.
    n = len(pts) // 2
    top = pts[: n + 1]
    inner_top = []
    for (x, y), (xb, yb) in zip(top, pts[-1:-(n + 2):-1]):
        # interpolate 25% from outer toward inner
        inner_top.append((x + (xb - x) * 0.18, y + (yb - y) * 0.18))
    highlight = top + list(reversed(inner_top))
    draw.polygon(highlight, fill=GOLD_BRIGHT + (180,))

    # Wordmark "TL" in the lower-left corner. Drawn as two heavy bars
    # because shipping a font dependency for one icon is overkill —
    # geometric primitives render identically across systems.
    bar_w = int(size * 0.022)
    bar_color = INK + (255,)
    # T
    cx = int(size * 0.16)
    cy = int(size * 0.78)
    draw.rectangle([cx, cy, cx + int(size * 0.10), cy + bar_w], fill=bar_color)
    draw.rectangle([cx + int(size * 0.045), cy, cx + int(size * 0.055), cy + int(size * 0.12)], fill=bar_color)
    # L
    lx = int(size * 0.30)
    draw.rectangle([lx, cy, lx + bar_w, cy + int(size * 0.12)], fill=bar_color)
    draw.rectangle([lx, cy + int(size * 0.12) - bar_w, lx + int(size * 0.08), cy + int(size * 0.12)], fill=bar_color)

    return img


def make_splash(width: int = 1242, height: int = 2688) -> Image.Image:
    """Splash screen — same backdrop, tusk centered, no wordmark.

    Sized for the iPhone 14 Pro Max viewport. Expo's splash plugin
    scales for other devices automatically using the contentFit option.
    """
    img = _radial_bg(max(width, height), SURFACE, BG_DARK).resize((width, height))
    # Place the icon glyph centered, scaled to ~1/3 of the shorter side.
    glyph_size = min(width, height) // 3 * 2
    glyph = make_icon(glyph_size)
    cx = (width - glyph_size) // 2
    cy = (height - glyph_size) // 2
    img.paste(glyph, (cx, cy))
    return img


def main() -> None:
    icon = make_icon(1024)
    icon.save(OUT / "icon.png", "PNG", optimize=True)
    print(f"wrote {OUT/'icon.png'}")

    # adaptive-icon for Android — same art, used for the background layer.
    icon.save(OUT / "adaptive-icon.png", "PNG", optimize=True)
    print(f"wrote {OUT/'adaptive-icon.png'}")

    # Splash. Keep it modestly sized — Expo Image will scale up.
    splash = make_splash(1242, 2688)
    splash.save(OUT / "splash.png", "PNG", optimize=True)
    print(f"wrote {OUT/'splash.png'}")

    # Favicon for the (rare) web build path.
    fav = make_icon(48)
    fav.save(OUT / "favicon.png", "PNG", optimize=True)
    print(f"wrote {OUT/'favicon.png'}")


if __name__ == "__main__":
    main()
