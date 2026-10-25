// Wind field: live GFS steering-level winds (via the local server's Open-Meteo proxy) or a
// physically based climatology. Provides sample(lat, lon) -> {u, v} in m/s (u east, v north)
// and renders animated wind streaks on the globe.
import * as THREE from "three";
import { G, onFrame } from "../globe/scene.js";
import { ll2v, DEG } from "../util/geo.js";
import { S, emit } from "../state.js";

import { Wind, climatology } from "./windmodel.js";
import { initWindGPU, setWindGPU, WG } from "./windgpu.js";
export { Wind, climatology };

export async function loadLiveWind() {
  try {
    const r = await fetch("/api/wind", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    if (!j.u || !j.v) throw new Error("bad payload");
    Wind.grid = { ...j, u: Float32Array.from(j.u), v: Float32Array.from(j.v) };
    Wind.source = `GFS ${j.level || ""} · ${j.time || "live"}`.trim();
  } catch {
    Wind.grid = null;
    Wind.source = "climatology";
  }
  S.windSource = Wind.source;
  emit("wind:source", Wind.source);
  return Wind.source;
}

// ---- animated streaks ------------------------------------------------------------------
const NP = 3500;
let lines = null;
const P = { lat: new Float32Array(NP), lon: new Float32Array(NP), age: new Float32Array(NP), life: new Float32Array(NP) };
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3();

function respawn(i) {
  P.lat[i] = Math.asin(Math.random() * 2 - 1) / DEG;
  P.lon[i] = Math.random() * 360 - 180;
  P.age[i] = 0;
  P.life[i] = 2 + Math.random() * 4;
}

export function initWindLayer() {
  if (initWindGPU(1024)) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NP * 6), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(NP * 6), 3));
  lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  lines.visible = false;
  lines.frustumCulled = false;
  G.ovl.add(lines);
  for (let i = 0; i < NP; i++) { respawn(i); P.age[i] = Math.random() * P.life[i]; }
  onFrame(step);
}

export function setWindLayer(on) {
  S.windLayer = on;
  if (WG.ok) setWindGPU(on);
  else if (lines) lines.visible = on;
  emit("wind:layer", on);
}

export function windEngine() {
  return WG.ok ? `${(WG.count / 1e6).toFixed(2)} M particles on the GPU` : `${NP.toLocaleString()} particles on the CPU`;
}

function step(dt) {
  if (!lines?.visible) return;
  const pos = lines.geometry.attributes.position.array;
  const col = lines.geometry.attributes.color.array;
  const k = 0.035; // degrees of travel per (m/s) per second, for legibility
  for (let i = 0; i < NP; i++) {
    P.age[i] += dt;
    if (P.age[i] > P.life[i]) respawn(i);
    const { u, v } = Wind.sample(P.lat[i], P.lon[i]);
    const cl = Math.max(0.15, Math.cos(P.lat[i] * DEG));
    const la0 = P.lat[i], lo0 = P.lon[i];
    P.lat[i] = Math.max(-89, Math.min(89, la0 + v * k * dt));
    P.lon[i] = ((lo0 + (u * k * dt) / cl + 540) % 360) - 180;
    const spd = Math.hypot(u, v);
    const tail = 0.6 + Math.min(2.5, spd * 0.12);
    ll2v(P.lat[i], P.lon[i], 1.008, v1);
    ll2v(la0 - v * k * tail, lo0 - (u * k * tail) / cl, 1.008, v2);
    pos.set([v1.x, v1.y, v1.z, v2.x, v2.y, v2.z], i * 6);
    const fade = Math.sin((P.age[i] / P.life[i]) * Math.PI);
    const t = Math.min(1, spd / 20);
    const r = (0.25 + 0.75 * t) * fade, g = (0.7 + 0.2 * t) * fade, b = 1.0 * fade;
    col.set([r, g, b, r * 0.1, g * 0.1, b * 0.1], i * 6);
  }
  lines.geometry.attributes.position.needsUpdate = true;
  lines.geometry.attributes.color.needsUpdate = true;
}
