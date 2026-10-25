// Geo-anchored 3D overlays (markers, discs, tracks, labels) and the raster overlay canvas
// used for GeoJSON polygons and data gradients draped on the globe.
import * as THREE from "three";
import { G, project, onFrame } from "./scene.js";
import { ll2v, R_EARTH, unwrapLon } from "../util/geo.js";

function makeTex(draw, size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}
export const TEX = {
  glow: makeTex((g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(0.22, "rgba(255,255,255,.7)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  }),
  soft: makeTex((g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, "rgba(255,255,255,.95)");
    r.addColorStop(0.6, "rgba(255,255,255,.45)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  }),
  ring: makeTex((g, s) => {
    g.strokeStyle = "rgba(255,255,255,1)";
    g.lineWidth = s * 0.04;
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.45, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "rgba(255,255,255,.12)";
    g.fill();
  }, 256),
  storm: makeTex((g, s) => {
    g.translate(s / 2, s / 2);
    for (let arm = 0; arm < 4; arm++) {
      g.rotate(Math.PI / 2);
      g.beginPath();
      for (let i = 0; i < 80; i++) {
        const a = i * 0.06, r = 4 + i * 1.45;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.strokeStyle = "rgba(255,255,255,.9)";
      g.lineWidth = 7;
      g.lineCap = "round";
      g.stroke();
    }
    const r = g.createRadialGradient(0, 0, 0, 0, 0, 18);
    r.addColorStop(0, "rgba(0,0,0,1)");
    r.addColorStop(1, "rgba(0,0,0,0)");
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = r;
    g.fillRect(-18, -18, 36, 36);
  }, 256),
};

export function group(name) {
  const g = new THREE.Group();
  g.name = name;
  G.ovl.add(g);
  return g;
}

export function clearGroup(g) {
  for (const c of [...g.children]) {
    g.remove(c);
    c.traverse?.((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
  }
}

export function sprite(lat, lon, { color = 0x62d6ff, size = 0.045, tex = TEX.glow, r = 1.012, opacity = 1 } = {}) {
  const m = new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  ll2v(lat, lon, r, s.position);
  return s;
}

// flat disc tangent to the sphere, radius in km
export function disc(lat, lon, radiusKm, { color = 0xffb547, opacity = 0.5, tex = TEX.soft, lift = 1.004 } = {}) {
  const ang = Math.min(1.2, radiusKm / R_EARTH);
  const size = 2 * Math.sin(ang);
  const m = new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), m);
  const n = ll2v(lat, lon, 1);
  mesh.position.copy(n).multiplyScalar(lift);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n.normalize());
  return mesh;
}

export function tube(points, { color = 0x62d6ff, radius = 0.0035, closed = false, opacity = 0.95, r = 1.006 } = {}) {
  if (points.length < 2) return null;
  const vs = points.map((p) => (p.isVector3 ? p : ll2v(p.lat, p.lon, p.r ?? r)));
  const curve = new THREE.CatmullRomCurve3(vs, closed, "centripetal");
  const geo = new THREE.TubeGeometry(curve, Math.min(600, vs.length * 4), radius, 6, closed);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}

// great-circle arc lifted above the surface
export function arc(a, b, { color = 0x62d6ff, lift = 0.12, radius = 0.003 } = {}) {
  const va = ll2v(a.lat, a.lon), vb = ll2v(b.lat, b.lon);
  const pts = [];
  const ang = va.angleTo(vb);
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const v = new THREE.Vector3().copy(va).multiplyScalar(Math.sin((1 - t) * ang)).addScaledVector(vb, Math.sin(t * ang)).divideScalar(Math.sin(ang) || 1);
    v.normalize().multiplyScalar(1.006 + Math.sin(Math.PI * t) * lift * Math.min(1, ang));
    pts.push(v);
  }
  return tube(pts, { color, radius });
}

// ---- HTML labels ---------------------------------------------------------------------
const labels = new Set();
export function label(lat, lon, html, cls = "", owner = null) {
  const el = document.createElement("div");
  el.className = "lbl " + cls;
  el.innerHTML = html;
  document.getElementById("labels").append(el);
  const L = { el, lat, lon, owner };
  labels.add(L);
  return L;
}
export function removeLabels(owner) {
  for (const L of [...labels]) if (L.owner === owner) { L.el.remove(); labels.delete(L); }
}
export function moveLabel(L, lat, lon) {
  L.lat = lat;
  L.lon = lon;
}
onFrame(() => {
  for (const L of labels) {
    const vis = L.owner?.visible !== false && L.owner?.parent?.visible !== false;
    const p = vis ? project(L.lat, L.lon) : null;
    if (!p) { L.el.style.display = "none"; continue; }
    L.el.style.display = "";
    L.el.style.left = p.x + "px";
    L.el.style.top = p.y + "px";
    L.el.style.opacity = String(Math.min(1, (p.facing - 0.08) * 5));
  }
});

// ---- raster overlay (equirectangular canvas draped by the shader) ---------------------
export const Raster = {
  layers: new Map(), // id -> draw(ctx, W, H)
  dirty: false,
  set(id, draw) { this.layers.set(id, draw); this.dirty = true; },
  remove(id) { if (this.layers.delete(id)) this.dirty = true; },
  clear(prefix = "") { for (const k of [...this.layers.keys()]) if (k.startsWith(prefix)) this.layers.delete(k); this.dirty = true; },
};
onFrame(() => {
  if (!Raster.dirty) return;
  Raster.dirty = false;
  const c = G.overlayCanvas, g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  for (const draw of Raster.layers.values()) {
    g.save();
    try { draw(g, c.width, c.height); } catch (e) { console.error(e); }
    g.restore();
  }
  G.overlayTex.needsUpdate = true;
});

// draw a lat/lon ring onto the equirectangular canvas, duplicating across the antimeridian
export function rasterPath(g, ring, W, H) {
  if (!ring.length) return;
  const ref = ring[0].lon;
  let prev = ref;
  const pts = ring.map((p) => { const lon = unwrapLon(p.lon, prev); prev = lon; return [((lon + 180) / 360) * W, ((90 - p.lat) / 180) * H]; });
  for (const shift of [-W, 0, W]) {
    g.moveTo(pts[0][0] + shift, pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] + shift, pts[i][1]);
    g.closePath();
  }
}
