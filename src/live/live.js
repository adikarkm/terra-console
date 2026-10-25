// Live hazards on the globe (local server): NHC active storms with forecast cones and tracks,
// NASA FIRMS active fires (last 24 h), USGS earthquakes (last 24 h). Refreshes every 10 minutes.
import * as THREE from "three";
import { S, emit } from "../state.js";
import { $, toast } from "../util/dom.js";
import { G } from "../globe/scene.js";
import { group, clearGroup, sprite, label, removeLabels, Raster, rasterPath, tube, TEX } from "../globe/overlays.js";
import { ll2v } from "../util/geo.js";

export const LIVE = { g: null, on: { storms: false, fires: false, quakes: false }, data: {}, timer: 0, firePts: null };

export function initLive() {
  LIVE.g = group("live");
  for (const k of ["storms", "fires", "quakes"]) {
    const el = $(`#lv_${k}`);
    el.addEventListener("change", () => setLive(k, el.checked));
  }
}

async function get(path) {
  const r = await fetch(path, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function setLive(kind, on) {
  LIVE.on[kind] = on;
  if (on && !S.local) {
    toast("Live hazards come through the local server (npm start).");
    $(`#lv_${kind}`).checked = false;
    LIVE.on[kind] = false;
    return;
  }
  if (on) await refresh(kind);
  render();
  clearInterval(LIVE.timer);
  if (Object.values(LIVE.on).some(Boolean)) LIVE.timer = setInterval(() => Object.keys(LIVE.on).forEach((k) => LIVE.on[k] && refresh(k).then(render)), 10 * 60 * 1000);
}

export async function refresh(kind) {
  const st = $("#liveStatus");
  try {
    if (kind === "storms") LIVE.data.storms = await get("/api/live/storms");
    if (kind === "fires") LIVE.data.fires = await get("/api/live/fires");
    if (kind === "quakes") LIVE.data.quakes = await get("/api/live/quakes");
    st.textContent = summary();
  } catch (e) {
    st.textContent = `${kind}: ${e.message}`;
    LIVE.on[kind] = false;
    $(`#lv_${kind}`).checked = false;
  }
  emit("live:data", kind);
}

export function summary() {
  const parts = [];
  if (LIVE.on.storms && LIVE.data.storms) parts.push(`${LIVE.data.storms.storms.length} active storms (NHC)`);
  if (LIVE.on.fires && LIVE.data.fires) parts.push(`${LIVE.data.fires.count.toLocaleString()} fire detections (FIRMS)`);
  if (LIVE.on.quakes && LIVE.data.quakes) parts.push(`${(LIVE.data.quakes.features || []).length} quakes M2.5+ (USGS)`);
  return parts.join(" · ");
}

function render() {
  clearGroup(LIVE.g);
  removeLabels(LIVE.g);
  Raster.clear("live:");
  if (LIVE.on.storms && LIVE.data.storms) {
    for (const s of LIVE.data.storms.storms) {
      const cones = s.cone.filter((f) => f.geometry.type === "Polygon");
      if (cones.length) Raster.set(`live:cone:${s.id}`, (ctx, W, H) => {
        for (const c of cones) { ctx.beginPath(); rasterPath(ctx, c.geometry.coordinates[0].map(([lon, lat]) => ({ lat, lon })), W, H); ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1.5; ctx.stroke(); }
      });
      for (const f of s.track) {
        if (f.geometry.type === "LineString") { const t = tube(f.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })), { color: 0xffffff, radius: 0.0025 }); if (t) LIVE.g.add(t); }
        if (f.geometry.type === "Point") LIVE.g.add(sprite(f.geometry.coordinates[1], f.geometry.coordinates[0], { color: 0xffffff, size: 0.02 }));
      }
      if (Number.isFinite(s.lat)) {
        const sp = sprite(s.lat, s.lon, { color: 0xff6a5f, size: 0.09, tex: TEX.storm });
        LIVE.g.add(sp);
        label(s.lat, s.lon, `${s.classification || ""} ${s.name}<small>${s.windKt ? s.windKt + " kt" : ""}${s.pressureHpa ? " · " + s.pressureHpa + " hPa" : ""} · live NHC</small>`, "heat", LIVE.g);
      }
    }
  }
  if (LIVE.on.fires && LIVE.data.fires) {
    const fs = LIVE.data.fires.fires;
    const pos = new Float32Array(fs.length * 3), col = new Float32Array(fs.length * 3);
    const v = new THREE.Vector3();
    fs.forEach(([lat, lon, frp], i) => {
      ll2v(lat, lon, 1.006, v);
      pos.set([v.x, v.y, v.z], i * 3);
      const k = Math.min(1, Math.log10(1 + frp) / 2.5);
      col.set([1, 0.35 + 0.4 * k, 0.1 * k], i * 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.012, vertexColors: true, map: TEX.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    LIVE.g.add(pts);
  }
  if (LIVE.on.quakes && LIVE.data.quakes) {
    for (const f of LIVE.data.quakes.features || []) {
      const [lon, lat, depth] = f.geometry.coordinates, m = f.properties.mag || 0;
      LIVE.g.add(sprite(lat, lon, { color: depth > 70 ? 0xa78bfa : 0x5eead4, size: 0.01 + m * 0.009, tex: TEX.ring }));
      if (m >= 5.5) label(lat, lon, `M${m.toFixed(1)}<small>${(f.properties.place || "").slice(0, 40)}</small>`, "", LIVE.g);
    }
  }
}
