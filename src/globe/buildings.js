// 3D buildings from OpenStreetMap at street level. Footprints come per zoom-15 map tile (~1 km) from
// the local server (/api/buildings, cached) or straight from the Overpass API on the static site.
// Each footprint is extruded to its tagged height (or levels x 3.2 m, or a typical height for its
// type) and stood on the streamed terrain, sampled from the same elevation tiles the ground uses.
import * as THREE from "three";
import { G, onFrame, viewCenter } from "./scene.js";
import { ST, terrainTileUrl } from "./stream.js";
import { S } from "../state.js";
import { $, toast } from "../util/dom.js";
import { ll2v, DEG } from "../util/geo.js";
import { OVERPASS, overpassQuery, compactBuildings, tileOf, tileBBox } from "../util/osm.js";

const Z = 15;
const A = 6378137; // equatorial radius, metres (globe units are A)
const SHOW_BELOW = 9 / 6371; // eye altitude in globe units (~9 km)
const MAX_TILES = 40;

export const BL = { on: true, group: null, tiles: new Map(), queue: [], busy: 0, built: 0, buildings: 0, failures: 0, warned: false, mat: null };

export function initBuildings() {
  if (window.claude && !S.local) { BL.on = false; return; } // the published page can't reach outside data
  BL.group = new THREE.Group();
  BL.group.name = "osm-buildings";
  G.globe.add(BL.group);
  BL.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  let t = 0;
  onFrame(() => {
    const now = performance.now();
    if (now - t < 400) return;
    t = now;
    update();
  });
}

export function setBuildings(on) {
  BL.on = on;
  if (BL.group) BL.group.visible = on;
}

function update() {
  const alt = G.dist - 1;
  const show = BL.on && ST.on && ST.ready && alt < SHOW_BELOW;
  BL.group.visible = show;
  attribution(show && BL.buildings > 0);
  if (!show) return;
  const c = viewCenter();
  const t = tileOf(c.lat, c.lon, Z);
  const r = G.tilt > 0.6 && alt < 3 / 6371 ? 2 : 1; // looking toward the horizon: one ring further out
  const want = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) want.push({ x: t.x + dx, y: t.y + dy, d: dx * dx + dy * dy });
  want.sort((a, b) => a.d - b.d);
  for (const w of want) {
    const k = `${w.x}/${w.y}`;
    const tile = BL.tiles.get(k);
    if (tile) { tile.used = performance.now(); continue; }
    BL.tiles.set(k, { state: "queued", used: performance.now(), mesh: null });
    BL.queue.push(w);
  }
  pump();
  evict();
}

function pump() {
  const limit = S.local ? 3 : 1; // the public Overpass servers allow about two requests at a time
  while (BL.busy < limit && BL.queue.length) {
    const w = BL.queue.shift();
    BL.busy++;
    loadTile(w.x, w.y).finally(() => { BL.busy--; pump(); });
  }
}

function evict() {
  if (BL.tiles.size <= MAX_TILES) return;
  const old = [...BL.tiles.entries()].filter(([, t]) => t.state === "ready").sort((a, b) => a[1].used - b[1].used);
  for (const [k, t] of old.slice(0, BL.tiles.size - MAX_TILES)) {
    BL.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    BL.tiles.delete(k);
  }
}

async function fetchFootprints(x, y) {
  if (S.local) {
    const r = await fetch(`/api/buildings/${Z}/${x}/${y}`);
    if (!r.ok) throw new Error(`buildings ${r.status}`);
    return (await r.json()).b;
  }
  const q = overpassQuery(Z, x, y);
  let last;
  for (const ep of OVERPASS) {
    try {
      const r = await fetch(`${ep}?data=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(30000) });
      if (r.ok) return compactBuildings(await r.json());
      last = new Error(`Overpass ${r.status}`);
    } catch (e) { last = e; }
  }
  throw last;
}

async function terrainSampler(x, y) {
  // elevation tile for the same zoom-15 tile; Terrarium encoding: (R*256 + G + B/256) - 32768 m
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = terrainTileUrl(Z, x, y);
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, 256, 256).data;
    const b = tileBBox(Z, x, y);
    const n = 2 ** Z;
    return (lat, lon) => {
      const px = (((lon + 180) / 360) * n - x) * 256;
      const r = lat * DEG;
      const py = (((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - y) * 256;
      const i = (Math.min(255, Math.max(0, Math.floor(py))) * 256 + Math.min(255, Math.max(0, Math.floor(px)))) * 4;
      return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
    };
  } catch {
    return null;
  }
}

async function loadTile(x, y) {
  const k = `${x}/${y}`;
  const tile = BL.tiles.get(k);
  if (!tile) return;
  tile.state = "loading";
  try {
    const [rows, elev] = await Promise.all([fetchFootprints(x, y), terrainSampler(x, y)]);
    if (!BL.tiles.has(k)) return;
    tile.mesh = buildMesh(x, y, rows, elev);
    tile.state = "ready";
    if (tile.mesh) BL.group.add(tile.mesh);
    BL.built++;
    BL.buildings += rows.length;
  } catch (e) {
    BL.failures++;
    tile.state = "failed";
    setTimeout(() => BL.tiles.delete(k), 20000); // try again later
    if (!BL.warned) { BL.warned = true; toast("Building data is busy or unavailable right now; 3D buildings will retry.", 5000); }
    console.warn("buildings", k, e);
  }
}

// Extrude footprints in a local east-north-up frame (metres) anchored at the tile's south-west corner;
// the mesh carries the frame, so vertices stay small and precise.
function buildMesh(x, y, rows, elev) {
  if (!rows.length) return null;
  const b = tileBBox(Z, x, y);
  const lat0 = (b.s + b.n) / 2, lon0 = (b.w + b.e) / 2;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * DEG); // metres per degree at this latitude
  const mLon = 111412.84 * Math.cos(lat0 * DEG);
  const ex = G.exaggeration;
  const pos = [], nor = [], col = [];
  const c = new THREE.Color();
  const v2 = [];
  for (const row of rows) {
    const h = row[0], minH = row[1];
    const n = (row.length - 2) / 2;
    v2.length = 0;
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      const e = (row[3 + i * 2] - lon0) * mLon, nn = (row[2 + i * 2] - lat0) * mLat;
      v2.push(new THREE.Vector2(e, nn));
      cx += row[3 + i * 2]; cy += row[2 + i * 2];
    }
    if (THREE.ShapeUtils.isClockWise(v2)) v2.reverse();
    const ground = elev ? elev(cy / n, cx / n) * ex : 0;
    const z0 = ground + (minH > 0 ? minH : -3); // sink plain buildings a little so sloped ground doesn't show gaps
    const z1 = ground + h;
    // shade: taller and newer-looking buildings a touch lighter, with a little variety
    const k = 0.78 + Math.min(0.14, h / 400) + ((row[2] * 1e5) % 1) * 0.06;
    c.setRGB(0.86 * k, 0.88 * k, 0.92 * k);
    // walls
    for (let i = 0; i < v2.length; i++) {
      const p = v2[i], q = v2[(i + 1) % v2.length];
      const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1;
      const nx = dy / L, ny = -dx / L;
      pos.push(p.x, p.y, z0, q.x, q.y, z0, q.x, q.y, z1, p.x, p.y, z0, q.x, q.y, z1, p.x, p.y, z1);
      for (let j = 0; j < 6; j++) { nor.push(nx, ny, 0); col.push(c.r * 0.9, c.g * 0.9, c.b * 0.9); }
    }
    // roof
    const tris = THREE.ShapeUtils.triangulateShape(v2, []);
    for (const t of tris) for (const j of t) { pos.push(v2[j].x, v2[j].y, z1); nor.push(0, 0, 1); col.push(c.r, c.g, c.b); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, BL.mat);
  // frame: origin on the ellipsoid at the tile centre, axes east / north / up, scale metres -> globe units
  const phi = lat0 * DEG, lam = lon0 * DEG;
  const E = new THREE.Vector3(-Math.sin(lam), 0, -Math.cos(lam));
  const N = new THREE.Vector3(-Math.sin(phi) * Math.cos(lam), Math.cos(phi), Math.sin(phi) * Math.sin(lam));
  const U = new THREE.Vector3(Math.cos(phi) * Math.cos(lam), Math.sin(phi), -Math.cos(phi) * Math.sin(lam));
  const m = new THREE.Matrix4().makeBasis(E, N, U);
  mesh.quaternion.setFromRotationMatrix(m);
  mesh.position.copy(ll2v(lat0, lon0));
  mesh.scale.setScalar(1 / A);
  mesh.frustumCulled = true;
  mesh.userData = { tile: `${x}/${y}`, buildings: rows.length };
  return mesh;
}

function attribution(on) {
  const el = $("#attrib");
  if (!el) return;
  const tag = " · Buildings © OpenStreetMap contributors";
  if (on && !el.textContent.includes(tag)) el.textContent += tag;
  else if (!on && el.textContent.includes(tag)) el.textContent = el.textContent.replace(tag, "");
}
