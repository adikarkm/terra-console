// Digital elevation model (2048 x 1024 equirectangular, ~20 km cells).
// Packed PNG: R,G = 16-bit elevation ((R*256+G)/65535*9500 - 500 m), B = 255 land / 128 lake / 0 ocean.
import DEM_URL from "../../assets/dem.png";
import POP_URL from "../../assets/pop.png";
import COUNTRY_STATS from "./generated/country_stats.json";

export const DEM = {
  W: 2048,
  H: 1024,
  elev: null, // Float32Array
  cls: null, // Uint8Array
  rowArea: null, // Float64Array km2 per cell for each row
  landArea: 0,
  url: DEM_URL,
  pop: null, // Float32Array people per cell (settlement-based dasymetric surface)
  country: null, // Uint8Array index into COUNTRY_STATS (0 = none)
  popTotal: 0,
};
export const COUNTRY_BY_INDEX = new Map(COUNTRY_STATS.map((c) => [c.i, c]));
export { COUNTRY_STATS };

async function pixels(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = DEM.W;
  c.height = DEM.H;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, DEM.W, DEM.H);
  return g.getImageData(0, 0, DEM.W, DEM.H).data;
}

export async function loadDEM() {
  const { W, H } = DEM;
  const [px, pp] = await Promise.all([pixels(DEM_URL), pixels(POP_URL)]);
  const N = W * H;
  DEM.pop = new Float32Array(N);
  DEM.country = new Uint8Array(N);
  const LOGMAX = Math.log1p(5e7);
  let tot = 0;
  for (let i = 0; i < N; i++) {
    const v = Math.expm1(((pp[i * 4] * 256 + pp[i * 4 + 1]) / 65535) * LOGMAX);
    DEM.pop[i] = v;
    tot += v;
    DEM.country[i] = pp[i * 4 + 2];
  }
  DEM.popTotal = tot;
  DEM.elev = new Float32Array(N);
  DEM.cls = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    DEM.elev[i] = ((px[i * 4] * 256 + px[i * 4 + 1]) / 65535) * 9500 - 500;
    DEM.cls[i] = px[i * 4 + 2] > 191 ? 255 : px[i * 4 + 2] > 63 ? 128 : 0;
  }
  DEM.rowArea = new Float64Array(H);
  let land = 0;
  for (let y = 0; y < H; y++) {
    const lat = 90 - ((y + 0.5) / H) * 180;
    DEM.rowArea[y] = ((180 / H) * 111.32) * ((360 / W) * 111.32 * Math.cos((lat * Math.PI) / 180));
    let n = 0;
    for (let x = 0; x < W; x++) if (DEM.cls[y * W + x] === 255) n++;
    land += n * DEM.rowArea[y];
  }
  DEM.landArea = land;
  return DEM;
}

export function demIndex(lat, lon) {
  const { W, H } = DEM;
  let x = Math.floor(((lon + 180) / 360) * W) % W;
  if (x < 0) x += W;
  const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
  return y * W + x;
}

export function sampleDEM(lat, lon) {
  if (!DEM.elev) return { elev: 0, kind: "ocean" };
  const i = demIndex(lat, lon);
  const c = DEM.cls[i];
  return { elev: DEM.elev[i], kind: c === 255 ? "land" : c === 128 ? "lake" : "ocean" };
}

export function isLand(lat, lon) {
  return DEM.cls ? DEM.cls[demIndex(lat, lon)] === 255 : true;
}

export function countryIndexAt(lat, lon) {
  return DEM.country ? DEM.country[demIndex(lat, lon)] : 0;
}
export function popAt(lat, lon) {
  return DEM.pop ? DEM.pop[demIndex(lat, lon)] : 0;
}
