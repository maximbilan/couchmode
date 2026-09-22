#!/usr/bin/env python3
"""
Generates the Fire TV launcher icon and home-screen banner.

    python3 tools/make-artwork.py

Artwork is kept as a generator rather than opaque binaries so the result is
reviewable in a diff and regenerable when the palette moves. There is no
drawing library here — this writes raw RGBA through zlib into a PNG by hand.

The mark is a couch rasterised onto a character-cell grid, each live cell
painted as one filled cell, so the silhouette is built out of terminal cells
the way ASCII art is built out of glyphs. Literal punctuation glyphs were
tried first and turn to mesh below ~96px; filled cells hold the silhouette
all the way down to mdpi.

The banner keeps the couch inside a terminal window. The launcher icon does
not: Fire TV crops a sideloaded app's icon into a square slot on its own grey
plate, so the icon is the couch on that same grey and the tile reads as one
surface. See icon() for the full reasoning.

The chrome dots are drawn at 4x and box-downsampled with premultiplied alpha.
The cell grid is laid out on whole pixels at every density, so it stays crisp
rather than blurring.
"""
import struct
import zlib
from pathlib import Path

SS = 4  # supersample factor for the smooth shapes

# Palette mirrors packages/web/src/tv/tv.css.
BODY = (0x10, 0x14, 0x1A, 0xFF)
CHROME = (0x17, 0x1D, 0x25, 0xFF)
LINE = (0x28, 0x31, 0x3D, 0xFF)
TEXT = (0xF2, 0xF6, 0xFA, 0xFF)
MUTED = (0x93, 0xA4, 0xB8, 0xFF)
FOCUS = (0xFF, 0xD1, 0x66, 0xFF)
DANGER = (0xFF, 0x6B, 0x6B, 0xFF)
OK = (0x6B, 0xE0, 0xA0, 0xFF)
# The grey Fire TV paints behind a sideloaded app's home-screen tile, sampled
# off the device. The icon uses it as its own background so the square slot
# blends into the plate instead of sitting on it as a visible letterbox.
PLATE = (0x5A, 0x5A, 0x5A, 0xFF)

# The couch, in fractions of its own box: backrest, two arms standing proud of
# the seat, the seat itself, then two stub legs. The gaps between these rects
# are what make it read as a couch rather than a bench — a seam under the
# backrest, and the arms breaking the seat's outline at both ends.
COUCH = [
    (0.10, 0.00, 0.90, 0.38),  # backrest
    (0.00, 0.34, 0.16, 0.82),  # left arm
    (0.84, 0.34, 1.00, 0.82),  # right arm
    (0.20, 0.46, 0.80, 0.82),  # seat
    (0.12, 0.82, 0.26, 1.00),  # left leg
    (0.74, 0.82, 0.88, 1.00),  # right leg
]
COLS, ROWS = 17, 12  # character-cell grid the couch is rasterised onto

# 5x7 glyphs, one string per row, for just the letters the wordmark needs.
FONT = {
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    " ": ["00000"] * 7,
}
GLYPH_W = 5  # glyphs are 5x7; only the advance width is needed for layout


class Canvas:
    def __init__(self, width, height, fill=(0, 0, 0, 0)):
        self.w = width
        self.h = height
        self.px = [list(fill) for _ in range(width * height)]

    def rect(self, x0, y0, x1, y1, colour):
        for y in range(max(0, int(y0)), min(self.h, int(y1))):
            for x in range(max(0, int(x0)), min(self.w, int(x1))):
                self.px[y * self.w + x] = list(colour)

    def disc(self, cx, cy, radius, colour):
        for y in range(max(0, int(cy - radius - 1)), min(self.h, int(cy + radius + 2))):
            for x in range(max(0, int(cx - radius - 1)), min(self.w, int(cx + radius + 2))):
                if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius * radius:
                    self.px[y * self.w + x] = list(colour)

    def over(self, other):
        """Composite another canvas of the same size on top, honouring alpha."""
        for i, p in enumerate(other.px):
            if p[3]:
                self.px[i] = p

    def text(self, x, y, value, colour, scale=1, tracking=1):
        cursor = x
        for character in value.upper():
            glyph = FONT.get(character)
            if glyph is None:
                cursor += (GLYPH_W + tracking) * scale
                continue
            for row, bits in enumerate(glyph):
                for col, bit in enumerate(bits):
                    if bit != "1":
                        continue
                    self.rect(
                        cursor + col * scale,
                        y + row * scale,
                        cursor + (col + 1) * scale,
                        y + (row + 1) * scale,
                        colour,
                    )
            cursor += (GLYPH_W + tracking) * scale
        return cursor

    def downsample(self, factor):
        out = Canvas(self.w // factor, self.h // factor)
        for y in range(out.h):
            for x in range(out.w):
                ar = ag = ab = aa = 0
                for j in range(factor):
                    row = (y * factor + j) * self.w
                    for i in range(factor):
                        r, g, b, a = self.px[row + x * factor + i]
                        ar += r * a
                        ag += g * a
                        ab += b * a
                        aa += a
                if aa == 0:
                    out.px[y * out.w + x] = [0, 0, 0, 0]
                else:
                    out.px[y * out.w + x] = [
                        round(ar / aa), round(ag / aa), round(ab / aa),
                        round(aa / (factor * factor)),
                    ]
        return out

    def write(self, path):
        raw = bytearray()
        for y in range(self.h):
            raw.append(0)  # filter type 0
            for x in range(self.w):
                raw.extend(self.px[y * self.w + x])

        def chunk(tag, data):
            return (
                struct.pack(">I", len(data))
                + tag
                + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
            )

        png = b"\x89PNG\r\n\x1a\n"
        png += chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 6, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        png += chunk(b"IEND", b"")
        Path(path).write_bytes(png)
        return len(png)


def couch_cells(cols=COLS, rows=ROWS):
    """Rasterise the couch onto a cols x rows grid of character cells."""
    live = set()
    for x0, y0, x1, y1 in COUCH:
        for row in range(rows):
            for col in range(cols):
                cx, cy = (col + 0.5) / cols, (row + 0.5) / rows
                if x0 <= cx <= x1 and y0 <= cy <= y1:
                    live.add((col, row))
    return live


CELLS = couch_cells()


def draw_couch(canvas, x, y, cell, gutter):
    """Paint the couch at whole-pixel positions, scaled up by SS."""
    size = max(1, cell - gutter)
    for col, row in CELLS:
        px, py = (x + col * cell) * SS, (y + row * cell) * SS
        canvas.rect(px, py, px + size * SS, py + size * SS, FOCUS)


def chrome_bar(canvas, width, height, dot_r, dots=True):
    """Terminal title bar with its traffic-light dots."""
    top = Canvas(canvas.w, canvas.h)
    top.rect(0, 0, width, canvas.h, CHROME)
    for y in range(height, canvas.h):
        for x in range(width):
            top.px[y * canvas.w + x] = [0, 0, 0, 0]
    canvas.over(top)
    canvas.rect(0, height - SS, width, height, LINE)
    if not dots:
        return
    gap = dot_r * 2.75
    cx = dot_r * 3.6
    for i, colour in enumerate((DANGER, FOCUS, OK)):
        canvas.disc(cx + i * gap, height / 2, dot_r, colour)


def icon(path, size):
    """Launcher icon: the couch alone, on transparency.

    Fire TV renders a sideloaded app's home tile as a square slot on its own
    grey plate, and nothing in the APK widens that slot — the shape is Amazon's
    deliberate marker for apps that did not come from the Appstore, whose tile
    art it downloads by package name instead.

    Transparency does not help: the launcher composites the icon over black,
    not over the plate. So the icon paints PLATE itself, and the seam between
    slot and plate disappears — the tile reads as one grey surface with a
    yellow couch on it. This is a colour match, so it depends on Amazon not
    changing that grey; PLATE is the single place to update if they do.
    """
    canvas = Canvas(size * SS, size * SS)
    canvas.rect(0, 0, size * SS, size * SS, PLATE)
    cell = 1
    while COLS * (cell + 1) <= size * 0.84 and ROWS * (cell + 1) <= size * 0.80:
        cell += 1
    # Gutters between cells need a whole pixel to survive; below that the cells
    # merge into a solid silhouette, which is what small densities want anyway.
    gutter = 1 if cell >= 4 else 0
    x = round((size - COLS * cell) / 2)
    y = round((size - ROWS * cell) / 2)
    draw_couch(canvas, x, y, cell, gutter)
    return canvas.downsample(SS).write(path)


def adaptive_foreground(path, size):
    """Foreground layer for the adaptive icon: the couch on transparency.

    An adaptive icon is a 108dp canvas whose outer ring is masked away; only
    the centre 72dp is guaranteed visible. The couch is sized to sit inside
    that safe zone so no mask can clip it.
    """
    canvas = Canvas(size * SS, size * SS)
    safe = size * 72 / 108
    cell = 1
    while COLS * (cell + 1) <= safe * 0.92 and ROWS * (cell + 1) <= safe * 0.92:
        cell += 1
    gutter = 1 if cell >= 4 else 0
    x = round((size - COLS * cell) / 2)
    y = round((size - ROWS * cell) / 2)
    draw_couch(canvas, x, y, cell, gutter)
    return canvas.downsample(SS).write(path)


def banner(path, width=320, height=180):
    """Fire TV wants a 320x180 banner, drawn full-bleed with no rounding."""
    canvas = Canvas(width * SS, height * SS, BODY)

    bar = 30 * SS
    chrome_bar(canvas, width * SS, bar, 5 * SS)

    cell, gutter = 6, 1
    art_w, art_h = COLS * cell, ROWS * cell
    x = 20
    y = round(bar / SS + ((height - bar / SS) - art_h) / 2)
    draw_couch(canvas, x, y, cell, gutter)

    word, scale = "COUCHMODE", 3
    tag, tag_scale = "ACP ON TV", 2
    left = (x + art_w + 20) * SS
    canvas.text(left, (y + 18) * SS, word, TEXT, scale * SS)
    canvas.text(left, (y + 44) * SS, tag, MUTED, tag_scale * SS)
    return canvas.downsample(SS).write(path)


if __name__ == "__main__":
    res = Path(__file__).resolve().parent.parent / "app" / "src" / "main" / "res"
    (res / "drawable-nodpi").mkdir(parents=True, exist_ok=True)
    print("banner.png", banner(res / "drawable-nodpi" / "banner.png"), "bytes")
    for density, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144)):
        folder = res / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        print(f"ic_launcher {density}", icon(folder / "ic_launcher.png", size), "bytes")
    # Adaptive icon foreground: 108dp at each density.
    for density, size in (("mdpi", 108), ("hdpi", 162), ("xhdpi", 216), ("xxhdpi", 324)):
        folder = res / f"mipmap-{density}"
        print(
            f"ic_launcher_foreground {density}",
            adaptive_foreground(folder / "ic_launcher_foreground.png", size),
            "bytes",
        )
