// Ground view: drop to street level at a coordinate and see the simulation in place.
// Scene sources: (1) a real Gaussian Splat capture the user loads (.ply/.splat/.ksplat/.spz),
// (2) Google Photorealistic 3D Tiles (needs the user's Google Maps Platform API key).
// The simulated flood depth, fire and storm conditions for that spot are drawn on top.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFExtensionsPlugin, ReorientationPlugin } from "3d-tiles-renderer/plugins";
import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";
// the splat renderer (~240 KB) loads only when a capture is opened
const splats = () => import("@mkkellogg/gaussian-splats-3d");
import { S, on } from "../state.js";
import { $, toast } from "../util/dom.js";
import { sampleDEM, demIndex } from "../data/dem.js";
import { nearestCity } from "../data/places.js";
import { Flood } from "../sim/flood.js";
import { haversine, fmtLat, fmtLon, DEG } from "../util/geo.js";
import { r34 } from "../sim/storm.js";

const V = { open: false, renderer: null, scene: null, camera: null, controls: null, tiles: null, splat: null, water: null, rain: null, embers: null, site: null, groundY: 0, clock: new THREE.Clock(), keyOk: false };

function siteFor(p) {
  const nc = nearestCity(p);
  const d = sampleDEM(p.lat, p.lon);
  const useCity = nc && nc.distKm < 15;
  const elev = useCity ? nc.elev : Math.round(d.elev);
  const i = demIndex(p.lat, p.lon);
  const reachable = Flood.spill ? Flood.spill[i] <= Math.max(S.sea, elev) + 0.01 || d.kind !== "land" : true;
  return { ...p, elev, elevSource: useCity ? `${nc.name} centre (city table)` : "20 km DEM cell", place: nc ? `${nc.name}, ${nc.cc}` : "", reachable };
}

function conditions(site) {
  const depth = site.reachable ? Math.max(0, S.sea - site.elev) : 0;
  let fire = false, smoke = false, storm = null;
  for (const ev of S.events) {
    const d = haversine(site, ev);
    if (ev.type === "wildfire" && d < 60) fire = d < 25, smoke = true;
    if (ev.type === "volcano" && d < 400) smoke = true;
  }
  if (S.storm?.track) {
    let best = null, bd = Infinity;
    for (const p of S.storm.track) { const d = haversine(site, p); if (d < bd) { bd = d; best = p; } }
    if (best && bd < r34(best)) storm = { cat: best.cat, distKm: bd, hour: best.t };
  }
  return { depth, fire, smoke, storm };
}

export function initGround() {
  $("#groundClose").addEventListener("click", closeGround);
  $("#splatFile").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) loadSplat(f); });
  $("#tilesGo").addEventListener("click", () => loadTiles($("#gKey").value.trim()));
  $("#gElev").addEventListener("change", () => { if (V.site) { V.site.elev = +$("#gElev").value; V.site.elevSource = "you"; refresh(); } });
  on("sea", () => V.open && refresh());
}

export function openGround(p) {
  if (!p) { toast("Pick a spot first: hover or draw a region, then open ground view."); return; }
  V.site = siteFor(p);
  $("#ground").hidden = false;
  V.open = true;
  if (!V.renderer) setup();
  onResize();
  $("#gWhere").textContent = `${V.site.place ? V.site.place + " · " : ""}${fmtLat(p.lat)} ${fmtLon(p.lon)}`;
  $("#gElev").value = V.site.elev;
  refresh();
  V.renderer.setAnimationLoop(frame);
}

export function closeGround() {
  V.open = false;
  $("#ground").hidden = true;
  V.renderer?.setAnimationLoop(null);
}

function setup() {
  const canvas = $("#groundCanvas");
  V.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  V.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  V.scene = new THREE.Scene();
  V.scene.background = new THREE.Color(0x0a1520);
  V.scene.fog = new THREE.Fog(0x0a1520, 400, 3000);
  V.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 20000);
  V.camera.position.set(22, 11, 26);
  V.controls = new OrbitControls(V.camera, canvas);
  V.controls.target.set(0, 5, 0);
  V.controls.maxPolarAngle = Math.PI * 0.495;
  V.scene.add(new THREE.HemisphereLight(0xcfe9ff, 0x223344, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(300, 500, 200);
  V.scene.add(sun);
  // reference grid so the view reads before any scene is loaded
  const grid = new THREE.GridHelper(400, 40, 0x62d6ff, 0x1d4a66);
  grid.name = "grid";
  V.scene.add(grid);
  // measuring staff at the site: 1 m ticks, labelled every 5 m, so water depth reads directly
  const staff = new THREE.Group();
  staff.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 20, 12).translate(0, 10, 0), new THREE.MeshStandardMaterial({ color: 0xd9f2ff })));
  for (let m = 1; m <= 20; m++) {
    const big = m % 5 === 0;
    const tick = new THREE.Mesh(new THREE.BoxGeometry(big ? 1.6 : 0.8, 0.08, 0.08), new THREE.MeshBasicMaterial({ color: big ? 0xffb547 : 0x62d6ff }));
    tick.position.set(big ? 0.8 : 0.4, m, 0);
    staff.add(tick);
    if (big) {
      const c = document.createElement("canvas"); c.width = 128; c.height = 64;
      const g = c.getContext("2d"); g.fillStyle = "#ffb547"; g.font = "bold 44px sans-serif"; g.fillText(m + " m", 4, 48);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      sp.scale.set(2, 1, 1); sp.position.set(2.6, m, 0);
      staff.add(sp);
    }
  }
  staff.name = "staff";
  V.scene.add(staff);
  // water: wide plane with a gently moving surface
  const wg = new THREE.PlaneGeometry(6000, 6000, 120, 120);
  wg.rotateX(-Math.PI / 2);
  V.water = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ color: 0x3a8fb0, transparent: true, opacity: 0.72, roughness: 0.15, metalness: 0.1 }));
  V.water.visible = false;
  V.scene.add(V.water);
  V.rain = particles(5000, 0x9fc9e8, 0.6, 400, 300);
  V.embers = particles(1500, 0xff7a2e, 1.6, 300, 120);
  window.addEventListener("resize", onResize);
}

function particles(n, color, size, spread, height) {
  const g = new THREE.BufferGeometry();
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) p.set([(Math.random() - 0.5) * spread * 2, Math.random() * height, (Math.random() - 0.5) * spread * 2], i * 3);
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.8, depthWrite: false }));
  pts.visible = false;
  pts.userData = { spread, height };
  V.scene.add(pts);
  return pts;
}

function onResize() {
  if (!V.renderer) return;
  const c = V.renderer.domElement, w = c.clientWidth || innerWidth, h = c.clientHeight || innerHeight;
  V.renderer.setSize(w, h, false);
  V.camera.aspect = w / h;
  V.camera.updateProjectionMatrix();
}

function refresh() {
  const c = conditions(V.site);
  V.cond = c;
  V.water.visible = c.depth > 0;
  V.water.position.y = (V.groundY || 0) + c.depth;
  V.scene.getObjectByName("staff").position.y = V.groundY || 0;
  V.rain.visible = !!c.storm;
  V.embers.visible = c.fire;
  const fogCol = c.smoke ? 0x5a4a40 : c.storm ? 0x2a3540 : 0x0a1520;
  V.scene.fog.color.setHex(fogCol);
  V.scene.fog.near = c.smoke || c.storm ? 60 : 400;
  V.scene.fog.far = c.smoke ? 700 : c.storm ? 1200 : 3000;
  const lines = [];
  lines.push(c.depth > 0 ? `Water ${c.depth.toFixed(1)} m deep at +${S.sea.toFixed(1)} m sea level` : S.sea > 0 ? (V.site.reachable ? `Dry at +${S.sea.toFixed(1)} m (ground ${V.site.elev} m)` : `Protected: the sea can't reach this basin at +${S.sea.toFixed(1)} m`) : "No sea level rise set");
  if (c.storm) lines.push(`${c.storm.cat >= 1 ? "Cat " + c.storm.cat : "Tropical storm"} passes ${Math.round(c.storm.distKm)} km away at hour ${c.storm.hour}`);
  if (c.fire) lines.push("Inside the wildfire zone");
  else if (c.smoke) lines.push("Downwind smoke or ash");
  $("#gCond").textContent = lines.join(" · ");
  $("#gElevSrc").textContent = `Ground elevation from ${V.site.elevSource}. Edit it if you know the local value.`;
}

async function loadSplat(file) {
  try {
    if (V.splat) { V.scene.remove(V.splat); V.splat.dispose?.(); }
    const ext = file.name.toLowerCase().split(".").pop();
    $("#gStatus").textContent = "Loading the splat renderer…";
    const { DropInViewer, SceneFormat } = await splats();
    const format = { ply: SceneFormat.Ply, splat: SceneFormat.Splat, ksplat: SceneFormat.KSplat, spz: SceneFormat.Spz }[ext];
    if (format == null) { toast("Use a .ply, .splat, .ksplat or .spz Gaussian Splat file."); return; }
    V.splat = new DropInViewer({ sharedMemoryForWorkers: false, gpuAcceleratedSort: false });
    V.scene.add(V.splat);
    const url = URL.createObjectURL(file);
    $("#gStatus").textContent = `Loading ${file.name}…`;
    await V.splat.addSplatScene(url, { format, showLoadingUI: false, splatAlphaRemovalThreshold: 5, rotation: [1, 0, 0, 0] });
    V.scene.getObjectByName("grid").visible = false;
    V.groundY = 0;
    V.camera.position.set(6, 3, 6);
    V.controls.target.set(0, 0, 0);
    V.scene.fog.near *= 0.05; V.scene.fog.far *= 0.05;
    V.water.scale.setScalar(0.02);
    $("#gStatus").textContent = `${file.name} loaded. Capture origin is treated as ground level at this coordinate; water is drawn at the simulated depth.`;
    refresh();
  } catch (e) {
    $("#gStatus").textContent = `Couldn't load the splat: ${e.message || e}`;
  }
}

async function loadTiles(key) {
  if (!key) { toast("Enter a Google Maps Platform API key with the Map Tiles API enabled."); return; }
  try {
    if (V.tiles) { V.scene.remove(V.tiles.group); V.tiles.dispose(); }
    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }));
    const draco = new DRACOLoader().setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.registerPlugin(new ReorientationPlugin({ lat: V.site.lat * DEG, lon: V.site.lon * DEG, height: 0, recenter: true }));
    tiles.setCamera(V.camera);
    tiles.setResolutionFromRenderer(V.camera, V.renderer);
    V.scene.add(tiles.group);
    V.tiles = tiles;
    V.scene.getObjectByName("grid").visible = false;
    $("#gStatus").textContent = "Streaming Google Photorealistic 3D Tiles…";
    V.groundY = null; // found by raycasting once tiles load
    V.camera.position.set(250, 180, 250);
    tiles.addEventListener("load-model", () => { if (V.groundY == null) findGround(); });
  } catch (e) {
    $("#gStatus").textContent = `3D Tiles failed: ${e.message || e}`;
  }
}

const down = new THREE.Raycaster();
function findGround() {
  down.set(new THREE.Vector3(0, 5000, 0), new THREE.Vector3(0, -1, 0));
  const hit = down.intersectObject(V.tiles.group, true)[0];
  if (!hit) return;
  V.groundY = hit.point.y;
  V.controls.target.set(0, V.groundY, 0);
  $("#gStatus").textContent = "Photorealistic 3D Tiles © Google. Water height = local ground + simulated depth.";
  refresh();
}

function frame() {
  const dt = Math.min(0.05, V.clock.getDelta()), t = V.clock.elapsedTime;
  V.controls.update();
  if (V.tiles) { V.camera.updateMatrixWorld(); V.tiles.update(); }
  if (V.water.visible) {
    const pos = V.water.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, Math.sin(pos.getX(i) * 0.02 + t * 1.3) * 0.25 + Math.cos(pos.getZ(i) * 0.025 + t) * 0.2);
    pos.needsUpdate = true;
    V.water.geometry.computeVertexNormals();
  }
  for (const [ps, vy] of [[V.rain, -120], [V.embers, 18]]) {
    if (!ps.visible) continue;
    const p = ps.geometry.attributes.position, { spread, height } = ps.userData;
    const g = V.groundY || 0;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) + vy * dt * (0.6 + (i % 7) / 10);
      let x = p.getX(i) + (vy < 0 ? 25 : Math.sin(t + i)) * dt;
      if (y < g) y = g + height; else if (y > g + height) y = g;
      if (x > spread) x = -spread;
      p.setXYZ(i, x, y, p.getZ(i));
    }
    p.needsUpdate = true;
  }
  V.renderer.render(V.scene, V.camera);
}
