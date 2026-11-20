#!/usr/bin/env python3
"""Generate the DuoSub Desktop app/icon assets from scratch (no external art needed)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "desktop" / "src-tauri" / "icons"
SIZE = 1024

# Background gradient
bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
pixels = bg.load()
for y in range(SIZE):
    t = y / SIZE
    r = int(14 + t * 18)
    g = int(24 + t * 40)
    b = int(36 + t * 44)
    for x in range(SIZE):
        pixels[x, y] = (r, g, b, 255)
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=230, fill=255)
bg.putalpha(mask)

draw = ImageDraw.Draw(bg)
# Accent ring
draw.rounded_rectangle([70, 70, SIZE - 70, SIZE - 70], radius=190, outline=(110, 231, 200, 220), width=18)
# Letter D
font = None
for candidate in [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
]:
    try:
        font = ImageFont.truetype(candidate, 620)
        break
    except OSError:
        continue
if font is None:
    font = ImageFont.load_default()
text = "D"
box = draw.textbbox((0, 0), text, font=font)
w, h = box[2] - box[0], box[3] - box[1]
draw.text(((SIZE - w) / 2 - box[0], (SIZE - h) / 2 - box[1] - 20), text, font=font, fill=(110, 231, 200, 255))

OUT.mkdir(parents=True, exist_ok=True)
bg.save(OUT / "icon.png")
bg.resize((32, 32), Image.LANCZOS).save(OUT / "32x32.png")
bg.resize((128, 128), Image.LANCZOS).save(OUT / "128x128.png")
bg.resize((256, 256), Image.LANCZOS).save(OUT / "128x128@2x.png")

iconset = OUT / "icon.iconset"
iconset.mkdir(exist_ok=True)
pairs = [
    (16, 1, "icon_16x16.png"), (16, 2, "icon_16x16@2x.png"),
    (32, 1, "icon_32x32.png"), (32, 2, "icon_32x32@2x.png"),
    (128, 1, "icon_128x128.png"), (128, 2, "icon_128x128@2x.png"),
    (256, 1, "icon_256x256.png"), (256, 2, "icon_256x256@2x.png"),
    (512, 1, "icon_512x512.png"), (512, 2, "icon_512x512@2x.png"),
]
for size, scale, name in pairs:
    bg.resize((size * scale, size * scale), Image.LANCZOS).save(iconset / name)
print(f"icons written to {OUT}")
