// Node stand-in for src/data/dem.js (same exports), used when bundling engine code for tools/tests.
import fs from "node:fs";
import { PNG } from "pngjs";
import COUNTRY_STATS from "../../src/data/generated/country_stats.json";
export const DEM = { W: 2048, H: 1024, elev: null, cls: null, rowArea: null, landArea: 0, pop: null, country: null, popTotal: 0 };
export const COUNTRY_BY_INDEX = new Map(COUNTRY_STATS.map((c) => [c.i, c]));
export { COUNTRY_STATS };
export async function loadDEM() {
  const { W, H } = DEM, N = W * H;
  const d = PNG.sync.read(fs.readFileSync("assets/dem.png")), p = PNG.sync.read(fs.readFileSync("assets/pop.png"));
  DEM.elev = new Float32Array(N); DEM.cls = new Uint8Array(N); DEM.pop = new Float32Array(N); DEM.country = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    DEM.elev[i] = ((d.data[i * 4] * 256 + d.data[i * 4 + 1]) / 65535) * 9500 - 500;
    const c = d.data[i * 4 + 2]; DEM.cls[i] = c > 191 ? 255 : c > 63 ? 128 : 0;
    DEM.pop[i] = Math.expm1(((p.data[i * 4] * 256 + p.data[i * 4 + 1]) / 65535) * Math.log1p(5e7)); DEM.country[i] = p.data[i * 4 + 2];
  }
  DEM.rowArea = new Float64Array(H);
  for (let y = 0; y < H; y++) { const lat = 90 - ((y + 0.5) / H) * 180; DEM.rowArea[y] = (180 / H) * 111.32 * ((360 / W) * 111.32 * Math.cos((lat * Math.PI) / 180)); }
  return DEM;
}
export function demIndex(lat, lon) { const { W, H } = DEM; let x = Math.floor(((lon + 180) / 360) * W) % W; if (x < 0) x += W; const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H))); return y * W + x; }
export function sampleDEM(lat, lon) { const i = demIndex(lat, lon), c = DEM.cls[i]; return { elev: DEM.elev[i], kind: c === 255 ? "land" : c === 128 ? "lake" : "ocean" }; }
export function isLand(lat, lon) { return DEM.cls[demIndex(lat, lon)] === 255; }
export function countryIndexAt(lat, lon) { return DEM.country[demIndex(lat, lon)]; }
export function popAt(lat, lon) { return DEM.pop[demIndex(lat, lon)]; }
