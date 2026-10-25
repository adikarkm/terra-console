"""Build the population surface and country raster (assets/pop.png) and country statistics.

Method (a settlement-based dasymetric model):
  1. Every GeoNames place with a population (122k towns and cities) is spread over the grid
     with a Gaussian whose width grows with its size (4 km + 10 km * sqrt(pop / 1M)).
  2. For each country, the World Bank national population (latest year) minus the town total
     is the rural / unlisted remainder. It is spread over the country's land cells with a mix of
     three weights: nearness to towns (a 60 km town-density field, 60%), night-time lights
     (35%) and a small floor on habitable land (5%), so farm belts around market towns and lit
     countryside get people while deserts and ice stay nearly empty.
  3. If the town total exceeds the national figure (overlapping admin units), towns are scaled
     down to 90% of it.
The result sums to the World Bank world total and is a reasonable 20 km exposure layer. It is
not a census grid: use WorldPop or GHS-POP for local studies.

Outputs:
  assets/pop.png  2048x1024: R,G = 16-bit log population per cell (p = expm1(v/65535*ln(5e7+1))),
                  B = country index into country_stats.json (0 = none)
  src/data/generated/country_stats.json  [{i, iso3, iso2, name, pop, popYear, gdp, gdpYear}]

Run after tools/export_geo.mjs:  python3 tools/prepare_population.py
"""
import csv, json, math, os
import numpy as np
from PIL import Image, ImageDraw

W, H = 2048, 1024
RAW = "tools/raw/"
os.makedirs("assets", exist_ok=True)

# ---- country codes, population, GDP ---------------------------------------------------------
codes = {}
with open(RAW + "country-codes.csv", newline="", encoding="utf8") as f:
    for r in csv.DictReader(f):
        m49 = (r.get("M49") or "").strip()
        if m49 and r.get("ISO3166-1-Alpha-3"):
            codes[m49.zfill(3)] = {"iso3": r["ISO3166-1-Alpha-3"], "iso2": r["ISO3166-1-Alpha-2"], "name": r.get("CLDR display name") or r.get("official_name_en")}

def latest(path):
    out = {}
    with open(path, newline="", encoding="utf8") as f:
        for r in csv.DictReader(f):
            try:
                y, v = int(r["Year"]), float(r["Value"])
            except ValueError:
                continue
            k = r["Country Code"]
            if k not in out or y > out[k][0]:
                out[k] = (y, v)
    return out
POP = latest(RAW + "population.csv")
GDP = latest(RAW + "gdp.csv")

# ---- rasterise countries (Natural Earth 1:50m) ------------------------------------------------
gj = json.load(open("build/countries50.geojson"))
img = Image.new("I", (W, H), 0)
draw = ImageDraw.Draw(img)
stats = [None]
def px(lon, lat):
    return ((lon + 180) / 360 * W, (90 - lat) / 180 * H)
for f in gj["features"]:
    fid = str(f.get("id") or "").zfill(3)
    meta = codes.get(fid)
    name = f["properties"].get("name")
    if not meta or not f.get("geometry"):
        continue
    if len(stats) >= 255:
        break
    idx = len(stats)
    p = POP.get(meta["iso3"]); g = GDP.get(meta["iso3"])
    stats.append({"i": idx, "iso3": meta["iso3"], "iso2": meta["iso2"], "name": name or meta["name"],
                  "pop": round(p[1]) if p else None, "popYear": p[0] if p else None,
                  "gdp": round(g[1]) if g else None, "gdpYear": g[0] if g else None})
    geom = f["geometry"]
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    for poly in polys:
        outer = [px(lon, lat) for lon, lat in poly[0]]
        if len(outer) > 2:
            draw.polygon(outer, fill=idx)
        for hole in poly[1:]:
            pts = [px(lon, lat) for lon, lat in hole]
            if len(pts) > 2:
                draw.polygon(pts, fill=0)
cidx = np.array(img, dtype=np.int32)

# ---- land / habitability / night lights -------------------------------------------------------
dem = np.array(Image.open("assets/dem.png").convert("RGB")).astype(np.int32)
elev = (dem[..., 0] * 256 + dem[..., 1]) / 65535 * 9500 - 500
land = dem[..., 2] > 191
lights_raw = np.array(Image.open("node_modules/three-globe/example/img/earth-night.jpg").convert("L").resize((W, H), Image.BILINEAR)).astype(np.float32)
base = np.percentile(lights_raw[land], 88)  # the night texture has a dim blue ground and JPEG noise; keep only real lights
lights = np.clip((lights_raw - base) / (255 - base), 0, 1)
lights[lights < 0.04] = 0
lat_c = 90 - (np.arange(H) + 0.5) / H * 180
LAT = np.repeat(lat_c[:, None], W, axis=1)
habit = np.where(elev < 2500, 1.0, 0.15) * np.where(np.abs(LAT) < 70, 1.0, 0.05)
weight = (np.power(lights, 0.8) + 0.004 * habit) * land

# ---- towns ---------------------------------------------------------------------------------------
towns = json.load(open("build/towns.json"))
iso2_to_idx = {s["iso2"]: s["i"] for s in stats[1:]}
T = np.zeros((H, W), np.float64)
town_by_country = np.zeros(256)
km_y = 180 / H * 111.32
for lat, lon, pop, cc in towns:
    sigma = 4 + 10 * math.sqrt(pop / 1e6)
    km_x = 360 / W * 111.32 * max(0.05, math.cos(math.radians(lat)))
    cx, cy = (lon + 180) / 360 * W, (90 - lat) / 180 * H
    rx, ry = max(1, int(math.ceil(2.5 * sigma / km_x))), max(1, int(math.ceil(2.5 * sigma / km_y)))
    xs = np.arange(int(cx) - rx, int(cx) + rx + 1)
    ys = np.arange(max(0, int(cy) - ry), min(H - 1, int(cy) + ry) + 1)
    dx = ((xs + 0.5) - cx) * km_x
    dy = ((ys + 0.5) - cy) * km_y
    g = np.exp(-(dy[:, None] ** 2 + dx[None, :] ** 2) / (2 * sigma * sigma))
    s = g.sum()
    if s <= 0:
        continue
    T[np.ix_(ys, xs % W)] += g / s * pop
    town_by_country[iso2_to_idx.get(cc, 0)] += pop

from scipy import ndimage
TW = ndimage.gaussian_filter(T, sigma=3.0, mode=("nearest", "wrap"))  # ~60 km town-density field

# ---- dasymetric remainder per country ------------------------------------------------------------
P = np.zeros((H, W), np.float64)
missing = []
for s in stats[1:]:
    i = s["i"]
    mask = cidx == i
    if not mask.any():
        continue
    natl = s["pop"]
    tmask_total = T[mask].sum()
    if natl is None:
        P[mask] += T[mask]
        missing.append(s["name"])
        continue
    if tmask_total > 0.9 * natl:
        P[mask] += T[mask] * (0.9 * natl / tmask_total)
        tmask_total = 0.9 * natl
    else:
        P[mask] += T[mask]
    remainder = natl - tmask_total
    # mix three normalised weights: night lights, nearness to towns (rural people live around
    # market towns), and a small floor on habitable land
    parts = []
    for arr, share in ((np.power(lights, 1.3) * land, 0.35), (np.power(TW, 1.6) * land, 0.63), (habit * land, 0.02)):
        a = arr[mask].astype(np.float64)
        if a.sum() > 0:
            parts.append(share * a / a.sum())
    w = np.sum(parts, axis=0) if parts else mask[mask].astype(np.float64) / mask.sum()
    P[mask] += remainder * w / w.sum()
# towns outside any country polygon (small islands) keep their own population
P[cidx == 0] += T[cidx == 0]

enc = np.clip(np.round(np.log1p(P) / math.log1p(5e7) * 65535), 0, 65535).astype(np.uint32)
rgb = np.dstack([(enc >> 8).astype(np.uint8), (enc & 255).astype(np.uint8), cidx.astype(np.uint8)])
Image.fromarray(rgb, "RGB").save("assets/pop.png", optimize=True)
json.dump(stats[1:], open("src/data/generated/country_stats.json", "w"), separators=(",", ":"))

wb_world = POP.get("WLD")
print(f"population surface total {P.sum()/1e9:.2f} B (World Bank world {wb_world[1]/1e9:.2f} B, {wb_world[0]})")
print("countries rasterised:", len(stats) - 1, " without population data:", missing[:12])
print("pop.png", os.path.getsize("assets/pop.png") // 1024, "KB")
def cell(lat, lon):
    return P[int((90 - lat) / 180 * H), int((lon + 180) / 360 * W) % W]
for n, la, lo in [("Dhaka", 23.8, 90.4), ("Tokyo", 35.68, 139.7), ("Sahara", 23, 13), ("Ganges plain", 26.5, 82)]:
    print(f"  {n}: {cell(la, lo):,.0f} people in the 20 km cell")
