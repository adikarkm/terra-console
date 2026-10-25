// Output for physical spherical displays.
//  - "fisheye": azimuthal equidistant image centred on the North Pole, the input format of
//    internally projected globes (PufferSphere, OmniGlobe, Magic Planet style projectors).
//  - "equirect": 2:1 latitude/longitude image, the input format of NOAA Science On a Sphere and
//    most LED/projection spheres with media servers.
// Both draw the same composite as the console globe (imagery, flood, raster layers) and spin
// with the console. Send the browser window full-screen to the display's input.
import * as THREE from "three";
import { G } from "../globe/scene.js";
import { toast } from "../util/dom.js";

const FRAG = /* glsl */ `
uniform sampler2D dayTex; uniform sampler2D floodTex; uniform sampler2D overlayTex;
uniform float uHolo; uniform float uSea; uniform float uFloodVis; uniform float uTime; uniform float uRot;
uniform int uMode; uniform vec2 uRes;
varying vec2 vUv;
void main(){
  vec2 p = gl_FragCoord.xy / uRes;
  float lat, lon;
  if (uMode == 0) {
    float s = min(uRes.x, uRes.y);
    vec2 c = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * s);
    float r = length(c);
    if (r > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    lat = 90.0 - r * 180.0;
    lon = degrees(atan(c.x, -c.y));
  } else {
    lat = p.y * 180.0 - 90.0;
    lon = p.x * 360.0 - 180.0;
  }
  lon = mod(lon - degrees(uRot) + 540.0, 360.0) - 180.0;
  vec2 uv = vec2((lon + 180.0) / 360.0, (lat + 90.0) / 180.0);
  vec3 day = texture2D(dayTex, uv).rgb;
  vec4 fl = texture2D(floodTex, vec2(uv.x, 1.0 - uv.y));
  float land = step(0.75, fl.b);
  float lum = dot(day, vec3(0.3, 0.59, 0.11));
  vec3 holo = mix(vec3(0.015, 0.06, 0.12) + vec3(0.0, 0.08, 0.16) * lum, vec3(0.22, 0.72, 1.0) * (0.28 + lum * 1.4), step(0.25, fl.b));
  vec3 col = mix(day, holo, uHolo);
  float flooded = land * step(fl.r, uSea) * step(0.001, uSea) * uFloodVis;
  col = mix(col, vec3(1.0, 0.62, 0.2), flooded * 0.88);
  vec4 ov = texture2D(overlayTex, uv);
  col = mix(col, ov.rgb, ov.a);
  gl_FragColor = vec4(col, 1.0);
}`;

const SX = { mode: null, scene: null, cam: null, mat: null };

export function setSphereOutput(mode) {
  if (!mode || mode === "off") {
    SX.mode = null;
    G.renderOverride = null;
    document.body.classList.remove("sphere-out");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    return;
  }
  if (!SX.scene) {
    SX.scene = new THREE.Scene();
    SX.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const u = G.uniforms;
    SX.mat = new THREE.ShaderMaterial({
      uniforms: { dayTex: u.dayTex, floodTex: u.floodTex, overlayTex: u.overlayTex, uHolo: u.uHolo, uSea: u.uSea, uFloodVis: u.uFloodVis, uTime: u.uTime, uRot: { value: 0 }, uMode: { value: 0 }, uRes: { value: new THREE.Vector2() } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: FRAG,
      depthTest: false,
    });
    SX.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), SX.mat));
  }
  SX.mode = mode;
  SX.mat.uniforms.uMode.value = mode === "fisheye" ? 0 : 1;
  document.body.classList.add("sphere-out");
  G.renderOverride = () => {
    const r = G.renderer;
    const v = new THREE.Vector2();
    r.getDrawingBufferSize(v);
    SX.mat.uniforms.uRes.value.copy(v);
    SX.mat.uniforms.uRot.value = G.rotY;
    r.render(SX.scene, SX.cam);
  };
  document.documentElement.requestFullscreen?.().catch(() => toast("Press F11 (or your browser's full-screen) and move the window to the sphere's display."));
}
