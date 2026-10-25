// Regional terrain grids for high-resolution flooding.
// Source 1: Terrarium elevation tiles (Mapzen / AWS Terrain Tiles: SRTM, GMTED, ETOPO1, NED and
//           other sources merged; ~30 m on land at zoom 12), fetched through the local server or
//           directly from AWS. Includes bathymetry, so the sea floor is real.
// Source 2: the global 20 km DEM, bilinearly resampled (always available; coarse).
import { DEM, demIndex } from "../data/dem.js";
import { DEG } from "../util/geo.js";
import { S } from "../state.js";

const TILE = 256;
const MAX_TILES = 64;

function lon2x(lon, z) { return ((lon + 180) / 360) * 2 ** z; }
function lat2y(lat, z) { const r = lat * DEG; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; }

export function terrariumUrls(z, x, y) {
  return { proxy: `/api/terrain/${z}/${x}/${y}.png`, direct: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png` };
}

async function loadTile(z, x, y) {
  const u = terrariumUrls(z, x, y);
  const tryUrl = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    const bmp = await createImageBitmap(await r.blob());
    const c = new OffscreenCanvas(TILE, TILE);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, TILE, TILE).data;
    const e = new Float32Array(TILE * TILE);
    for (let i = 0; i < e.length; i++) e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    return e;
  };
  if (S.local) { try { return await tryUrl(u.proxy); } catch {} }
  return tryUrl(u.direct);
}

// bilinear sample of the global DEM (metres)
function globalElev(lat, lon) {
  const { W, H, elev, cls } = DEM;
  const fx = ((lon + 180) / 360) * W - 0.5, fy = ((90 - lat) / 180) * H - 0.5;
  const x0 = Math.floor(fx), y0 = Math.max(0, Math.min(H - 2, Math.floor(fy)));
  const tx = fx - x0, ty = Math.max(0, Math.min(1, fy - y0));
  const at = (y, x) => { const i = y * W + (((x % W) + W) % W); return cls[i] === 0 ? -20 : elev[i]; }; // ocean cells sit below sea level
  return (at(y0, x0) * (1 - tx) + at(y0, x0 + 1) * tx) * (1 - ty) + (at(y0 + 1, x0) * (1 - tx) + at(y0 + 1, x0 + 1) * tx) * ty;
}

/**
 * Build a regular lat/lon grid over bbox {lat0 (south), lat1 (north), lon0 (west), lon1 (east)}.
 * Returns { W, H, bbox, z (Float32 m), ocean (Uint8 1 = open sea boundary), pop (people/cell),
 *           dxRow (Float32 m per column, by row), dy (m), source, cellM }.
 */
export async function buildGrid(bbox, maxCells = 512, { allowTiles = true, onProgress } = {}) {
  const spanLon = bbox.lon1 - bbox.lon0, spanLat = bbox.lat1 - bbox.lat0;
  const midLat = (bbox.lat0 + bbox.lat1) / 2;
  const aspect = (spanLon * Math.cos(midLat * DEG)) / spanLat;
  const W = aspect >= 1 ? maxCells : Math.max(32, Math.round(maxCells * aspect));
  const H = aspect >= 1 ? Math.max(32, Math.round(maxCells / aspect)) : maxCells;
  const dy = (spanLat / H) * 111320;
  const dxRow = new Float32Array(H);
  for (let j = 0; j < H; j++) {
    const lat = bbox.lat1 - ((j + 0.5) / H) * spanLat;
    dxRow[j] = (spanLon / W) * 111320 * Math.cos(lat * DEG);
  }
  const cellM = Math.min(dy, dxRow[(H / 2) | 0]);
  const z = new Float32Array(W * H);
  let source = "global 20 km DEM (resampled)";

  // Terrarium tiles at a zoom whose pixels are at least as fine as the grid cells
  if (allowTiles) {
    let zoom = Math.max(1, Math.min(12, Math.ceil(Math.log2((156543 * Math.cos(midLat * DEG)) / cellM))));
    let x0, x1, y0, y1;
    for (;;) {
      x0 = Math.floor(lon2x(bbox.lon0, zoom)); x1 = Math.floor(lon2x(bbox.lon1, zoom));
      y0 = Math.floor(lat2y(bbox.lat1, zoom)); y1 = Math.floor(lat2y(bbox.lat0, zoom));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES || zoom <= 1) break;
      zoom--;
    }
    const tiles = new Map();
    try {
      const jobs = [];
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
      let done = 0;
      await Promise.all(jobs.map(async ([tx, ty]) => {
        tiles.set(`${tx},${ty}`, await loadTile(zoom, tx, ty));
        onProgress?.(++done / jobs.length);
      }));
      for (let j = 0; j < H; j++) {
        const lat = bbox.lat1 - ((j + 0.5) / H) * spanLat;
        const py = lat2y(lat, zoom) * TILE;
        for (let i = 0; i < W; i++) {
          const lon = bbox.lon0 + ((i + 0.5) / W) * spanLon;
          const px = lon2x(lon, zoom) * TILE;
          const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
          const t = tiles.get(`${tx},${ty}`);
          const lx = Math.min(TILE - 1, Math.floor(px - tx * TILE)), ly = Math.min(TILE - 1, Math.floor(py - ty * TILE));
          z[j * W + i] = t ? t[ly * TILE + lx] : globalElev(lat, lon);
        }
      }
      source = `Terrarium tiles z${zoom} (~${Math.round((156543 * Math.cos(midLat * DEG)) / 2 ** zoom)} m)`;
    } catch {
      tiles.clear();
    }
    if (!tiles.size) for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) z[j * W + i] = globalElev(bbox.lat1 - ((j + 0.5) / H) * spanLat, bbox.lon0 + ((i + 0.5) / W) * spanLon);
  } else {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) z[j * W + i] = globalElev(bbox.lat1 - ((j + 0.5) / H) * spanLat, bbox.lon0 + ((i + 0.5) / W) * spanLon);
  }

  // open sea = cells below 0 m that the global model classes as ocean (polders and inland
  // depressions stay dry until water reaches them overland)
  const ocean = new Uint8Array(W * H);
  const pop = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const lat = bbox.lat1 - ((j + 0.5) / H) * spanLat;
    const gRow = Math.min(DEM.H - 1, Math.floor(((90 - lat) / 180) * DEM.H));
    const cellKm2 = (dxRow[j] * dy) / 1e6;
    for (let i = 0; i < W; i++) {
      const lon = bbox.lon0 + ((i + 0.5) / W) * spanLon;
      const gi = demIndex(lat, lon);
      const k = j * W + i;
      if (z[k] <= 0 && DEM.cls[gi] === 0) ocean[k] = 1;
      if (DEM.pop && z[k] > 0) pop[k] = (DEM.pop[gi] / DEM.rowArea[gRow]) * cellKm2;
    }
  }
  // redistribute population inside each global cell toward land only (sea cells hold none)
  return { W, H, bbox, z, ocean, pop, dxRow, dy, source, cellM };
}

export function bboxAround(c, halfDeg = 1.5) {
  const hl = halfDeg / Math.max(0.3, Math.cos(c.lat * DEG));
  return { lat0: Math.max(-85, c.lat - halfDeg), lat1: Math.min(85, c.lat + halfDeg), lon0: c.lon - hl, lon1: c.lon + hl };
}

export function bboxOfPoly(poly, maxSpanDeg = 6) {
  let a = 90, b = -90, c = 1e9, d = -1e9;
  const ref = poly[0].lon;
  for (const p of poly) {
    let lon = p.lon;
    while (lon - ref > 180) lon -= 360;
    while (lon - ref < -180) lon += 360;
    a = Math.min(a, p.lat); b = Math.max(b, p.lat); c = Math.min(c, lon); d = Math.max(d, lon);
  }
  const cl = (a + b) / 2, cn = (c + d) / 2;
  const hLat = Math.min(maxSpanDeg / 2, (b - a) / 2 + 0.1), hLon = Math.min(maxSpanDeg / 2 / Math.max(0.3, Math.cos(cl * DEG)), (d - c) / 2 + 0.1);
  return { lat0: cl - hLat, lat1: cl + hLat, lon0: cn - hLon, lon1: cn + hLon };
}
