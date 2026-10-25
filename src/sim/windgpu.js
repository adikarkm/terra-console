// GPU wind particles: up to ~1 million particles advected entirely on the GPU (WebGL2 float
// render targets via GPUComputationRenderer). State texture: (lat, lon, age, life).
// The wind field is uploaded as a float texture sampled from the wind model on a 1° grid.
import * as THREE from "three";
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import { G, onFrame } from "../globe/scene.js";
import { Wind } from "./windmodel.js";
import { on } from "../state.js";

export const WG = { ok: false, size: 1024, gpu: null, posVar: null, points: null, windTex: null, count: 0 };

const SIM = /* glsl */ `
uniform sampler2D windTex;
uniform float dt;
uniform float seed;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 s = texture2D(texturePosition, uv);
  float lat = s.x, lon = s.y, age = s.z, life = s.w;
  age += dt;
  if (age > life || life <= 0.0) {
    float r1 = hash(uv + age), r2 = hash(uv.yx + life + 0.37), r3 = hash(uv * 1.7 + 0.11);
    lat = degrees(asin(r1 * 2.0 - 1.0));
    lon = r2 * 360.0 - 180.0;
    age = 0.0;
    life = 2.0 + r3 * 5.0;
  } else {
    vec2 w = texture2D(windTex, vec2((lon + 180.0) / 360.0, (lat + 90.0) / 180.0)).rg;
    float cl = max(0.15, cos(radians(lat)));
    lat = clamp(lat + w.y * 0.035 * dt, -89.0, 89.0);
    lon = lon + w.x * 0.035 * dt / cl;
    lon = mod(lon + 540.0, 360.0) - 180.0;
  }
  gl_FragColor = vec4(lat, lon, age, life);
}`;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform sampler2D posTex;
uniform sampler2D windTex;
uniform float pointSize;
attribute vec2 ref;
varying float vFade;
varying float vSpeed;
void main() {
  vec4 s = texture2D(posTex, ref);
  float phi = radians(s.y + 180.0), th = radians(90.0 - s.x);
  vec3 p = vec3(-cos(phi) * sin(th), cos(th), sin(phi) * sin(th)) * 1.007;
  vFade = sin(clamp(s.z / max(s.w, 0.01), 0.0, 1.0) * 3.14159);
  vec2 w = texture2D(windTex, vec2((s.y + 180.0) / 360.0, (s.x + 90.0) / 180.0)).rg;
  vSpeed = clamp(length(w) / 20.0, 0.0, 1.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = pointSize;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vFade;
varying float vSpeed;
void main() {
  #include <logdepthbuf_fragment>
  vec3 c = mix(vec3(0.25, 0.65, 1.0), vec3(1.0, 0.95, 0.8), vSpeed);
  gl_FragColor = vec4(c * vFade * 0.55, vFade * 0.5);
}`;

export function windTextureData() {
  const W = 360, H = 181;
  const d = new Float32Array(W * H * 4);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const { u, v } = Wind.sample(-90 + j, -180 + i + 0.5);
    const o = (j * W + i) * 4;
    d[o] = u; d[o + 1] = v; d[o + 3] = 1;
  }
  return d;
}

export function initWindGPU(size = 1024) {
  const r = G.renderer;
  if (!r.capabilities.isWebGL2 || !r.extensions.has("EXT_color_buffer_float")) return false;
  try {
    const gpu = new GPUComputationRenderer(size, size, r);
    const t0 = gpu.createTexture();
    const a = t0.image.data;
    for (let i = 0; i < a.length; i += 4) { a[i] = Math.asin(Math.random() * 2 - 1) * 57.2958; a[i + 1] = Math.random() * 360 - 180; a[i + 2] = Math.random() * 6; a[i + 3] = 2 + Math.random() * 5; }
    const posVar = gpu.addVariable("texturePosition", SIM, t0);
    gpu.setVariableDependencies(posVar, [posVar]);
    WG.windTex = new THREE.DataTexture(windTextureData(), 360, 181, THREE.RGBAFormat, THREE.FloatType);
    WG.windTex.magFilter = WG.windTex.minFilter = THREE.LinearFilter;
    WG.windTex.wrapS = THREE.RepeatWrapping;
    WG.windTex.needsUpdate = true;
    posVar.material.uniforms.windTex = { value: WG.windTex };
    posVar.material.uniforms.dt = { value: 0 };
    posVar.material.uniforms.seed = { value: 0 };
    const err = gpu.init();
    if (err) throw new Error(err);
    const n = size * size;
    const ref = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { ref[i * 2] = ((i % size) + 0.5) / size; ref[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("ref", new THREE.BufferAttribute(ref, 2));
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const mat = new THREE.ShaderMaterial({ uniforms: { posTex: { value: null }, windTex: { value: WG.windTex }, pointSize: { value: 1.6 } }, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.visible = false;
    G.ovl.add(pts);
    Object.assign(WG, { ok: true, size, gpu, posVar, points: pts, count: n });
    onFrame((dt) => {
      if (!pts.visible) return;
      posVar.material.uniforms.dt.value = dt;
      posVar.material.uniforms.seed.value = Math.random() * 100;
      gpu.compute();
      mat.uniforms.posTex.value = gpu.getCurrentRenderTarget(posVar).texture;
      mat.uniforms.pointSize.value = Math.max(1, Math.min(2.2, 3.4 - G.dist)) * Math.min(2, devicePixelRatio);
    });
    on("wind:source", () => { WG.windTex.image.data.set(windTextureData()); WG.windTex.needsUpdate = true; });
    return true;
  } catch (e) {
    console.warn("GPU wind particles unavailable:", e);
    return false;
  }
}

export function setWindGPU(v) {
  if (WG.points) WG.points.visible = v;
}
