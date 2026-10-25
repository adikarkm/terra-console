// Place names that appear as you zoom: countries from far away, then big cities, then towns
// (every GeoNames place with 5,000+ people). Labels never overlap; bigger places win.
import { COUNTRIES, CITIES } from "../data/places.js";
import { G, project, viewCenter, onFrame } from "./scene.js";
import { DEG } from "../util/geo.js";

// Cities over 100k are labelled from the start; the 49,000 towns (1.6 MB) load after the globe is up.
let towns = [];
let grid = new Map();
const key = (la, lo) => `${Math.floor(la / 2)},${Math.floor(lo / 2)}`;
function index(list) {
  towns = list.slice().sort((a, b) => b.pop - a.pop);
  grid = new Map();
  for (const t of towns) { const k = key(t.lat, t.lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(t); }
}
index(CITIES.map((c) => ({ name: c.name, lat: c.lat, lon: c.lon, pop: c.pop })));
export function loadTowns() {
  return import("../data/generated/towns.json").then(({ default: F }) => {
    const n = F.length / 4, list = new Array(n);
    for (let i = 0; i < n; i++) list[i] = { name: F[i * 4], lat: F[i * 4 + 1], lon: F[i * 4 + 2], pop: F[i * 4 + 3] };
    index(list);
    PL.townsLoaded = true;
  });
}

// country label points: centroid of each country's largest ring
const countryPts = COUNTRIES.map((c) => {
  let best = null, bestN = 0;
  for (const r of c.rings) if (r.length > bestN) { bestN = r.length; best = r; }
  if (!best) return null;
  let la = 0, lo = 0;
  for (const p of best) { la += p.lat; lo += p.lon; }
  return { name: c.name, lat: la / best.length, lon: ((((lo / best.length) + 180) % 360) + 360) % 360 - 180, size: bestN };
}).filter(Boolean).sort((a, b) => b.size - a.size);

export const PL = { on: true, el: null, pool: [], shown: [], t: 0, townsLoaded: false };

export function initPlaceLabels() {
  PL.el = document.getElementById("placeLabels");
  onFrame(frame);
}

export function setPlaceLabels(on) {
  PL.on = on;
  PL.el.hidden = !on;
}

function minPopFor(alt) {
  if (alt > 1.2) return 6e6;
  if (alt > 0.6) return 2e6;
  if (alt > 0.25) return 5e5;
  if (alt > 0.1) return 1.5e5;
  if (alt > 0.04) return 4e4;
  if (alt > 0.015) return 1.2e4;
  return 5000;
}

function candidates(alt) {
  const c = viewCenter();
  const tiltReach = G.tilt > 0.25 ? Math.sqrt(2 * alt) * 1.3 : 0;
  const R = Math.min(90, Math.max(alt * 0.9, tiltReach, 0.01) / DEG + 1);
  const minPop = minPopFor(alt);
  const out = [];
  if (R >= 60) {
    for (const t of towns) { if (t.pop < minPop) break; out.push(t); }
    return out;
  }
  const la0 = Math.floor((c.lat - R) / 2), la1 = Math.floor((c.lat + R) / 2);
  const span = Math.min(180, R / Math.max(0.1, Math.cos(Math.min(85, Math.abs(c.lat) + R) * DEG)));
  const lo0 = Math.floor((c.lon - span) / 2), lo1 = Math.floor((c.lon + span) / 2);
  for (let a = la0; a <= la1; a++) for (let b = lo0; b <= lo1; b++) {
    const bb = ((((b + 90) % 180) + 180) % 180) - 90; // wrap 2° longitude buckets across the antimeridian
    const cell = grid.get(`${a},${bb}`);
    if (cell) for (const t of cell) if (t.pop >= minPop) out.push(t);
  }
  out.sort((x, y) => y.pop - x.pop);
  return out;
}

function select() {
  const alt = G.dist - 1;
  const placed = [];
  const boxes = [];
  const fits = (x, y, w, h) => {
    if (x < 4 || y < 4 || x + w > innerWidth - 4 || y + h > innerHeight - 4) return false;
    for (const b of boxes) if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false;
    boxes.push([x, y, w, h]);
    return true;
  };
  if (alt > 0.22 && alt < 2.2) {
    for (const c of countryPts) {
      if (placed.length > 30) break;
      const p = project(c.lat, c.lon);
      if (!p || p.facing < 0.35) continue;
      const w = c.name.length * 8.4 + 8;
      if (fits(p.x - w / 2, p.y - 8, w, 16)) placed.push({ kind: "country", item: c });
    }
  }
  const limit = alt > 0.5 ? 25 : 70;
  let n = 0;
  for (const t of candidates(alt)) {
    if (n >= limit) break;
    const p = project(t.lat, t.lon);
    if (!p || p.facing < 0.12) continue;
    const big = t.pop >= 1e6;
    const w = t.name.length * (big ? 7.2 : 6.4) + 14;
    if (fits(p.x - 3, p.y - 8, w, 16)) { placed.push({ kind: big ? "city big" : "city", item: t }); n++; }
  }
  PL.shown = placed;
  // sync the DOM pool
  while (PL.pool.length < placed.length) {
    const d = document.createElement("div");
    d.className = "pl";
    PL.el.append(d);
    PL.pool.push(d);
  }
  PL.pool.forEach((d, i) => {
    const s = placed[i];
    if (!s) { d.style.display = "none"; d._item = null; return; }
    d.style.display = "";
    if (d._item !== s.item) {
      d._item = s.item;
      d.className = "pl " + s.kind;
      d.textContent = s.item.name;
    }
  });
}

function frame() {
  if (!PL.on || !PL.el) return;
  const now = performance.now();
  if (now - PL.t > 160) { PL.t = now; select(); }
  PL.pool.forEach((d) => {
    if (!d._item) return;
    const p = project(d._item.lat, d._item.lon);
    if (!p) { d.style.visibility = "hidden"; return; }
    d.style.visibility = "";
    d.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
  });
}
