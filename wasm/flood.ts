// Terra Console spatial compute kernel (AssemblyScript -> WebAssembly).
//
// 1. priorityFlood(): Priority-Flood (Barnes, Lehman & Mulla 2014) seeded from every ocean
//    cell that touches land. For each land cell it computes the SPILL LEVEL: the lowest sea
//    level at which water can reach that cell along some path from the ocean (the minimax
//    elevation of the path). Water therefore enters valleys and basins only once the sea tops
//    their rim, and a basin below sea level fills completely when it does. After one run, the
//    flood for any sea level is a threshold test: flooded = spill <= sea.
// 2. floodArea(): flooded land area (km2) for a sea level, area-weighted by latitude.
// 3. regionStats(): elevation and flood statistics inside a lat/lon polygon.
//
// 4. floodStats(): global flooded area and people, plus people flooded per country.
//
// Memory layout (all set up by setup()): elev f32[N] | spill f32[N] | heapIdx i32[N] |
// heapKey f32[N] | pop f32[N] | cls u8[N] | country u8[N] | visited u8[N] | rowArea f64[H] |
// poly f64[2*MAXPOLY] | out f64[32] | perCountry f64[256]

let W: i32 = 0;
let H: i32 = 0;
let N: i32 = 0;
let pElev: usize = 0;
let pSpill: usize = 0;
let pHI: usize = 0;
let pHK: usize = 0;
let pCls: usize = 0;
let pPop: usize = 0;
let pCty: usize = 0;
let pCO: usize = 0;
let pVis: usize = 0;
let pRow: usize = 0;
let pPoly: usize = 0;
let pOut: usize = 0;
let hs: i32 = 0;
const MAXPOLY: i32 = 4096;

export function setup(w: i32, h: i32): void {
  W = w; H = h; N = w * h;
  const n = <usize>N;
  const bytes: usize = n * 20 + n * 3 + <usize>h * 8 + <usize>MAXPOLY * 16 + 256 + 2048 + 128;
  const base: usize = (<usize>memory.size()) << 16;
  memory.grow(<i32>((bytes + 0xffff) >> 16));
  pElev = base;
  pSpill = pElev + n * 4;
  pHI = pSpill + n * 4;
  pHK = pHI + n * 4;
  pPop = pHK + n * 4;
  pCls = pPop + n * 4;
  pCty = pCls + n;
  pVis = pCty + n;
  pRow = (pVis + n + 7) & ~(<usize>7);
  pPoly = pRow + <usize>h * 8;
  pOut = pPoly + <usize>MAXPOLY * 16;
  pCO = pOut + 256;
}
export function elevPtr(): usize { return pElev; }
export function spillPtr(): usize { return pSpill; }
export function clsPtr(): usize { return pCls; }
export function rowAreaPtr(): usize { return pRow; }
export function polyPtr(): usize { return pPoly; }
export function outPtr(): usize { return pOut; }
export function popPtr(): usize { return pPop; }
export function countryPtr(): usize { return pCty; }
export function perCountryPtr(): usize { return pCO; }

@inline function key(i: i32): f32 { return load<f32>(pHK + (<usize>i << 2)); }
@inline function idx(i: i32): i32 { return load<i32>(pHI + (<usize>i << 2)); }
@inline function put(i: i32, id: i32, k: f32): void {
  store<i32>(pHI + (<usize>i << 2), id);
  store<f32>(pHK + (<usize>i << 2), k);
}

function hpush(id: i32, k: f32): void {
  let c = hs++;
  while (c > 0) {
    const p = (c - 1) >> 1;
    const pk = key(p);
    if (pk <= k) break;
    put(c, idx(p), pk);
    c = p;
  }
  put(c, id, k);
}

// pops the root id; its key is read with key(0) before calling
function hpop(): i32 {
  const top = idx(0);
  hs--;
  if (hs > 0) {
    const lid = idx(hs);
    const lk = key(hs);
    let c = 0;
    while (true) {
      const l = 2 * c + 1;
      if (l >= hs) break;
      let m = l;
      const r = l + 1;
      if (r < hs && key(r) < key(l)) m = r;
      if (key(m) >= lk) break;
      put(c, idx(m), key(m));
      c = m;
    }
    put(c, lid, lk);
  }
  return top;
}

@inline function cls(i: i32): u8 { return load<u8>(pCls + <usize>i); }
@inline function vis(i: i32): u8 { return load<u8>(pVis + <usize>i); }
@inline function setVis(i: i32): void { store<u8>(pVis + <usize>i, 1); }

// returns number of cells processed
export function priorityFlood(): i32 {
  memory.fill(pVis, 0, <usize>N);
  hs = 0;
  // ocean cells: spill = -1 (always water). Seed coastal ocean cells at level 0.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (cls(i) != 0) continue;
      setVis(i);
      store<f32>(pSpill + (<usize>i << 2), -1.0);
      let coastal = false;
      for (let dy = -1; dy <= 1 && !coastal; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          let xx = x + dx;
          if (xx < 0) xx += W; else if (xx >= W) xx -= W;
          if (cls(yy * W + xx) != 0) { coastal = true; break; }
        }
      }
      if (coastal) hpush(i, 0.0);
    }
  }
  let processed = 0;
  while (hs > 0) {
    const level = key(0);
    const c = hpop();
    processed++;
    const cy = c / W;
    const cx = c - cy * W;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        let xx = cx + dx;
        if (xx < 0) xx += W; else if (xx >= W) xx -= W;
        const n = yy * W + xx;
        if (vis(n)) continue;
        setVis(n);
        const e = load<f32>(pElev + (<usize>n << 2));
        const s: f32 = e > level ? e : level;
        store<f32>(pSpill + (<usize>n << 2), s);
        hpush(n, s);
      }
    }
  }
  // unreachable land (should not happen) never floods
  for (let i = 0; i < N; i++) if (!vis(i)) store<f32>(pSpill + (<usize>i << 2), 1.0e9);
  return processed;
}

export function floodArea(sea: f32): f64 {
  let a: f64 = 0;
  for (let y = 0; y < H; y++) {
    const ra = load<f64>(pRow + (<usize>y << 3));
    let cnt = 0;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (cls(i) == 255 && load<f32>(pSpill + (<usize>i << 2)) <= sea) cnt++;
    }
    a += <f64>cnt * ra;
  }
  return a;
}

// global: out[0] flooded km2, out[1] people in flooded cells; perCountry[c] people flooded per country
export function floodStats(sea: f32): void {
  memory.fill(pCO, 0, 2048);
  let a: f64 = 0, people: f64 = 0;
  for (let y = 0; y < H; y++) {
    const ra = load<f64>(pRow + (<usize>y << 3));
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (cls(i) != 255 || load<f32>(pSpill + (<usize>i << 2)) > sea) continue;
      a += ra;
      const p = <f64>load<f32>(pPop + (<usize>i << 2));
      people += p;
      const c = <usize>load<u8>(pCty + <usize>i);
      store<f64>(pCO + (c << 3), load<f64>(pCO + (c << 3)) + p);
    }
  }
  store<f64>(pOut, a);
  store<f64>(pOut + 8, people);
}

@inline function px(i: i32): f64 { return load<f64>(pPoly + (<usize>i << 4)); }
@inline function py(i: i32): f64 { return load<f64>(pPoly + (<usize>i << 4) + 8); }

// polygon in pPoly as (lon, lat) pairs with lon already unwrapped around lon0.
// out: [samples, landArea, totalArea, elevSumWeighted, maxElev, below2, below5, below10, floodedArea, minElev,
//       people, peopleFlooded, peopleBelow5m]; perCountry: people flooded per country inside the polygon
export function regionStats(n: i32, sea: f32): void {
  let minLon = 1e9, maxLon = -1e9, minLat = 1e9, maxLat = -1e9;
  for (let i = 0; i < n; i++) {
    const x = px(i), y = py(i);
    if (x < minLon) minLon = x; if (x > maxLon) maxLon = x;
    if (y < minLat) minLat = y; if (y > maxLat) maxLat = y;
  }
  const y0 = <i32>Math.max(0, Math.floor((90 - maxLat) / 180 * H));
  const y1 = <i32>Math.min(H - 1, Math.ceil((90 - minLat) / 180 * H));
  const x0 = <i32>Math.floor((minLon + 180) / 360 * W);
  const x1 = <i32>Math.ceil((maxLon + 180) / 360 * W);
  let samples: f64 = 0, landA: f64 = 0, totA: f64 = 0, eSum: f64 = 0, eMax: f64 = -1e9, eMin: f64 = 1e9;
  let b2: f64 = 0, b5: f64 = 0, b10: f64 = 0, fl: f64 = 0, popT: f64 = 0, popF: f64 = 0, popB5: f64 = 0;
  memory.fill(pCO, 0, 2048);
  for (let y = y0; y <= y1; y++) {
    const lat = 90 - (<f64>y + 0.5) / <f64>H * 180;
    const ra = load<f64>(pRow + (<usize>y << 3));
    for (let x = x0; x <= x1; x++) {
      const lon = (<f64>x + 0.5) / <f64>W * 360 - 180;
      // point in polygon (ray casting)
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = px(i), yi = py(i), xj = px(j), yj = py(j);
        if (((yi > lat) != (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
      if (!inside) continue;
      let xx = x % W; if (xx < 0) xx += W;
      const id = y * W + xx;
      samples += 1;
      totA += ra;
      const pp = <f64>load<f32>(pPop + (<usize>id << 2));
      popT += pp;
      if (cls(id) != 255) continue;
      const e = <f64>load<f32>(pElev + (<usize>id << 2));
      if (e < 5) popB5 += pp;
      landA += ra;
      eSum += e * ra;
      if (e > eMax) eMax = e;
      if (e < eMin) eMin = e;
      if (e < 2) b2 += ra;
      if (e < 5) b5 += ra;
      if (e < 10) b10 += ra;
      if (load<f32>(pSpill + (<usize>id << 2)) <= sea) {
        fl += ra;
        popF += pp;
        const c = <usize>load<u8>(pCty + <usize>id);
        store<f64>(pCO + (c << 3), load<f64>(pCO + (c << 3)) + pp);
      }
    }
  }
  store<f64>(pOut, samples);
  store<f64>(pOut + 8, landA);
  store<f64>(pOut + 16, totA);
  store<f64>(pOut + 24, eSum);
  store<f64>(pOut + 32, eMax);
  store<f64>(pOut + 40, b2);
  store<f64>(pOut + 48, b5);
  store<f64>(pOut + 56, b10);
  store<f64>(pOut + 64, fl);
  store<f64>(pOut + 72, eMin);
  store<f64>(pOut + 80, popT);
  store<f64>(pOut + 88, popF);
  store<f64>(pOut + 96, popB5);
}
