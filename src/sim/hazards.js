// Point hazards: volcanic ash, wind-driven wildfire, meteor impact.
// Plumes are Lagrangian particles advected by the wind field with turbulent diffusion.
// Impact lists come from a fast offline integration so they are ready immediately.
import * as THREE from "three";
import { Wind } from "./windmodel.js";
import { isLand } from "../data/dem.js";
import { CITIES } from "../data/places.js";
import { moveEN, haversine, destination, bearing, DEG, ll2v } from "../util/geo.js";
import { G, onFrame } from "../globe/scene.js";
import { TEX } from "../globe/overlays.js";

export const METEOR = [
  { label: "50 m rock", blastKm: 25, note: "Tunguska-class airburst" },
  { label: "300 m asteroid", blastKm: 110, note: "Regional devastation" },
  { label: "1 km asteroid", blastKm: 450, note: "Continental damage, global dust" },
];

const HOURS_PER_SEC = 6; // time-lapse rate for plume animation

function rand() { return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; }

// advect one parcel one hour; upper-level winds run ~1.3x the steering layer
function advect(p, k = 1.3, diffKm = 9) {
  const w = Wind.sample(p.lat, p.lon);
  return moveEN(p, w.u * 3.6 * k + rand() * diffKm, w.v * 3.6 * k + rand() * diffKm);
}

function plumeFootprint(src, hours, n, k, nearKm) {
  const hits = new Map();
  for (let j = 0; j < n; j++) {
    let p = { ...src };
    const start = Math.random() * hours * 0.6;
    for (let t = 0; t < hours; t++) {
      if (t < start) continue;
      p = advect(p, k);
      if (t % 3) continue;
      for (const c of CITIES) {
        if (Math.abs(c.lat - p.lat) > 1 || haversine(c, p) > nearKm) continue;
        hits.set(c, (hits.get(c) || 0) + 1);
      }
    }
  }
  return hits;
}

// wildfire perimeter: wind-elongated ellipse (Anderson 1983 length-to-breadth ratio) after `hours`
export function firePerimeter(src, hours = 48) {
  const w = Wind.sample(src.lat, src.lon);
  const spd = Math.hypot(w.u, w.v);
  const dir = (Math.atan2(w.u, w.v) / DEG + 360) % 360; // bearing the wind blows toward
  const lb = Math.min(6, 1 + 0.25 * spd);
  const head = (1.2 + 0.35 * spd) * hours * 0.35; // km travelled by the head
  const a = head / 1.6; // semi-major axis
  const b = a / lb;
  const c = Math.sqrt(Math.max(0, a * a - b * b)); // ignition sits at the rear focus
  const centre = destination(src, dir, c);
  const ring = [];
  for (let i = 0; i < 72; i++) {
    const th = (i / 72) * Math.PI * 2;
    const x = a * Math.cos(th), y = b * Math.sin(th);
    const d = Math.hypot(x, y), brg = dir + Math.atan2(y, x) / DEG;
    const q = destination(centre, brg, d);
    ring.push(isLand(q.lat, q.lon) ? q : null);
  }
  // pull water vertices back toward the ignition point
  return ring.map((q, i) => q || (() => {
    const th = (i / 72) * Math.PI * 2;
    const brg = dir + Math.atan2(b * Math.sin(th), a * Math.cos(th)) / DEG;
    let r = 0;
    for (let s = 1; s <= 20; s++) { const t = destination(src, brg, (head * s) / 20); if (!isLand(t.lat, t.lon)) break; r = (head * s) / 20; }
    return destination(src, brg, r);
  })());
}

export function placeHazard(type, at, opts = {}) {
  const ev = { id: Math.random().toString(36).slice(2, 8), type, lat: at.lat, lon: at.lon, t: 0, impacts: [], perimeter: null };
  if (type === "volcano") {
    const hits = plumeFootprint(at, 72, 160, 1.3, 70);
    ev.radiusKm = 40;
    ev.impacts = CITIES.filter((c) => haversine(c, at) < 40).map((c) => ({ ...c, sev: 2, why: "Pyroclastic / heavy ashfall zone" }));
    for (const [c, n] of hits) if (!ev.impacts.find((x) => x.name === c.name)) ev.impacts.push({ ...c, sev: n > 25 ? 2 : 1, why: n > 25 ? "Heavy ashfall (downwind)" : "Ash in the air (downwind)" });
  } else if (type === "wildfire") {
    ev.perimeter = firePerimeter(at, 48);
    const hits = plumeFootprint(at, 48, 90, 1.0, 45);
    const inside = (c) => {
      // inside the burn ellipse: compare with the perimeter radius along the city's bearing
      const brg = bearing(at, c), d = haversine(at, c);
      let best = null, bd = 999;
      for (const q of ev.perimeter) { const diff = Math.abs(((bearing(at, q) - brg + 540) % 360) - 180); if (diff < bd) { bd = diff; best = q; } }
      return best && d <= haversine(at, best);
    };
    for (const c of CITIES) if (Math.abs(c.lat - at.lat) < 3 && inside(c)) ev.impacts.push({ ...c, sev: 2, why: "Inside the 48 h fire perimeter" });
    for (const [c, n] of hits) if (!ev.impacts.find((x) => x.name === c.name)) ev.impacts.push({ ...c, sev: n > 20 ? 2 : 1, why: n > 20 ? "Dense smoke" : "Smoke haze" });
  } else if (type === "meteor") {
    const m = METEOR[opts.size ?? 1];
    ev.radiusKm = m.blastKm;
    ev.size = opts.size ?? 1;
    ev.ocean = !isLand(at.lat, at.lon);
    for (const c of CITIES) {
      const d = haversine(c, at);
      if (d < m.blastKm) ev.impacts.push({ ...c, sev: 2, why: d < m.blastKm * 0.4 ? "Total destruction" : "Severe blast damage" });
      else if (ev.ocean && ev.size >= 1 && d < m.blastKm * 8 && c.elev < 15) ev.impacts.push({ ...c, sev: 1, why: "Tsunami risk (coastal, < 15 m)" });
    }
  }
  ev.impacts.sort((a, b) => b.sev - a.sev || b.pop - a.pop);
  return ev;
}

// ---- particle renderer for live plumes ---------------------------------------------------
const MAXP = 6000;
const P = { lat: new Float32Array(MAXP), lon: new Float32Array(MAXP), age: new Float32Array(MAXP), life: new Float32Array(MAXP), src: new Int16Array(MAXP).fill(-1), k: new Float32Array(MAXP) };
let points = null;
let sources = [];

export function initPlumes() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3));
  points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.035, map: TEX.soft, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
  points.frustumCulled = false;
  G.ovl.add(points);
  onFrame(step);
}

export function setPlumeSources(events) {
  sources = events.filter((e) => e.type === "volcano" || e.type === "wildfire" || (e.type === "meteor" && e.size === 2));
  P.src.fill(-1);
}
export function plumesVisible(v) { if (points) points.visible = v; }

const COLORS = { volcano: [0.55, 0.5, 0.48], wildfire: [0.75, 0.45, 0.22], meteor: [0.6, 0.55, 0.5] };
const tmp = new THREE.Vector3();
let emitAcc = 0;

function step(dt) {
  if (!points || !points.visible) return;
  const hrs = dt * HOURS_PER_SEC;
  const pos = points.geometry.attributes.position.array, col = points.geometry.attributes.color.array;
  // emit
  emitAcc += dt * 220 * sources.length;
  let free = 0;
  while (emitAcc > 1 && sources.length) {
    emitAcc -= 1;
    while (free < MAXP && P.src[free] >= 0) free++;
    if (free >= MAXP) break;
    const si = Math.floor(Math.random() * sources.length), s = sources[si];
    P.lat[free] = s.lat + rand() * 0.15; P.lon[free] = s.lon + rand() * 0.15;
    P.age[free] = 0; P.life[free] = 40 + Math.random() * 50; P.src[free] = si;
    P.k[free] = s.type === "wildfire" ? 1.0 : 1.3;
  }
  for (let i = 0; i < MAXP; i++) {
    if (P.src[i] < 0 || !sources[P.src[i]]) { pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = 0; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; P.src[i] = -1; continue; }
    P.age[i] += hrs;
    if (P.age[i] > P.life[i]) { P.src[i] = -1; continue; }
    const w = Wind.sample(P.lat[i], P.lon[i]);
    const q = moveEN({ lat: P.lat[i], lon: P.lon[i] }, (w.u * 3.6 * P.k[i] + rand() * 9) * hrs, (w.v * 3.6 * P.k[i] + rand() * 9) * hrs);
    P.lat[i] = q.lat; P.lon[i] = q.lon;
    ll2v(q.lat, q.lon, 1.012 + Math.min(0.01, P.age[i] * 0.0002), tmp);
    pos.set([tmp.x, tmp.y, tmp.z], i * 3);
    const f = Math.sin((P.age[i] / P.life[i]) * Math.PI) * 0.8;
    const c = COLORS[sources[P.src[i]].type];
    col.set([c[0] * f, c[1] * f, c[2] * f], i * 3);
  }
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}
