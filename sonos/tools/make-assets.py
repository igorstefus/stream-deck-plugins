"""Generates the Sonos plugin's static PNG icons (1x and 2x): plugin icon, category icon, action-list
icons and the default key images. Key images are replaced at runtime by the plugin's SVG renderer.

Usage: python tools/make-assets.py   (from the sonos/ folder; needs Pillow)
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

PLUGIN = Path(__file__).resolve().parent.parent / "com.igorstefus.sonos.sdPlugin"

TILE = (28, 28, 30, 255)
LIGHT = (242, 242, 242, 255)
GREY = (160, 160, 165, 255)
ACCENT = (217, 164, 65, 255)
SCALE = 8


def canvas(size: int, background: bool) -> tuple[Image.Image, ImageDraw.ImageDraw, int]:
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if background:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s * 0.14, fill=TILE)
    return img, d, s


def save(img: Image.Image, size: int, name: str) -> None:
    out = img.resize((size, size), Image.LANCZOS)
    path = PLUGIN / name
    path.parent.mkdir(parents=True, exist_ok=True)
    out.save(path)


# Glyphs are drawn inside a square box (x0, y0, w) with the given colour.


def speaker(d: ImageDraw.ImageDraw, x0: float, y0: float, w: float, color, line: float) -> None:
    bw, bh = w * 0.6, w * 0.9
    bx = x0 + (w - bw) / 2
    by = y0 + (w - bh) / 2
    d.rounded_rectangle((bx, by, bx + bw, by + bh), radius=w * 0.08, outline=color, width=int(line))
    cx, cy = x0 + w / 2, by + bh * 0.66
    d.ellipse((cx - w * 0.16, cy - w * 0.16, cx + w * 0.16, cy + w * 0.16), outline=color, width=int(line))
    ty = by + bh * 0.22
    d.ellipse((cx - w * 0.05, ty - w * 0.05, cx + w * 0.05, ty + w * 0.05), fill=color)


def play_pause(d: ImageDraw.ImageDraw, x0: float, y0: float, w: float, color) -> None:
    d.polygon([(x0 + w * 0.08, y0 + w * 0.12), (x0 + w * 0.52, y0 + w * 0.5), (x0 + w * 0.08, y0 + w * 0.88)], fill=color)
    d.rounded_rectangle((x0 + w * 0.62, y0 + w * 0.12, x0 + w * 0.74, y0 + w * 0.88), radius=w * 0.03, fill=color)
    d.rounded_rectangle((x0 + w * 0.82, y0 + w * 0.12, x0 + w * 0.94, y0 + w * 0.88), radius=w * 0.03, fill=color)


def link(d: ImageDraw.ImageDraw, x0: float, y0: float, w: float, color, line: float) -> None:
    r = w * 0.2
    lw = int(line)
    # Two interlocking rings on a diagonal.
    c1 = (x0 + w * 0.36, y0 + w * 0.62)
    c2 = (x0 + w * 0.64, y0 + w * 0.38)
    for cx, cy in (c1, c2):
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=lw)
    d.line([(c1[0] + r * 0.45, c1[1] - r * 0.45), (c2[0] - r * 0.45, c2[1] + r * 0.45)], fill=color, width=lw)


def unlink(d: ImageDraw.ImageDraw, x0: float, y0: float, w: float, color, line: float) -> None:
    r = w * 0.2
    lw = int(line)
    # Two rings pulled apart, with a gap between them.
    c1 = (x0 + w * 0.28, y0 + w * 0.7)
    c2 = (x0 + w * 0.72, y0 + w * 0.3)
    for cx, cy in (c1, c2):
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=lw)
    d.line([(x0 + w * 0.44, y0 + w * 0.56), (x0 + w * 0.56, y0 + w * 0.44)], fill=color, width=lw)


def volume(d: ImageDraw.ImageDraw, x0: float, y0: float, w: float, color, line: float) -> None:
    d.polygon(
        [
            (x0 + w * 0.1, y0 + w * 0.38),
            (x0 + w * 0.3, y0 + w * 0.38),
            (x0 + w * 0.52, y0 + w * 0.18),
            (x0 + w * 0.52, y0 + w * 0.82),
            (x0 + w * 0.3, y0 + w * 0.62),
            (x0 + w * 0.1, y0 + w * 0.62),
        ],
        fill=color,
    )
    lw = int(line)
    cx, cy = x0 + w * 0.52, y0 + w * 0.5
    for radius in (w * 0.18, w * 0.32):
        d.arc((cx - radius, cy - radius, cx + radius, cy + radius), start=-45, end=45, fill=color, width=lw)


def make(name: str, size: int, draw, background: bool) -> None:
    for factor, suffix in ((1, ""), (2, "@2x")):
        img, d, s = canvas(size, background)
        draw(d, s)
        save(img, size * factor, f"{name}{suffix}.png")


def main() -> None:
    # Plugin icon (288 / 576) and category icon (28 / 56): speaker on a tile.
    make("imgs/plugin/icon", 288, lambda d, s: speaker(d, s * 0.15, s * 0.15, s * 0.7, ACCENT, s * 0.035), True)
    make("imgs/plugin/category-icon", 28, lambda d, s: speaker(d, s * 0.05, s * 0.05, s * 0.9, LIGHT, s * 0.08), False)

    # Action-list icons (20 / 40), no background.
    make("imgs/actions/playback", 20, lambda d, s: play_pause(d, s * 0.05, s * 0.05, s * 0.9, LIGHT), False)
    make("imgs/actions/group", 20, lambda d, s: link(d, s * 0.02, s * 0.02, s * 0.96, LIGHT, s * 0.1), False)
    make("imgs/actions/ungroup", 20, lambda d, s: unlink(d, s * 0.02, s * 0.02, s * 0.96, LIGHT, s * 0.1), False)
    make("imgs/actions/volume", 20, lambda d, s: volume(d, s * 0.02, s * 0.02, s * 0.96, LIGHT, s * 0.1), False)

    # Default key images (72 / 144), shown until the plugin renders a live one.
    make("imgs/actions/playback-key", 72, lambda d, s: play_pause(d, s * 0.25, s * 0.25, s * 0.5, LIGHT), True)
    make("imgs/actions/group-key", 72, lambda d, s: link(d, s * 0.22, s * 0.22, s * 0.56, LIGHT, s * 0.05), True)
    make("imgs/actions/ungroup-key", 72, lambda d, s: unlink(d, s * 0.22, s * 0.22, s * 0.56, LIGHT, s * 0.05), True)
    make("imgs/actions/volume-key", 72, lambda d, s: volume(d, s * 0.22, s * 0.22, s * 0.56, LIGHT, s * 0.05), True)
    print("assets written to", PLUGIN)


if __name__ == "__main__":
    main()
