#!/usr/bin/env python3
"""
Generates the Fire TV home-screen banner and the launcher icon.

Placeholder artwork, kept as a generator rather than opaque binaries so the
result is reviewable in a diff and regenerable when the palette changes.

    python3 tools/make-banner.py

Fire TV wants a 320x180 banner. There is no drawing library here, so this
writes raw RGBA and a 5x7 bitmap font through zlib into a PNG by hand.
"""
import struct
import zlib
from pathlib import Path

# Palette mirrors packages/web/src/tv/tv.css.
BG = (0x07, 0x09, 0x0C, 0xFF)
PANEL = (0x17, 0x1D, 0x25, 0xFF)
TEXT = (0xF2, 0xF6, 0xFA, 0xFF)
MUTED = (0x93, 0xA4, 0xB8, 0xFF)
FOCUS = (0xFF, 0xD1, 0x66, 0xFF)

# 5x7 glyphs, one string per row, for just the letters the wordmark needs.
FONT = {
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    " ": ["00000"] * 7,
}


class Canvas:
    def __init__(self, width, height, fill):
        self.w = width
        self.h = height
        self.px = [list(fill) for _ in range(width * height)]

    def rect(self, x0, y0, x1, y1, colour):
        for y in range(max(0, y0), min(self.h, y1)):
            for x in range(max(0, x0), min(self.w, x1)):
                self.px[y * self.w + x] = list(colour)

    def outline(self, x0, y0, x1, y1, colour, weight=1):
        self.rect(x0, y0, x1, y0 + weight, colour)
        self.rect(x0, y1 - weight, x1, y1, colour)
        self.rect(x0, y0, x0 + weight, y1, colour)
        self.rect(x1 - weight, y0, x1, y1, colour)

    def text(self, x, y, value, colour, scale=1, spacing=1):
        cursor = x
        for character in value.upper():
            glyph = FONT.get(character)
            if glyph is None:
                cursor += (5 + spacing) * scale
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
            cursor += (len(glyph[0]) + spacing) * scale
        return cursor

    def width_of(self, value, scale=1, spacing=1):
        return sum((len(FONT.get(c, ["00000"])[0]) + spacing) * scale for c in value.upper())

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


def banner(path):
    c = Canvas(320, 180, BG)
    # A screen, with the focus ring the whole UI is built around.
    c.rect(28, 30, 292, 126, PANEL)
    c.outline(28, 30, 292, 126, FOCUS, 3)
    word = "COUCHMODE"
    scale = 4
    c.text((320 - c.width_of(word, scale)) // 2, 58, word, TEXT, scale)
    tagline = "TV"
    c.text((320 - c.width_of(tagline, 2)) // 2, 96, tagline, MUTED, 2)
    # Stand.
    c.rect(148, 126, 172, 140, PANEL)
    c.rect(112, 140, 208, 146, PANEL)
    return c.write(path)


def icon(path, size):
    c = Canvas(size, size, BG)
    inset = size // 8
    c.rect(inset, inset, size - inset, size - inset, PANEL)
    c.outline(inset, inset, size - inset, size - inset, FOCUS, max(2, size // 24))
    scale = max(1, size // 16)
    c.text((size - c.width_of("CM", scale)) // 2, (size - 7 * scale) // 2, "CM", TEXT, scale)
    return c.write(path)


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent / "app" / "src" / "main" / "res"
    (root / "drawable-nodpi").mkdir(parents=True, exist_ok=True)
    print("banner.png", banner(root / "drawable-nodpi" / "banner.png"), "bytes")
    for density, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144)):
        folder = root / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        print(f"ic_launcher {density}", icon(folder / "ic_launcher.png", size), "bytes")
