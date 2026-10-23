"""Rasterise the Lane app icon at every size Windows asks for.

The source is the illustration on a white rounded tile. Drawing each frame
from the tile geometry at its own resolution keeps corners truly
transparent — downsampling a 1024 master leaves a few stray alpha levels in
the corner arc that show up as a grey tick on a 16px taskbar icon.

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


def master() -> Image.Image:
    """The 1024 artwork on a transparent canvas, cropped to its ink."""
    source = Image.open(SOURCE).convert("RGBA")
    box = source.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    return source.crop(box)


def frame(art: Image.Image, size: int) -> Image.Image:
    """One icon frame, drawn at size*SS and averaged down."""
    big = size * SS
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    radius = round(big * RADIUS_RATIO)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=255)
    canvas.paste(Image.new("RGBA", (big, big), (255, 255, 255, 255)), (0, 0), mask)

    scaled = art.resize((big, big), Image.LANCZOS)
    canvas.alpha_composite(scaled)
    # BOX is a plain area average: no negative lobes, so the corner arc
    # cannot smear a faint alpha tick into an otherwise transparent corner.
    return canvas.resize((size, size), Image.BOX)


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
