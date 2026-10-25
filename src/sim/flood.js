// Flood engine: runs the WebAssembly Priority-Flood kernel in a Web Worker so the main
// thread (rendering, MediaPipe) never blocks. Falls back to a JS port if Wasm is unavailable.
import WASM_BYTES from "../../build/flood.wasm";
import { DEM, COUNTRY_BY_INDEX } from "../data/dem.js";
import { CITIES } from "../data/places.js";
import { unwrapPoly } from "../util/geo.js";

const WORKER_SRC = `
let k = null, N = 0, W = 0, H = 0, js = null;
const views = () => ({
  elev: new Float32Array(k.memory.buffer, k.elevPtr(), N),
  spill: new Float32Array(k.memory.buffer, k.spillPtr(), N),
  cls: new Uint8Array(k.memory.buffer, k.clsPtr(), N),
  row: new Float64Array(k.memory.buffer, k.rowAreaPtr(), H),
  poly: new Float64Array(k.memory.buffer, k.polyPtr(), 8192),
  out: new Float64Array(k.memory.buffer, k.outPtr(), 32),
  pop: new Float32Array(k.memory.buffer, k.popPtr(), N),
  cty: new Uint8Array(k.memory.buffer, k.countryPtr(), N),
  per: new Float64Array(k.memory.buffer, k.perCountryPtr(), 256),
});

// ---- JS fallback (same algorithm) ----
function jsFlood(elev, cls, W, H) {
  const N = W * H, spill = new Float32Array(N), vis = new Uint8Array(N);
  const hi = new Int32Array(N), hk = new Float32Array(N); let hs = 0;
  const push = (id, key) => { let c = hs++; while (c > 0) { const p = (c - 1) >> 1; if (hk[p] <= key) break; hi[c] = hi[p]; hk[c] = hk[p]; c = p; } hi[c] = id; hk[c] = key; };
  const pop = () => { const top = hi[0]; hs--; if (hs > 0) { const lid = hi[hs], lk = hk[hs]; let c = 0; for (;;) { const l = 2 * c + 1; if (l >= hs) break; let m = l; if (l + 1 < hs && hk[l + 1] < hk[l]) m = l + 1; if (hk[m] >= lk) break; hi[c] = hi[m]; hk[c] = hk[m]; c = m; } hi[c] = lid; hk[c] = lk; } return top; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (cls[i] !== 0) continue; vis[i] = 1; spill[i] = -1; let coastal = false;
    for (let dy = -1; dy <= 1 && !coastal; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -1; dx <= 1; dx++) { const xx = (x + dx + W) % W; if (cls[yy * W + xx] !== 0) { coastal = true; break; } } }
    if (coastal) push(i, 0);
  }
  while (hs > 0) {
    const level = hk[0], c = pop(), cy = (c / W) | 0, cx = c - cy * W;
    for (let dy = -1; dy <= 1; dy++) { const yy = cy + dy; if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const n = yy * W + (cx + dx + W) % W; if (vis[n]) continue; vis[n] = 1; const s = elev[n] > level ? elev[n] : level; spill[n] = s; push(n, s); } }
  }
  for (let i = 0; i < N; i++) if (!vis[i]) spill[i] = 1e9;
  return spill;
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      W = m.W; H = m.H; N = W * H;
      const t0 = performance.now();
      let engine = "wasm";
      try {
        const { instance } = await WebAssembly.instantiate(m.wasm, { env: { abort() { throw new Error("wasm abort"); } } });
        k = instance.exports; k.setup(W, H);
        const v = views(); v.elev.set(m.elev); v.cls.set(m.cls); v.row.set(m.row); v.pop.set(m.pop); v.cty.set(m.cty);
        k.priorityFlood();
      } catch (err) {
        engine = "js"; k = null;
        js = { elev: m.elev, cls: m.cls, row: m.row, pop: m.pop, cty: m.cty, spill: jsFlood(m.elev, m.cls, W, H) };
      }
      const spill = k ? new Float32Array(views().spill) : js.spill.slice();
      postMessage({ id: m.id, type: "ready", engine, ms: performance.now() - t0, spill }, [spill.buffer]);
    } else if (m.type === "area") {
      let a = 0, people = 0, per = new Float64Array(256);
      if (k) { k.floodStats(m.sea); const v = views(); a = v.out[0]; people = v.out[1]; per = Float64Array.from(v.per); }
      else for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (js.cls[i] === 255 && js.spill[i] <= m.sea) { a += js.row[y]; people += js.pop[i]; per[js.cty[i]] += js.pop[i]; } }
      postMessage({ id: m.id, area: a, people, per }, [per.buffer]);
    } else if (m.type === "region") {
      if (!k) { postMessage({ id: m.id, out: null }); return; }
      const v = views(); const n = Math.min(4096, m.poly.length / 2);
      v.poly.set(m.poly.subarray(0, n * 2));
      k.regionStats(n, m.sea);
      postMessage({ id: m.id, out: Array.from(v.out.subarray(0, 13)), per: Array.from(v.per) });
    }
  } catch (err) { postMessage({ id: m.id, error: String(err) }); }
};`;

let worker = null;
let seq = 0;
const pending = new Map();
export const Flood = { ready: false, engine: "—", ms: 0, spill: null };

function call(msg, transfer) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}

export async function initFlood() {
  worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })));
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data);
  };
  const r = await call({ type: "init", W: DEM.W, H: DEM.H, wasm: WASM_BYTES, elev: DEM.elev.slice(), cls: DEM.cls.slice(), row: DEM.rowArea.slice(), pop: DEM.pop.slice(), cty: DEM.country.slice() });
  Object.assign(Flood, { ready: true, engine: r.engine, ms: r.ms, spill: r.spill });
  return Flood;
}

export async function floodArea(sea) {
  return (await floodStats(sea)).area;
}

function topCountries(per, n = 8) {
  const out = [];
  for (let i = 1; i < per.length; i++) if (per[i] > 0) { const c = COUNTRY_BY_INDEX.get(i); if (c) out.push({ country: c.name, iso3: c.iso3, people: Math.round(per[i]) }); }
  out.sort((a, b) => b.people - a.people);
  return out.slice(0, n);
}

// global flood: area, people in flooded cells, people per country
export async function floodStats(sea) {
  if (!Flood.ready || sea <= 0) return { area: 0, people: 0, countries: [] };
  const r = await call({ type: "area", sea });
  return { area: r.area, people: r.people, countries: topCountries(r.per, 10) };
}

// region stats for a polygon at a sea level (km², metres)
export async function regionStats(poly, sea = 0) {
  const up = unwrapPoly(poly);
  const arr = new Float64Array(up.length * 2);
  up.forEach((p, i) => { arr[i * 2] = p.lon; arr[i * 2 + 1] = p.lat; });
  const r = Flood.ready ? await call({ type: "region", poly: arr, sea }) : { out: null };
  if (!r.out) return null;
  const [samples, landA, totA, eSum, eMax, b2, b5, b10, fl, eMin, popT, popF, popB5] = r.out;
  return {
    samples,
    areaKm2: totA,
    landKm2: landA,
    landPct: totA ? (landA / totA) * 100 : 0,
    meanElev: landA ? eSum / landA : 0,
    maxElev: landA ? eMax : 0,
    minElev: landA ? eMin : 0,
    below2Km2: b2,
    below5Km2: b5,
    below10Km2: b10,
    floodedKm2: fl,
    people: popT,
    peopleFlooded: popF,
    peopleBelow5m: popB5,
    floodedByCountry: topCountries(r.per || [], 8),
  };
}

export function citiesUnderwater(sea, filter = null) {
  if (sea <= 0) return [];
  return CITIES.filter((c) => c.elev < sea && (!filter || filter(c)));
}
