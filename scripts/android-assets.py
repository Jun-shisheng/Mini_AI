"""Package the generated mascot for Android launcher masks, splash screens and the web shell."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"
ICONS = ROOT / "public/icons"
SOURCE = Image.open(ROOT / "design/pocket-kitten.png").convert("RGBA")
PET = SOURCE.crop(SOURCE.getchannel("A").getbbox())
PAPER = "#ffffff"


def tile(size, fill, background=None):
    canvas = Image.new("RGBA", (size, size), background or (0, 0, 0, 0))
    side = round(size * fill)
    glyph = ImageOps.contain(PET, (side, side), Image.Resampling.LANCZOS)
    canvas.alpha_composite(glyph, ((size-glyph.width)//2, (size-glyph.height)//2))
    return canvas


for size, name in [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")]:
    tile(size, .67, PAPER).convert("RGB").save(ICONS / name, optimize=True)
tile(128, .94).save(ICONS / "pet.png", optimize=True)
for density, size, adaptive in [("mdpi",48,108),("hdpi",72,162),("xhdpi",96,216),("xxhdpi",144,324),("xxxhdpi",192,432)]:
    folder = RES / ("mipmap-"+density)
    legacy = tile(size, .69, PAPER)
    legacy.save(folder / "ic_launcher.png", optimize=True)
    mask = Image.new("L", (size*4, size*4))
    ImageDraw.Draw(mask).ellipse((0, 0, mask.width-1, mask.height-1), fill=255)
    legacy.putalpha(mask.resize((size,size), Image.Resampling.LANCZOS))
    legacy.save(folder / "ic_launcher_round.png", optimize=True)
    tile(adaptive, .55).save(folder / "ic_launcher_foreground.png", optimize=True)

for path in RES.glob("drawable*/splash.png"):
    with Image.open(path) as previous:
        width, height = previous.size
    screen = Image.new("RGBA", (width,height), PAPER)
    side = max(48, int(min(width,height)*.21))
    screen.alpha_composite(tile(side,.94), ((width-side)//2,(height-side)//2))
    screen.convert("RGB").save(path,optimize=True)
