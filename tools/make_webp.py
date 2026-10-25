"""Browser copies of the textures: lossless WebP for the data images (identical pixels), lossy WebP
for the world image plus a 1024 px preview. Run after tools/prepare_textures.py."""
from PIL import Image
for name in ["dem", "pop"]:
    Image.open(f"assets/{name}.png").save(f"assets/{name}.webp", lossless=True, method=6)
im = Image.open("assets/earth.jpg").convert("RGB")
im.save("assets/earth.webp", quality=80, method=6)
im.resize((1024, 512), Image.LANCZOS).save("assets/earth-1k.webp", quality=72, method=6)
print("assets/*.webp written")
