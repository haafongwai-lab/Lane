"""Rasterise the Lane app icon at every size Windows asks for.

The source is a square line drawing of the Lane robot on white paper. Each
frame is drawn from the tile geometry at its own resolution, which keeps
corners truly transparent - downsampling a 1024 master leaves stray alpha
levels in the corner arc that show up as a grey tick on a 16px taskbar icon.
Wireframe strokes almost vanish once a 1024px drawing becomes 16px, so the
smallest frames get a contrast stretch after downsampling.

Run: python desktop/make-icons.py
"""

from __future__ import annotations

import struct
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"
SOURCE = ASSETS / "icon-source.png"

# 96 is not a classic ICO size but Windows asks for it on a 200% DPI desktop,
# where the large-icon setting renders at 96px; without it the shell would
# downscale the 128 frame and the desktop icon would look soft.
SIZES = (16, 24, 32, 48, 64, 96, 128, 256)
RADIUS_RATIO = 0.18
# Supersample each frame, then area-average down: the arc stays clean at
# small sizes without the flat edges a single-pass GDI scale produces.
SS = 8

# How much of the canvas the tile occupies. Windows lays shortcuts on one
# grid, so a tile much below 90% reads as a visibly smaller icon than its
# neighbours; 0.86 was that case once the source's own white margin was
# cropped away. The transparent artwork now fills the tile itself.
TILE_RATIO = 0.92
# The small frames Windows shows in lists and the taskbar are already hard
# to read; a margin there costs the mark the pixels it needs. The shell
# draws 16/24/32 at their own sizes, so they keep a fuller tile.
SMALL_RATIO = {16: 1.0, 24: 0.98, 32: 0.96}
# A wireframe's thin grey strokes average into near-white at taskbar sizes.
# Stretching their distance from white by this much after downsampling keeps
# the mark readable without turning it into a solid black blob.
SMALL_STRETCH = 3
# How much of the tile the mark fills, keeping its own aspect ratio. Once the
# source's white margin is cropped away, the mark is drawn against a tile of
# its own and fills nearly all of it, so the icon reads at the same weight as
# its neighbours on the start menu.
MARK_RATIO = 0.96


def master() -> Image.Image:
    """The mark alone, cropped to its ink.

    The source carries its own white tile with a wide margin inside it
    (14% of the height above and below the mark, 5% at each side). Drawn
    as-is, that margin compounds with the frame's own: the mark ended up
    filling only ~73% of the icon's height, so Lane's shortcut looked
    smaller than every neighbour on the start menu. The white is dropped
    here and a tile is drawn at frame time instead, which puts the mark and
    the tile on separate terms.
    """
    source = Image.open(SOURCE).convert("RGBA")
    w, h = source.size
    px = source.load()

    def ink(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        return a > 8 and not (r > 245 and g > 245 and b > 245)

    xs = [x for x in range(w) if any(ink(x, y) for y in range(0, h, 4))]
    ys = [y for y in range(h) if any(ink(x, y) for x in range(0, w, 4))]
    if not xs or not ys:
        return source
    box = (xs[0], ys[0], xs[-1] + 1, ys[-1] + 1)
    return source.crop(box)


def stretch_contrast(image: Image.Image, factor: float) -> Image.Image:
    """Darken every grey stroke on the white tile, leaving the paper white.

    A linear stretch (rather than a threshold) keeps the wireframe's internal
    grid lines visible; thresholding at these sizes turns the robot into one
    solid black shape.
    """
    image = image.convert("RGBA")
    px = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = px[x, y]
            if a < 8:
                continue
            lum = (r * 299 + g * 587 + b * 114) // 1000
            v = max(0, min(255, round(255 - (255 - lum) * factor)))
            px[x, y] = (v, v, v, a)
    return image


def frame(art: Image.Image, size: int) -> Image.Image:
    """One icon frame: a rounded tile with the mark centred on it."""
    big = size * SS
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ratio = SMALL_RATIO.get(size, TILE_RATIO)
    side = round(big * ratio)
    inset = (big - side) // 2

    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    radius = round(side * RADIUS_RATIO)
    draw.rounded_rectangle(
        [inset, inset, inset + side - 1, inset + side - 1], radius=radius, fill=255
    )
    # The tile matches the app's own warm off-white surface, not pure white:
    # a #ffffff square reads as a pasted-on patch next to the other marks and
    # against the #fbfaf7 route canvas. The source artwork is transparent, so
    # this rounded tile is the only background the icon has.
    TILE = (251, 250, 247, 255)
    canvas.paste(Image.new("RGBA", (big, big), TILE), (0, 0), mask)

    # The mark keeps its aspect ratio inside the tile with a small inset of
    # its own, so a wide mark is not stretched to the tile's square.
    inner = round(side * MARK_RATIO)
    scale = min(inner / art.width, inner / art.height)
    mark = art.resize(
        (max(1, round(art.width * scale)), max(1, round(art.height * scale))),
        Image.LANCZOS,
    )
    canvas.alpha_composite(
        mark,
        (inset + (side - mark.width) // 2, inset + (side - mark.height) // 2)
    )
    # BOX is a plain area average: no negative lobes, so the corner arc
    # cannot smear a faint alpha tick into an otherwise transparent corner.
    small = canvas.resize((size, size), Image.BOX)
    return stretch_contrast(small, SMALL_STRETCH) if size in SMALL_RATIO else small


def write_ico(path: Path, frames: list[Image.Image]) -> None:
    """A PNG-in-ICO container; every current Windows reads it."""
    blobs = []
    for image in frames:
        from io import BytesIO

        buffer = BytesIO()
        image.save(buffer, format="PNG")
        blobs.append(buffer.getvalue())

    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = len(header) + 16 * len(blobs)
    entries = b""
    for image, blob in zip(frames, blobs):
        side = image.width
        entries += struct.pack(
            "<BBBBHHII",
            0 if side >= 256 else side,
            0 if side >= 256 else side,
            0,
            0,
            1,
            32,
            len(blob),
            offset,
        )
        offset += len(blob)
    path.write_bytes(header + entries + b"".join(blobs))


def main() -> None:
    art = master()
    frames = {size: frame(art, size) for size in SIZES}

    for size, image in frames.items():
        image.save(ASSETS / f"lane-{size}.png", optimize=True)

    write_ico(ASSETS / "lane.ico", [frames[s] for s in SIZES])
    # The tray shows 16/24/32 only; shipping those keeps the file small.
    write_ico(ASSETS / "tray.ico", [frames[s] for s in (16, 24, 32)])
    print(f"Wrote {len(SIZES)} frames + lane.ico + tray.ico to {ASSETS}")


if __name__ == "__main__":
    main()
