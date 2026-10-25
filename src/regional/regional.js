// Regional flood dynamics: build a high-resolution terrain grid for a window, then either show
// the equilibrium flood (regional Priority-Flood) or run the shallow-water model in time with a
// storm-surge hydrograph. Drawn as a curved high-resolution patch on the globe.
import * as THREE from "three";
import { S, emit, on } from "../state.js";
import { $, h, toast, fmtKm2, fmtPop } from "../util/dom.js";
import { G, flyTo, onFrame, viewCenter } from "../globe/scene.js";
import { DEG, ll2v } from "../util/geo.js";
import { buildGrid, bboxAround, bboxOfPoly } from "./terrain.js";
import { CpuSWE, GpuSWE, webgpuAvailable, regionalPriorityFlood, boundaryLevel, FORCING_DEFAULT } from "./swe.js";
import { SURGE_M } from "../sim/storm.js";

export const R = { grid: null, engine: null, patch: null, canvas: null, tex: null, running: false, mode: "dynamic", forcing: { ...FORCING_DEFAULT }, speedH: 3, lastH: null, spill: null, stats: null, busy: false, peak: null };

const DEPTH = [[0.0, [255, 214, 122]], [0.5, [255, 170, 60]], [1.5, [255, 110, 40]], [3, [225, 55, 45]], [6, [150, 25, 70]]];
function depthColor(d) {
  for (let i = 1; i < DEPTH.length; i++) if (d <= DEPTH[i][0]) {
    const [a, ca] = DEPTH[i - 1], [b, cb] = DEPTH[i], k = (d - a) / (b - a);
    return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k];
  }
  return DEPTH[DEPTH.length - 1][1];
}

export function initRegional() {
  $("#rgBuild").addEventListener("click", () => buildHere());
  $("#rgPlay").addEventListener("click", () => (R.running ? pause() : play()));
  $("#rgReset").addEventListener("click", resetSim);
  $("#rgMode").addEventListener("change", (e) => { R.mode = e.target.value; if (R.mode === "equilibrium") { pause(); drawEquilibrium(); } else redraw(R.lastH); });
  const surge = $("#rgSurge");
  surge.addEventListener("input", () => { R.forcing.surge = +surge.value; $("#rgSurgeVal").textContent = `${(+surge.value).toFixed(1)} m`; });
  $("#rgTide").addEventListener("input", (e) => { R.forcing.tide = +e.target.value; $("#rgTideVal").textContent = `${(+e.target.value).toFixed(1)} m`; });
  $("#rgSpeed").addEventListener("change", (e) => (R.speedH = +e.target.value));
  $("#rgClose").addEventListener("click", closeRegional);
  on("sea", (s) => { R.forcing.sea = s; if (R.mode === "equilibrium" && R.grid) drawEquilibrium(); });
  onFrame(tick);
}

export async function buildHere(center = null, { maxCells, silent = false } = {}) {
  const bbox = center ? bboxAround(center, 1.2) : S.region ? bboxOfPoly(S.region.poly) : bboxAround(viewCenter(), 1.2);
  const gpu = await webgpuAvailable();
  const cells = maxCells || (gpu ? 512 : 256);
  $("#rgStatus").textContent = "Fetching terrain…";
  $("#rgPanel").hidden = false;
  pause();
  R.engine?.dispose();
  R.engine = null;
  const grid = await buildGrid(bbox, cells, { onProgress: (f) => ($("#rgStatus").textContent = `Fetching terrain… ${Math.round(f * 100)}%`) });
  R.grid = grid;
  R.spill = regionalPriorityFlood(grid);
  R.forcing.sea = S.sea;
  // surge from a storm passing nearby, if any
  if (S.storm?.track) {
    const c = { lat: (bbox.lat0 + bbox.lat1) / 2, lon: (bbox.lon0 + bbox.lon1) / 2 };
    let best = null, bd = 1e9;
    for (const p of S.storm.track) { const d = Math.hypot(p.lat - c.lat, (p.lon - c.lon) * Math.cos(c.lat * DEG)); if (d < bd) { bd = d; best = p; } }
    if (best && bd < 4 && best.cat >= 0) { R.forcing.surge = SURGE_M[Math.max(0, best.cat)]; $("#rgSurge").value = R.forcing.surge; $("#rgSurgeVal").textContent = `${R.forcing.surge.toFixed(1)} m (Cat ${best.cat} storm)`; }
  }
  try {
    R.engine = gpu ? await new GpuSWE().init(grid) : await new CpuSWE().init(grid);
  } catch (e) {
    console.warn("WebGPU failed, using CPU", e);
    R.engine = await new CpuSWE().init(grid);
  }
  makePatch(grid);
  R.lastH = null;
  R.peak = { people: 0, km2: 0, depth: 0, t: 0 };
  $("#rgSource").textContent = `${grid.W}×${grid.H} cells · ${Math.round(grid.cellM)} m · ${grid.source} · ${R.engine.kind}`;
  $("#rgStatus").textContent = "Ready. Press Play to run the surge.";
  if (R.mode === "equilibrium") drawEquilibrium(); else redraw(null);
  if (!silent) flyTo((bbox.lat0 + bbox.lat1) / 2, (bbox.lon0 + bbox.lon1) / 2, 1.0 + Math.max(0.08, (bbox.lat1 - bbox.lat0) * 0.05));
  emit("regional:built", { source: grid.source, W: grid.W, H: grid.H });
  return grid;
}

function makePatch(grid) {
  if (R.patch) { G.ovl.remove(R.patch); R.patch.geometry.dispose(); R.patch.material.dispose(); }
  const { bbox, W, H } = grid;
  R.canvas = document.createElement("canvas");
  R.canvas.width = W; R.canvas.height = H;
  R.tex = new THREE.CanvasTexture(R.canvas);
  R.tex.colorSpace = THREE.NoColorSpace;
  R.tex.magFilter = THREE.LinearFilter;
  const phiStart = ((bbox.lon0 + 180) / 360) * Math.PI * 2, phiLen = ((bbox.lon1 - bbox.lon0) / 360) * Math.PI * 2;
  const thStart = (90 - bbox.lat1) * DEG, thLen = (bbox.lat1 - bbox.lat0) * DEG;
  const geo = new THREE.SphereGeometry(1.0026, Math.min(256, W), Math.min(256, H), phiStart, phiLen, thStart, thLen);
  // place the patch on the ellipsoid at the lat/lon of each vertex (sphere UVs span the whole globe)
  { const pos = geo.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const lat = Math.asin(v.y / v.length()) / DEG, lon = (Math.atan2(v.z, -v.x) / DEG + 360) % 360 - 180; ll2v(lat, lon, 1.0026, v); pos.setXYZ(i, v.x, v.y, v.z); }
    pos.needsUpdate = true; geo.computeBoundingSphere(); }
  R.patch = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: R.tex, transparent: true, depthWrite: false }));
  R.patch.renderOrder = 2;
  G.ovl.add(R.patch);
  // terrain base: hillshade from the high-resolution grid
  const g = R.canvas.getContext("2d");
  const img = g.createImageData(W, H);
  const { z, ocean, dxRow, dy } = grid;
  R.base = new Uint8ClampedArray(W * H * 4);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, o = k * 4;
    if (ocean[k]) { R.base.set([0, 0, 0, 0], o); continue; } // open sea: let the globe show through
    const zl = z[j * W + Math.max(0, i - 1)], zr = z[j * W + Math.min(W - 1, i + 1)], zt = z[Math.max(0, j - 1) * W + i], zb = z[Math.min(H - 1, j + 1) * W + i];
    const sx = (zr - zl) / (2 * dxRow[j]), sy = (zb - zt) / (2 * dy);
    const shade = Math.max(0, Math.min(1, 0.6 - 4 * (sx * 0.7 - sy * 0.7)));
    const e = Math.min(1, Math.max(0, z[k]) / 600);
    R.base.set([40 + 60 * shade + 40 * e, 110 + 110 * shade, 150 + 100 * shade, 235], o);
  }
  img.data.set(R.base);
  g.putImageData(img, 0, 0);
  R.tex.needsUpdate = true;
}

function computeStats(depthAt) {
  const { W, H, dxRow, dy, pop, ocean } = R.grid;
  let km2 = 0, people = 0, dmax = 0;
  for (let j = 0; j < H; j++) {
    const a = (dxRow[j] * dy) / 1e6;
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (ocean[k]) continue;
      const d = depthAt(k);
      if (d > 0.15) { km2 += a; people += pop[k]; if (d > dmax) dmax = d; }
    }
  }
  return { km2, people, dmax };
}

function paint(depthAt) {
  const { W, H, ocean } = R.grid;
  const g = R.canvas.getContext("2d");
  const img = g.createImageData(W, H);
  img.data.set(R.base);
  for (let k = 0; k < W * H; k++) {
    if (ocean[k]) continue;
    const d = depthAt(k);
    if (d <= 0.05) continue;
    const c = depthColor(d), o = k * 4, a = Math.min(1, 0.45 + d * 0.25);
    img.data[o] = img.data[o] * (1 - a) + c[0] * a;
    img.data[o + 1] = img.data[o + 1] * (1 - a) + c[1] * a;
    img.data[o + 2] = img.data[o + 2] * (1 - a) + c[2] * a;
    img.data[o + 3] = 245;
  }
  g.putImageData(img, 0, 0);
  R.tex.needsUpdate = true;
}

function drawEquilibrium() {
  if (!R.grid) return;
  const sea = S.sea + (R.forcing.surge || 0);
  const z = R.grid.z, sp = R.spill;
  const depthAt = (k) => (sp[k] <= sea ? sea - z[k] : 0);
  paint(depthAt);
  R.stats = computeStats(depthAt);
  showStats(`Equilibrium at ${sea.toFixed(1)} m (sea rise + surge held indefinitely)`);
}

function redraw(hArr) {
  if (!R.grid) return;
  if (!hArr) { paint(() => 0); R.stats = { km2: 0, people: 0, dmax: 0 }; showStats(""); return; }
  const depthAt = (k) => hArr[k];
  paint(depthAt);
  R.stats = computeStats(depthAt);
  if (R.stats.people > R.peak.people) R.peak = { ...R.stats, t: R.engine.t };
  const tH = R.engine.t / 3600;
  showStats(`Hour ${tH.toFixed(1)} · sea at boundary ${boundaryLevel(R.engine.t, R.forcing).toFixed(2)} m`);
}

function showStats(line) {
  const s = R.stats || { km2: 0, people: 0, dmax: 0 };
  $("#rgTime").textContent = line;
  $("#rgArea").textContent = fmtKm2(s.km2);
  $("#rgPeople").textContent = fmtPop(s.people);
  $("#rgDepth").textContent = `${s.dmax.toFixed(1)} m`;
}

export function play() {
  if (!R.engine) { toast("Build the terrain first."); return; }
  if (R.mode !== "dynamic") { R.mode = "dynamic"; $("#rgMode").value = "dynamic"; }
  R.running = true;
  $("#rgPlay").textContent = "Pause";
}
export function pause() { R.running = false; $("#rgPlay") && ($("#rgPlay").textContent = "Play"); }
export async function resetSim() { pause(); await R.engine?.reset(); R.lastH = null; R.peak = { people: 0, km2: 0, depth: 0, t: 0 }; redraw(null); }

export function closeRegional() {
  pause();
  R.engine?.dispose(); R.engine = null;
  if (R.patch) { G.ovl.remove(R.patch); R.patch = null; }
  R.grid = null;
  $("#rgPanel").hidden = true;
}

const DURATION_H = 48;
async function tick(dt) {
  if (!R.running || R.busy || !R.engine) return;
  R.busy = true;
  const engine = R.engine;
  try {
    const simSeconds = R.speedH * 3600 * Math.min(dt, 0.1);
    const r = await engine.advance(simSeconds, R.forcing);
    if (engine !== R.engine) return; // a new run replaced this one while it was computing
    R.lastH = r.h;
    if (R.mode !== "dynamic") return; // user switched to equilibrium while this step was running
    redraw(r.h);
    if (R.engine.t / 3600 >= DURATION_H) { pause(); $("#rgStatus").textContent = `Done: peak ${fmtPop(R.peak.people)} people in flooded cells at hour ${(R.peak.t / 3600).toFixed(0)}.`; emit("regional:done", { peak: R.peak }); }
  } catch (e) {
    if (engine === R.engine) { pause(); $("#rgStatus").textContent = `Simulation stopped: ${e.message || e}`; }
  } finally { R.busy = false; }
}

// headless run for the agent: build, simulate `hours`, return peak and final statistics
export async function runSurgeScenario({ lat, lon, surgeM = 3, hours = 36, sea = S.sea }) {
  R.forcing = { ...R.forcing, surge: surgeM, sea, tPeakH: Math.min(12, hours / 3), sigmaH: 4 };
  R.mode = "dynamic";
  $("#rgMode").value = "dynamic";
  $("#rgSurge").value = surgeM;
  $("#rgSurgeVal").textContent = `${surgeM.toFixed(1)} m`;
  await buildHere({ lat, lon }, { maxCells: 192, silent: false });
  await R.engine.reset();
  let peak = { people: 0, km2: 0, dmax: 0, t: 0 };
  const t0 = performance.now();
  while (R.engine.t < hours * 3600 && performance.now() - t0 < 60000) {
    const r = await R.engine.advance(3 * 3600, R.forcing);
    R.lastH = r.h;
    redraw(r.h);
    if (R.stats.people >= peak.people) peak = { ...R.stats, t: R.engine.t };
  }
  const simulatedHours = Math.round(R.engine.t / 3600);
  return { grid: `${R.grid.W}x${R.grid.H} cells of ~${Math.round(R.grid.cellM)} m`, terrain: R.grid.source, engine: R.engine.kind, surgeM, seaRiseM: sea, hours: simulatedHours, ...(simulatedHours < hours ? { note: `stopped after ${simulatedHours} of ${hours} simulated hours (1 minute time limit)` } : {}), peakHour: Math.round(peak.t / 3600), peakFloodedKm2: Math.round(peak.km2), peakPeopleInFloodedCells: Math.round(peak.people), peakMaxDepthM: +peak.dmax.toFixed(2), finalFloodedKm2: Math.round(R.stats.km2) };
}
