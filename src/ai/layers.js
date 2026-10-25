// Dynamic layer composition. The AI (or a peer) sends GeoJSON + a style spec, or asks for a
// data-derived layer computed from the DEM / flood model / city table. Polygons and gradients
// are rasterised onto the globe; points and lines become 3D objects with labels.
import * as THREE from "three";
import { group, clearGroup, sprite, disc, tube, arc, label, removeLabels, Raster, rasterPath } from "../globe/overlays.js";
import { DEM } from "../data/dem.js";
import { Flood } from "../sim/flood.js";
import { CITIES, COUNTRIES } from "../data/places.js";
import { pointInPoly, unwrapPoly, circlePoly } from "../util/geo.js";

export const Layers = { g: null, list: new Map() };

export function initLayers() {
  Layers.g = group("ai-layers");
}

const PALETTES = {
  risk: ["#2ad3a0", "#f5e663", "#ffb547", "#ff6a3d", "#ff2e63"],
  heat: ["#3b1c71", "#a02c7a", "#e8534b", "#ffb547", "#fff3a0"],
  cool: ["#0b3a5a", "#1677a8", "#3fb8e0", "#9be3ff", "#ffffff"],
  depth: ["#ffe08a", "#ffb547", "#ff7a2e", "#e0402a", "#8f1d3b"],
};

function lerpColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const n = stops.length - 1, i = Math.min(n - 1, Math.floor(t * n)), k = t * n - i;
  const a = new THREE.Color(stops[i]), b = new THREE.Color(stops[i + 1]);
  return a.lerp(b, k);
}

function colorFor(style, props) {
  const by = style?.colorBy;
  if (by && props && props[by.property] != null) {
    const v = +props[by.property];
    if (Array.isArray(by.stops) && by.stops.length) {
      let c = by.stops[0][1];
      for (const [val, col] of by.stops) if (v >= val) c = col;
      return c;
    }
    const [lo, hi] = by.domain || [0, 1];
    return "#" + lerpColor(PALETTES[by.palette] || PALETTES.risk, (v - lo) / (hi - lo || 1)).getHexString();
  }
  return style?.fill || style?.color || "#62d6ff";
}

function toRing(coords) {
  return coords.map(([lon, lat]) => ({ lat, lon }));
}

export function clearLayers(prefix = "") {
  for (const [id, L] of [...Layers.list]) {
    if (!id.startsWith(prefix)) continue;
    clearGroup(L.g);
    removeLabels(L.g);
    Layers.g.remove(L.g);
    Raster.remove("layer:" + id);
    Layers.list.delete(id);
  }
}

// geojson: FeatureCollection | Feature | Geometry
export function showGeoJSON(id, geojson, style = {}, title = "") {
  clearLayers(id);
  const g = new THREE.Group();
  Layers.g.add(g);
  const feats = geojson.type === "FeatureCollection" ? geojson.features : geojson.type === "Feature" ? [geojson] : [{ type: "Feature", properties: {}, geometry: geojson }];
  const polys = [];
  let n = 0;
  for (const f of feats || []) {
    const geom = f?.geometry;
    if (!geom) continue;
    const props = f.properties || {};
    const col = colorFor(style, props);
    const name = style.labelProperty ? props[style.labelProperty] : props.label || props.name;
    if (geom.type === "Point") {
      const [lon, lat] = geom.coordinates;
      const c3 = new THREE.Color(col).getHex();
      g.add(sprite(lat, lon, { color: c3, size: 0.04 }));
      const rk = props.radiusKm ?? style.radiusKm;
      if (rk) g.add(disc(lat, lon, rk, { color: c3, opacity: (style.opacity ?? 0.5) * (props.intensity ?? 1) }));
      if (name) label(lat, lon, `${esc(name)}${props.note ? `<small>${esc(props.note)}</small>` : ""}`, style.labelClass || "", g);
      n++;
    } else if (geom.type === "LineString" || geom.type === "MultiLineString") {
      const lines = geom.type === "LineString" ? [geom.coordinates] : geom.coordinates;
      for (const ln of lines) {
        const pts = toRing(ln);
        const c3 = new THREE.Color(col).getHex();
        const m = pts.length === 2 ? arc(pts[0], pts[1], { color: c3 }) : tube(pts, { color: c3 });
        if (m) g.add(m);
        if (pts.length === 2) g.add(sprite(pts[1].lat, pts[1].lon, { color: c3, size: 0.035 }));
        if (name) { const mid = pts[Math.floor(pts.length / 2)]; label(mid.lat, mid.lon, esc(name), "", g); }
      }
      n++;
    } else if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
      const ps = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      for (const p of ps) polys.push({ rings: p.map(toRing), col, props });
      if (name) {
        const r = toRing(ps[0][0]);
        let la = 0, lo = 0;
        const u = unwrapPoly(r);
        for (const q of u) { la += q.lat; lo += q.lon; }
        label(la / u.length, lo / u.length, esc(name), "", g);
      }
      n++;
    }
  }
  if (polys.length) {
    const op = style.opacity ?? 0.45, stroke = style.stroke;
    Raster.set("layer:" + id, (ctx, W, H) => {
      for (const p of polys) {
        ctx.beginPath();
        for (const r of p.rings) rasterPath(ctx, r, W, H);
        ctx.globalAlpha = op;
        ctx.fillStyle = p.col;
        ctx.fill("evenodd");
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = stroke || p.col;
        ctx.stroke();
      }
    });
  }
  Layers.list.set(id, { g, title, count: n });
  return n;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// ---- data-derived layers -----------------------------------------------------------------
// kind: "lowland" (land below maxElev, gradient by elevation), "flood" (cells flooded at sea,
// gradient by depth), "elevation", "population" (cities sized by population), "countries"
export function showDataLayer(id, { kind, area, maxElev = 10, sea = 2, palette, minPop = 100000 }) {
  clearLayers(id);
  const g = new THREE.Group();
  Layers.g.add(g);
  const poly = area ? unwrapPoly(area) : null;
  const inArea = (lat, lon) => !poly || pointInPoly({ lat, lon }, poly);
  let summary = {};
  if (kind === "population") {
    let n = 0, total = 0;
    for (const c of CITIES) {
      if (c.pop < minPop || !inArea(c.lat, c.lon)) continue;
      const r = Math.sqrt(c.pop / 1e6) * 35;
      g.add(disc(c.lat, c.lon, Math.max(8, r), { color: 0x62d6ff, opacity: 0.55 }));
      if (n < 12) label(c.lat, c.lon, `${esc(c.name)}<small>${(c.pop / 1e6).toFixed(2)} M</small>`, "city", g);
      n++; total += c.pop;
    }
    summary = { cities: n, population: total };
  } else if (kind === "countries") {
    Raster.set("layer:" + id, (ctx, W, H) => {
      ctx.strokeStyle = "rgba(160,225,255,0.75)";
      ctx.lineWidth = 1;
      for (const c of COUNTRIES) for (const r of c.rings) { ctx.beginPath(); rasterPath(ctx, r, W, H); ctx.stroke(); }
    });
    summary = { countries: COUNTRIES.length };
  } else {
    const { W, H, elev, cls } = DEM;
    const spill = Flood.spill;
    const pal = PALETTES[palette || (kind === "flood" ? "depth" : kind === "elevation" ? "cool" : kind === "density" || kind === "exposure" ? "heat" : "risk")];
    const img = new ImageData(W, H);
    const bb = poly ? bboxPx(poly, W, H) : { x0: 0, x1: W - 1, y0: 0, y1: H - 1 };
    let cells = 0, km2 = 0, people = 0;
    for (let y = bb.y0; y <= bb.y1; y++) {
      const lat = 90 - ((y + 0.5) / H) * 180;
      const ra = DEM.rowArea[y];
      for (let xx = bb.x0; xx <= bb.x1; xx++) {
        const x = ((xx % W) + W) % W, i = y * W + x;
        if (cls[i] !== 255) continue;
        const lon = ((xx + 0.5) / W) * 360 - 180;
        if (poly && !pointInPoly({ lat, lon }, poly)) continue;
        let t;
        if (kind === "density") { const pp = DEM.pop[i]; if (pp < 50) continue; t = Math.min(1, Math.log10(pp) / 6.5); }
        else if (kind === "exposure") { if (!spill || spill[i] > sea || DEM.pop[i] < 100) continue; t = Math.min(1, Math.log10(DEM.pop[i]) / 6.5); }
        else if (kind === "lowland") { if (elev[i] > maxElev) continue; t = 1 - elev[i] / maxElev; }
        else if (kind === "flood") { if (!spill || spill[i] > sea) continue; t = Math.min(1, (sea - elev[i]) / Math.max(1, sea)); }
        else { t = Math.min(1, Math.max(0, elev[i]) / 4000); }
        const c = lerpColor(pal, t);
        const o = (y * W + x) * 4;
        img.data[o] = c.r * 255; img.data[o + 1] = c.g * 255; img.data[o + 2] = c.b * 255; img.data[o + 3] = 200;
        cells++; km2 += ra; people += DEM.pop[i];
      }
    }
    const tmp = document.createElement("canvas");
    tmp.width = W; tmp.height = H;
    tmp.getContext("2d").putImageData(img, 0, 0);
    Raster.set("layer:" + id, (ctx) => ctx.drawImage(tmp, 0, 0));
    summary = { cells, areaKm2: Math.round(km2), people: Math.round(people) };
  }
  Layers.list.set(id, { g, title: kind, count: 1 });
  return summary;
}

function bboxPx(poly, W, H) {
  let a = 90, b = -90, c = 1e9, d = -1e9;
  for (const p of poly) { a = Math.min(a, p.lat); b = Math.max(b, p.lat); c = Math.min(c, p.lon); d = Math.max(d, p.lon); }
  return { y0: Math.max(0, Math.floor(((90 - b) / 180) * H)), y1: Math.min(H - 1, Math.ceil(((90 - a) / 180) * H)), x0: Math.floor(((c + 180) / 360) * W), x1: Math.ceil(((d + 180) / 360) * W) };
}

export function areaFromSpec(spec, region) {
  if (!spec || spec === "selected") return region?.poly || null;
  if (spec.lat != null && spec.lon != null) return circlePoly({ lat: spec.lat, lon: spec.lon }, spec.radiusKm || 150);
  return null;
}
