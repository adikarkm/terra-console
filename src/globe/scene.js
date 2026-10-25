// Three.js scene: holographic globe, atmosphere, console rings, starfield, camera control.
import * as THREE from "three";
import EARTH_URL from "../../assets/earth.webp";
import EARTH_PREVIEW from "../../assets/earth-1k.webp?inline"; // 44 KB, shown while the 4096 px image streams in
import { DEM } from "../data/dem.js";
import { ll2v, v2ll, DEG, geometryToEllipsoid } from "../util/geo.js";
import { S, emit } from "../state.js";

export const G = {
  renderer: null,
  scene: null,
  camera: null,
  root: null, // positioned/scaled container (moved in XR)
  globe: null, // rotated container: everything geo-anchored lives here
  earth: null,
  uniforms: null,
  rotX: 0.38,
  rotY: -1.2,
  dist: 3.2,
  tilt: 0, // radians from straight down; only allowed close to the ground
  minAlt: 0.00006, // ~400 m, raised over high terrain
  exaggeration: 1,
  autoSpin: true,
  fly: null,
  frameHooks: new Set(),
  floodTex: null,
  overlayTex: null,
  overlayCanvas: null,
  clock: new THREE.Clock(),
};

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D dayTex; uniform sampler2D altTex; uniform sampler2D floodTex; uniform sampler2D overlayTex;
uniform float uHolo; uniform float uTime; uniform float uSea; uniform float uFloodVis;
uniform float uSplit; uniform float uAltOn; uniform vec2 uRes; uniform vec3 uCam; uniform vec3 uLight; uniform float uGrid;
varying vec2 vUv; varying vec3 vN; varying vec3 vW;

float gridLine(float v, float n){ float x = v * n; float d = abs(fract(x - 0.5) - 0.5) / max(fwidth(x), 1e-4); return 1.0 - min(d, 1.0); }

void main(){
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vN);
  vec3 V = normalize(uCam - vW);
  float ndv = max(dot(n, V), 0.0);
  float fres = pow(1.0 - ndv, 2.4);

  vec3 day = texture2D(dayTex, vUv).rgb;
  // time-travel swipe: screen-space split between the base and the comparison image
  if (uAltOn > 0.5) {
    vec3 alt = texture2D(altTex, vUv).rgb;
    float sx = gl_FragCoord.x / uRes.x;
    day = sx < uSplit ? alt : day;
  }
  vec4 fl = texture2D(floodTex, vec2(vUv.x, 1.0 - vUv.y)); // r = spill level, g = elevation, b = class
  float land = step(0.75, fl.b);
  float lum = dot(day, vec3(0.3, 0.59, 0.11));

  // true colour, lit from the viewer's upper left
  float diff = max(dot(n, normalize(uLight)), 0.0);
  vec3 tc = day * (0.30 + 0.85 * diff);

  // hologram: luminance-mapped cyan land over deep navy sea, graticule and scanlines
  vec3 holoLand = vec3(0.22, 0.72, 1.0) * (0.28 + lum * 1.4);
  vec3 holoSea = vec3(0.015, 0.06, 0.12) + vec3(0.0, 0.08, 0.16) * lum;
  vec3 holo = mix(holoSea, holoLand, step(0.25, fl.b));
  float g = max(gridLine(vUv.x, 24.0), gridLine(vUv.y, 12.0));
  holo += vec3(0.25, 0.65, 0.9) * g * 0.28 * uGrid;
  holo *= 0.93 + 0.07 * sin(gl_FragCoord.y * 1.1 + uTime * 3.0);
  vec3 col = mix(tc, holo, uHolo);

  // flood: cells whose Priority-Flood spill level is at or below the sea
  float flooded = land * step(fl.r, uSea) * step(0.001, uSea) * uFloodVis;
  float depth = clamp((uSea - fl.g) / 6.0, 0.0, 1.0);
  float shimmer = 0.78 + 0.22 * sin(uTime * 2.2 + vUv.x * 1400.0 + vUv.y * 900.0);
  vec3 fc = mix(vec3(1.0, 0.72, 0.30), vec3(1.0, 0.45, 0.10), depth) * shimmer;
  col = mix(col, fc, flooded * 0.88);

  // AI / data layers rasterised onto the globe
  vec4 ov = texture2D(overlayTex, vUv);
  col = mix(col, ov.rgb, ov.a);

  col += vec3(0.35, 0.8, 1.0) * fres * (0.45 + 0.5 * uHolo) * uGrid;
  gl_FragColor = vec4(col, 1.0);
}`;

const ATMO_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uAtmo;
varying vec3 vNV;
void main(){
  #include <logdepthbuf_fragment>
  float i = pow(clamp(0.72 - dot(vNV, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 2.6);
  gl_FragColor = vec4(vec3(0.35, 0.78, 1.0) * i * 1.6 * uAtmo, i * uAtmo);
}`;
const ATMO_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vNV;
void main(){ vNV = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

export function initScene(canvas) {
  // logarithmic depth: the camera spans ~20,000 km down to a few hundred metres above the ground
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance", logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.xr.enabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03080f);
  const camera = new THREE.PerspectiveCamera(38, 1, 1e-6, 400);
  camera.position.set(0, 0, G.dist);
  scene.add(camera);

  const root = new THREE.Group();
  const globe = new THREE.Group();
  root.add(globe);
  scene.add(root);
  // overlays (markers, tracks, particles) live in their own group so they can hug the ground
  // when the camera is close
  const ovl = new THREE.Group();
  ovl.name = "overlays";
  globe.add(ovl);
  // lights for the streamed terrain tiles (the base globe uses its own shader lighting)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-0.6, 0.55, 1);
  camera.add(sun);

  // flood texture: half floats, R = spill level, G = elevation, B = class, A = 1
  const { W, H, elev, cls } = DEM;
  const data = new Uint16Array(W * H * 4);
  const one = THREE.DataUtils.toHalfFloat(1);
  const big = THREE.DataUtils.toHalfFloat(60000);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = big; // until the Priority-Flood result arrives nothing floods
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(Math.max(-500, Math.min(9000, elev[i])));
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(cls[i] / 255);
    data[i * 4 + 3] = one;
  }
  const floodTex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  floodTex.magFilter = THREE.LinearFilter; // smooth flood contours between 20 km cells
  floodTex.minFilter = THREE.LinearFilter;
  floodTex.needsUpdate = true;

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = 2048;
  overlayCanvas.height = 1024;
  const overlayTex = new THREE.CanvasTexture(overlayCanvas);
  overlayTex.colorSpace = THREE.NoColorSpace;

  const loader = new THREE.TextureLoader();
  const dayTex = loader.load(EARTH_PREVIEW);
  dayTex.colorSpace = THREE.NoColorSpace;
  dayTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // swap in the full-resolution image when it arrives (same texture object, so every user updates)
  const full = new Image();
  full.decoding = "async";
  full.onload = () => { dayTex.image = full; dayTex.needsUpdate = true; G.earthFull = true; };
  full.src = EARTH_URL;

  const uniforms = {
    dayTex: { value: dayTex },
    altTex: { value: dayTex },
    floodTex: { value: floodTex },
    overlayTex: { value: overlayTex },
    uHolo: { value: 1 },
    uTime: { value: 0 },
    uSea: { value: 0 },
    uFloodVis: { value: 0 },
    uSplit: { value: 0.5 },
    uAltOn: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uCam: { value: new THREE.Vector3() },
    uLight: { value: new THREE.Vector3(-0.6, 0.55, 1) },
    uGrid: { value: 1 },
  };
  const earth = new THREE.Mesh(
    geometryToEllipsoid(new THREE.SphereGeometry(1, 512, 256)),
    new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG })
  );
  earth.name = "earth";
  globe.add(earth);

  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 64, 48),
    new THREE.ShaderMaterial({ uniforms: { uAtmo: { value: 1 } }, vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG, side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })
  );
  root.add(atmo);

  // console rings: thin orbit lines with tick marks, slowly counter-rotating
  const rings = new THREE.Group();
  const ringMat = new THREE.LineBasicMaterial({ color: 0x62d6ff, transparent: true, opacity: 0.22 });
  for (const [r, tilt] of [[1.28, 0.42], [1.36, -0.3], [1.5, 1.2]]) {
    const pts = [];
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), ringMat);
    const ticks = [];
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2, l = i % 6 === 0 ? 0.05 : 0.02;
      ticks.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), new THREE.Vector3(Math.cos(a) * (r + l), 0, Math.sin(a) * (r + l)));
    }
    ring.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), ringMat));
    ring.rotation.x = tilt;
    ring.userData.speed = (Math.random() * 0.5 + 0.2) * (tilt > 0 ? 1 : -1) * 0.05;
    rings.add(ring);
  }
  root.add(rings);

  // stars
  const starGeo = new THREE.BufferGeometry();
  const sp = new Float32Array(3000 * 3);
  for (let i = 0; i < 3000; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 40);
    sp.set([v.x, v.y, v.z], i * 3);
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x9fd8ff, size: 0.12, transparent: true, opacity: 0.55, depthWrite: false })));

  Object.assign(G, { renderer, scene, camera, root, globe, ovl, earth, atmo, uniforms, floodTex, overlayTex, overlayCanvas, rings });
  window.addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop(frame);
  return G;
}

function resize() {
  const { renderer, camera } = G;
  const w = renderer.domElement.clientWidth || innerWidth, h = renderer.domElement.clientHeight || innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  G.uniforms.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
}

export function setFloodSpill(spill) {
  const d = G.floodTex.image.data;
  const toH = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < spill.length; i++) d[i * 4] = toH(spill[i] > 60000 ? 60000 : spill[i]);
  G.floodTex.needsUpdate = true;
}

export function onFrame(fn) {
  G.frameHooks.add(fn);
  return () => G.frameHooks.delete(fn);
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _up = new THREE.Vector3(0, 1, 0);
const _tgt = new THREE.Vector3();

// Camera looks at the surface point facing it (0,0,1); tilt swings it south so it looks north
// toward the horizon. Near plane follows altitude so close views keep depth precision.
const _c = new THREE.Vector3();
function placeCamera(alt) {
  // the ellipsoid surface under the view centre (up to 21 km lower at the poles)
  G.globe.updateMatrixWorld();
  ll2v(viewLatFast(), 0, 1, _c);
  const rs = _c.length();
  const maxTilt = alt < 0.002 ? 1.35 : alt < 0.03 ? 1.35 * (1 - (alt - 0.002) / 0.028) : 0;
  G.tilt = Math.min(G.tilt, Math.max(0, maxTilt));
  const t = G.tilt;
  G.camera.position.set(0, -alt * Math.sin(t), rs + alt * Math.cos(t));
  _tgt.set(0, 0, rs);
  G.camera.up.copy(_up);
  if (t > 1e-4) G.camera.lookAt(_tgt);
  else G.camera.rotation.set(0, 0, 0);
  const near = Math.max(1e-7, alt * 0.15);
  const far = alt > 0.5 ? 400 : Math.max(0.5, alt * 60 + 1.5);
  if (Math.abs(G.camera.near - near) / near > 0.05 || G.camera.far !== far) {
    G.camera.near = near;
    G.camera.far = far;
    G.camera.updateProjectionMatrix();
  }
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function frame(time, xrFrame) {
  const dt = Math.min(0.05, G.clock.getDelta());
  const t = G.clock.elapsedTime;
  if (G.fly) {
    const f = G.fly;
    f.t = Math.min(1, (performance.now() - f.start) / (f.dur * 1000)); // wall clock, so slow frames don't slow the flight
    const e = ease(f.t);
    G.rotX = f.x0 + (f.x1 - f.x0) * e;
    G.rotY = f.y0 + (f.y1 - f.y0) * e;
    G.dist = f.d0 + (f.d1 - f.d0) * e;
    if (f.t >= 1) G.fly = null;
  } else if (G.autoSpin) {
    G.rotY += dt * 0.05;
  }
  G.globe.rotation.set(G.rotX, G.rotY, 0, "XYZ");
  const alt = G.dist - 1;
  if (!G.renderer.xr.isPresenting) placeCamera(alt);
  // close to the ground, overlays come down from their global-view heights
  const f = Math.min(1, alt / 0.08);
  G.ovl.scale.setScalar(1 - 0.0024 * (1 - f));
  G.rings.visible = alt > 0.25;
  // the glow shell is seen from outside only; near the ground it would wash over the view
  G.atmo.visible = alt > 0.06;
  G.atmo.material.uniforms.uAtmo.value = Math.min(1, (alt - 0.06) / 0.2);
  G.uniforms.uGrid.value = Math.min(1, alt / 0.35);
  for (const r of G.rings.children) r.rotation.y += r.userData.speed * dt;
  // smooth sea-level animation so floods spread rather than snap
  S.seaShown += (S.sea - S.seaShown) * Math.min(1, dt * 3.5);
  if (Math.abs(S.sea - S.seaShown) < 0.01) S.seaShown = S.sea;
  const u = G.uniforms;
  u.uTime.value = t;
  u.uSea.value = S.seaShown;
  // hologram from afar, the real planet up close
  const holoTarget = S.holo * smooth(0.04, 0.3, alt);
  u.uHolo.value += (holoTarget - u.uHolo.value) * Math.min(1, dt * 4);
  G.camera.getWorldPosition(u.uCam.value);
  for (const fn of G.frameHooks) fn(dt, t, xrFrame);
  if (G.renderOverride && !G.renderer.xr.isPresenting) G.renderOverride();
  else G.renderer.render(G.scene, G.camera);
}

// ---- camera / globe control -----------------------------------------------------------
// screen pixels -> radians of globe rotation, so the ground under the cursor follows the cursor
export function radPerPixel() {
  const alt = G.dist - 1;
  const h = G.renderer.domElement.clientHeight || innerHeight;
  return ((2 * alt * Math.tan((G.camera.fov * DEG) / 2)) / h) * (1 + alt * 0.6);
}

export function rotateBy(dx, dy, gain = 1) {
  const k = radPerPixel() * gain;
  G.rotY += dx * k;
  G.rotX = Math.max(-1.35, Math.min(1.35, G.rotX + dy * k));
  G.autoSpin = false;
  G.fly = null;
}

let limitHintT = 0;
export function zoomBy(factor) {
  const want = 1 + (G.dist - 1) * factor;
  if (want < 1 + G.minAlt && G.minAlt > 0.005 && performance.now() - limitHintT > 8000) {
    limitHintT = performance.now();
    emit("zoom:limit");
  }
  G.dist = Math.max(1 + G.minAlt, Math.min(5, want));
  G.fly = null;
}

export function setDist(d) {
  G.dist = Math.max(1 + G.minAlt, Math.min(5, d));
}

export function tiltBy(dRad) {
  G.tilt = Math.max(0, G.tilt + dRad);
  G.autoSpin = false;
}

export function altitudeKm() {
  return (G.dist - 1) * 6371;
}

export function flyTo(lat, lon, dist = null, dur = 1.4) {
  const v = ll2v(lat, lon).normalize();
  let y1 = -Math.atan2(v.x, v.z);
  // shortest path in yaw
  while (y1 - G.rotY > Math.PI) y1 -= Math.PI * 2;
  while (y1 - G.rotY < -Math.PI) y1 += Math.PI * 2;
  G.fly = { t: 0, start: performance.now(), dur, x0: G.rotX, x1: Math.max(-1.35, Math.min(1.35, Math.asin(v.y))), y0: G.rotY, y1, d0: G.dist, d1: Math.max(1 + G.minAlt, dist ?? G.dist) };
  G.autoSpin = false;
}

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
export function pick(clientX, clientY) {
  const r = G.renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, G.camera);
  const hit = ray.intersectObject(G.earth, false)[0];
  if (!hit) return null;
  const local = G.globe.worldToLocal(hit.point.clone());
  return v2ll(local);
}

export function pickRay(origin, dir) {
  ray.set(origin, dir);
  const hit = ray.intersectObject(G.earth, false)[0];
  if (!hit) return null;
  return { ...v2ll(G.globe.worldToLocal(hit.point.clone())), point: hit.point };
}

// latitude under the screen centre, from the globe rotation alone (cheap, every frame)
const _vc = new THREE.Vector3();
function viewLatFast() {
  _vc.set(0, 0, 1).applyQuaternion(G.globe.quaternion.clone().invert());
  return v2ll(_vc).lat;
}

// the surface point the camera is looking at (independent of tilt)
export function viewCenter() {
  _vc.set(0, 0, 1).applyQuaternion(G.globe.quaternion.clone().invert());
  return v2ll(_vc);
}

// screen position of a geo point; null when on the far side
const tmp = new THREE.Vector3();
const camDir = new THREE.Vector3();
const center = new THREE.Vector3();
export function project(lat, lon, r = null) {
  if (r == null) r = 1 + Math.min(0.01, (G.dist - 1) * 0.004);
  ll2v(lat, lon, r, tmp);
  G.globe.localToWorld(tmp);
  G.root.getWorldPosition(center);
  const normal = tmp.clone().sub(center).normalize();
  camDir.copy(G.camera.position).sub(tmp).normalize();
  const facing = normal.dot(camDir);
  if (facing < 0.08) return null;
  tmp.project(G.camera);
  const rect = G.renderer.domElement.getBoundingClientRect();
  return { x: rect.left + ((tmp.x + 1) / 2) * rect.width, y: rect.top + ((1 - tmp.y) / 2) * rect.height, facing };
}

export function setHolo(on) {
  S.holo = on ? 1 : 0;
  emit("view", S.holo);
}
