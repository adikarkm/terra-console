"""Build the globe textures used by Terra Console.

Outputs (in assets/):
  earth.jpg  4096x2048 true-colour Blue Marble (NASA, via three-globe example assets)
  dem.png    2048x1024 elevation + surface class, packed:
               R,G = 16-bit elevation, metres = (R*256+G)/65535*9500 - 500
               B   = 255 land, 128 inland lake, 0 ocean

Elevation source: the three-globe topology bump map (NASA SRTM/GTOPO derived), which
stores ~25 m per grey level and flattens coastal lowlands to 0. Lowland land cells are
reconstructed as 0.3 m + 0.06 m per km from the coast (capped at 12 m), which keeps low
coasts (deltas, Florida, the Netherlands) flooding first. Inland lakes are separated
from the ocean so they do not act as flood sources; their surface elevation comes from
a table of known lake levels.

Run:  python3 tools/prepare_textures.py
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage

SRC = "node_modules/three-globe/example/img/"
OUT = "assets/"
W, H = 2048, 1024
os.makedirs(OUT, exist_ok=True)

topo = np.array(Image.open(SRC + "earth-topology.png").convert("L").resize((W, H), Image.BILINEAR)).astype(np.float32)
water = np.array(Image.open(SRC + "earth-water.png").convert("L").resize((W, H), Image.BILINEAR)) > 128
land = ~water

# ---- separate inland lakes from the ocean -------------------------------------------
lab, n = ndimage.label(water, structure=np.ones((3, 3)))
parent = list(range(n + 1))
def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x
for y in range(H):  # merge components across the antimeridian
    a, b = lab[y, 0], lab[y, -1]
    if a and b:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra
root = np.array([find(i) for i in range(n + 1)])
lab = root[lab]
sizes = np.bincount(lab.ravel())
sizes[0] = 0
ocean_id = int(np.argmax(sizes))
ocean = lab == ocean_id
dist_to_ocean = ndimage.distance_transform_edt(~ocean)

# known lake surface levels (m) by approximate centroid
KNOWN_LAKES = [
    ("Caspian Sea", 41.7, 50.8, -28), ("Lake Superior", 47.6, -87.8, 183),
    ("Lakes Michigan-Huron", 44.5, -84.5, 176), ("Lake Erie", 42.2, -81.2, 174),
    ("Lake Ontario", 43.7, -77.8, 75), ("Great Bear Lake", 66.0, -121.0, 156),
    ("Great Slave Lake", 61.6, -114.7, 156), ("Lake Winnipeg", 52.9, -98.1, 217),
    ("Lake Winnipegosis", 52.9, -100.1, 254), ("Lake Victoria", -1.1, 32.9, 1134),
    ("Lake Tanganyika", -6.1, 29.9, 773), ("Lake Malawi", -12.0, 34.5, 474),
    ("Lake Baikal", 53.4, 107.6, 456), ("Aral Sea", 45.1, 59.5, 30),
    ("Lake Balkhash", 46.2, 74.5, 342), ("Lake Onega", 61.8, 35.5, 33),
]
lake = np.zeros_like(water)
elev_lake = np.zeros((H, W), np.float32)
for cid in np.unique(lab):
    if cid in (0, ocean_id):
        continue
    mask = lab == cid
    if dist_to_ocean[mask].min() <= 3:  # within ~60 km of the ocean: a sea behind an unresolved strait
        ocean |= mask
        continue
    ys, xs = np.nonzero(mask)
    clat = 90 - (ys.mean() + 0.5) / H * 180
    clon = (xs.mean() + 0.5) / W * 360 - 180
    level = None
    for name, la, lo, lvl in KNOWN_LAKES:
        if abs(la - clat) < 2.5 and abs(lo - clon) < 3.5:
            level = lvl
            break
    if level is None:  # unknown lake: use the low end of the surrounding land
        ring = ndimage.binary_dilation(mask, iterations=2) & ~mask & land
        level = float(np.percentile(topo[ring] * 25.0, 20)) if ring.any() else 50.0
    lake |= mask
    elev_lake[mask] = level

# ---- elevation ----------------------------------------------------------------------
d_km = ndimage.distance_transform_edt(~ocean) * (180 / H * 111.0)
ramp = np.minimum(0.3 + d_km * 0.06, 12.0)
elev = np.where(topo > 0.5, np.maximum(topo * 25.0, ramp), ramp)
elev[lake] = elev_lake[lake]
elev[ocean] = 0
cls = np.where(ocean, 0, np.where(lake, 128, 255)).astype(np.uint8)

enc = np.clip(np.round((elev + 500.0) / 9500.0 * 65535), 0, 65535).astype(np.uint32)
rgb = np.dstack([(enc >> 8).astype(np.uint8), (enc & 255).astype(np.uint8), cls])
Image.fromarray(rgb, "RGB").save(OUT + "dem.png", optimize=True)
# full 4096 x 2048 Blue Marble (~10 km per pixel) for the built-in globe
Image.open(SRC + "earth-blue-marble.jpg").convert("RGB").save(OUT + "earth.jpg", quality=88, optimize=True, progressive=True)
print("lakes:", int(lake.sum()), "px  ocean:", int(ocean.sum()), "px")
for f in ("dem.png", "earth.jpg"):
    print(f, os.path.getsize(OUT + f) // 1024, "KB")
