// Streaming globe: satellite imagery and 3D terrain loaded as tiles for whatever is in view, at
// the detail the camera needs (from whole-planet down to street level), like a web map.
//  - terrain: Terrarium elevation tiles (AWS Terrain Tiles, ~30 m on land, with bathymetry)
//  - imagery: XYZ tiles from the chosen basemap (Esri World Imagery to ~0.5 m in cities,
//    Sentinel-2 cloudless 10 m, OpenStreetMap, topographic, night lights)
// Tiles are fetched through the local server's cache (/api/tiles, /api/terrain) or directly when
// the page is opened another way. The console's hologram, flood and data layers are composited
// into the tile shader so they keep working on top of the real imagery.
import * as THREE from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { TerrariumMeshPlugin, XYZTilesOverlay, TilesFadePlugin } from "3d-tiles-renderer/plugins";
import { G, onFrame, viewCenter } from "./scene.js";
import { S, emit } from "../state.js";
import { sampleDEM } from "../data/dem.js";
import { $, toast } from "../util/dom.js";

const A = 6378137, B = 6356752.314245;

export const BASEMAPS = {
  satellite: {
    label: "Satellite · Esri World Imagery",
    direct: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
  sentinel: {
    label: "Sentinel-2 cloudless 2016 · EOX",
    direct: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
    maxZoom: 15,
    attribution: "Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)",
  },
  streets: {
    label: "Streets · OpenStreetMap",
    direct: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  },
  topo: {
    label: "Topographic · Esri",
    direct: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    attribution: "Esri, HERE, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors",
  },
  night: {
    label: "Night lights · NASA Black Marble",
    direct: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
    maxZoom: 8,
    attribution: "NASA Earth Observatory / GIBS, VIIRS Black Marble 2016",
  },
};
const TERRAIN = { direct: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", maxZoom: 15, attribution: "Terrain: AWS Terrain Tiles (SRTM, GMTED, ETOPO1 and others)" };

export const ST = { tiles: null, wrap: null, basemap: "satellite", on: false, ready: false, errors: 0, loaded: 0, uniforms: null, plugin: null };

function urlFor(kind, key) {
  if (kind === "terrain") return S.local ? "/api/terrain/{z}/{x}/{y}.png" : TERRAIN.direct;
  return S.local ? `/api/tiles/${key}/{z}/{x}/{y}` : BASEMAPS[key].direct;
}

// GLSL injected into every tile material: lat/lon from the fragment's globe-local position,
// then hologram tint, flood (fine-scale where the tile's own elevation is known) and data layers.
const VERT_PARS = /* glsl */ `
uniform mat4 uGlobeInv;
varying vec3 vGlobePos;
varying float vTerrH;
`;
const VERT_MAIN = /* glsl */ `
vGlobePos = (uGlobeInv * modelMatrix * vec4(transformed, 1.0)).xyz;
#ifdef USE_DISPLACEMENTMAP
  vTerrH = texture2D(displacementMap, vDisplacementMapUv).x;
#else
  vTerrH = -9999.0;
#endif
`;
const FRAG_PARS = /* glsl */ `
uniform sampler2D floodTex; uniform sampler2D overlayTex;
uniform float uHolo; uniform float uSea; uniform float uFloodVis; uniform float uTime;
varying vec3 vGlobePos;
varying float vTerrH;
`;
const FRAG_MAIN = /* glsl */ `
{
  vec3 gp = vGlobePos;
  float lat = atan(gp.y, 0.99330562 * length(gp.xz)); // geodetic latitude on the WGS84 ellipsoid
  float phi = atan(gp.z, -gp.x);
  if (phi < 0.0) phi += 6.28318530718;
  vec2 guv = vec2(phi / 6.28318530718, 0.5 + lat / 3.14159265359);
  vec4 fl = texture2D(floodTex, vec2(guv.x, 1.0 - guv.y));
  vec3 col = gl_FragColor.rgb;
  float lum = dot(col, vec3(0.3, 0.59, 0.11));
  // coastline from the tile's own terrain (crisp) where available, else the 20 km grid
  float holoLand = step(-9000.0, vTerrH) > 0.5 ? step(0.0, vTerrH) : step(0.25, fl.b);
  vec3 holo = mix(vec3(0.015, 0.06, 0.12) + vec3(0.0, 0.08, 0.16) * lum, vec3(0.22, 0.72, 1.0) * (0.28 + lum * 1.4), holoLand);
  col = mix(col, holo, uHolo);
  // flood: fine terrain decides where water stands; the global Priority-Flood decides whether the
  // sea can reach this area at all (coastal lowlands connected to the ocean)
  float coarseLand = step(0.75, fl.b);
  float fineKnown = step(-9000.0, vTerrH);
  float isLand = fineKnown > 0.5 ? max(step(0.5, vTerrH), coarseLand * step(-25.0, vTerrH)) : coarseLand;
  float reach = step(fl.r, max(uSea, 12.0));
  float below = fineKnown > 0.5 ? step(vTerrH, uSea) : step(fl.r, uSea);
  float flooded = isLand * reach * below * step(0.001, uSea) * uFloodVis;
  float h = fineKnown > 0.5 ? vTerrH : fl.g;
  float depth = clamp((uSea - h) / 6.0, 0.0, 1.0);
  vec3 fc = mix(vec3(1.0, 0.72, 0.30), vec3(1.0, 0.45, 0.10), depth) * (0.85 + 0.15 * sin(uTime * 2.2 + gl_FragCoord.x * 0.05));
  col = mix(col, fc, flooded * 0.78);
  vec4 ov = texture2D(overlayTex, guv);
  col = mix(col, ov.rgb, ov.a);
  gl_FragColor.rgb = col;
}
`;

// relief shading compares height differences (metres) with screen-space surface slopes (globe
// units = equatorial radii), so the bump scale must convert metres to globe units
function fixBump(mat) {
  if (mat.bumpMap) mat.bumpScale = G.exaggeration / A;
}

function patchMaterial(mat) {
  fixBump(mat);
  if (mat.userData.terraPatched) return;
  mat.userData.terraPatched = true;
  const orig = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    orig?.call(mat, shader, renderer);
    Object.assign(shader.uniforms, ST.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + VERT_PARS)
      .replace("#include <fog_vertex>", "#include <fog_vertex>\n" + VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + FRAG_PARS)
      .replace("#include <colorspace_fragment>", "#include <colorspace_fragment>\n" + FRAG_MAIN);
  };
  mat.customProgramCacheKey = () => "terra-tile-" + (mat.displacementMap ? "d" : "n") + (mat.map ? "m" : "x");
  mat.needsUpdate = true;
}

export function initStream() {
  if (window.claude && !S.local) {
    // the published page's sandbox cannot load outside images: keep the built-in globe and stop
    // zooming where its ~10 km image runs out of detail
    G.minAlt = 0.012;
    $("#streamInfo").textContent = "Street-level imagery and 3D terrain stream in the local version (npm start). This page can't load outside map tiles, so zoom stops at about 75 km.";
    ["#basemap", "#exag"].forEach((s) => ($(s).disabled = true));
    return false;
  }
  const u = G.uniforms;
  ST.uniforms = { floodTex: u.floodTex, overlayTex: u.overlayTex, uHolo: u.uHolo, uSea: u.uSea, uFloodVis: u.uFloodVis, uTime: u.uTime, uGlobeInv: { value: new THREE.Matrix4() } };
  // ECEF -> globe-local: metres to equatorial radii, then rotate Z-up to Y-up
  const wrap = new THREE.Group();
  wrap.name = "stream";
  wrap.rotation.x = -Math.PI / 2;
  wrap.scale.setScalar(1 / A); // the ellipsoid in units of the equatorial radius, like the rest of the console
  G.globe.add(wrap);
  ST.wrap = wrap;
  build(ST.basemap);
  onFrame(update);
  return true;
}

// The tile library composes each terrain tile's texture from several imagery tiles and leaves a
// failed one blank, which shows up as a bright hole. Retry failed downloads, and if a tile still
// can't be had, draw it from the built-in world image so the gap is filled (blurry, but never empty).
function hardenImageSource(src) {
  src.fetchItem = async (tokens, signal) => {
    const url = src.getUrl(...tokens);
    for (let i = 0; i < 3; i++) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
      if (i) await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
      try {
        const res = await src.fetchData(url, { ...src.fetchOptions, signal });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (buf.byteLength) return await src.processBufferToTexture(buf);
        } else if (res.status === 404 || res.status === 400) break; // won't appear on retry
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
    ST.fallbackTiles = (ST.fallbackTiles || 0) + 1;
    return src.processBufferToTexture(await fallbackTile(tokens[0], tokens[1], tokens[2]));
  };
}

async function fallbackTile(x, y, z) {
  const N = 256, img = G.uniforms.dayTex.value.image;
  const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(N, N) : Object.assign(document.createElement("canvas"), { width: N, height: N });
  const cx = cv.getContext("2d");
  cx.fillStyle = "#0b1a24";
  cx.fillRect(0, 0, N, N);
  try {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height, n = 2 ** z;
    const sx = (x / n) * W, sw = W / n;
    for (let j = 0; j < N; j++) {
      const gy = (y * N + j + 0.5) / (N * n);
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) * 180 / Math.PI;
      const sy = Math.min(H - 1, Math.max(0, ((90 - lat) / 180) * H));
      cx.drawImage(img, sx, sy, Math.max(sw, 0.01), Math.max(0.01, Math.min(1, H - sy)), 0, j, N, 1);
    }
  } catch { /* image not ready: keep the dark fill */ }
  const blob = cv.convertToBlob ? await cv.convertToBlob({ type: "image/png" }) : await new Promise((r) => cv.toBlob(r, "image/png"));
  return blob.arrayBuffer();
}

function build(key) {
  if (ST.tiles) {
    ST.wrap.remove(ST.tiles.group);
    ST.tiles.dispose();
  }
  ST.basemap = key;
  ST.ready = false;
  ST.errors = 0;
  ST.loaded = 0;
  const bm = BASEMAPS[key];
  const overlay = new XYZTilesOverlay({ url: urlFor("imagery", key), levels: bm.maxZoom + 1, tileDimension: 256 });
  hardenImageSource(overlay.imageSource);
  const tiles = new TilesRenderer();
  ST.plugin = new TerrariumMeshPlugin({ url: urlFor("terrain"), maxZoom: TERRAIN.maxZoom, heightScale: G.exaggeration, overlay, applyOverlayTexture: true });
  tiles.registerPlugin(ST.plugin);
  tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 250 }));
  tiles.errorTarget = 1.5;
  tiles.lruCache.minSize = 300;
  tiles.lruCache.maxSize = 1600;
  tiles.setCamera(G.camera);
  tiles.setResolutionFromRenderer(G.camera, G.renderer);
  tiles.addEventListener("load-model", ({ scene }) => {
    ST.loaded++;
    scene.traverse((o) => { if (o.isMesh && o.material) patchMaterial(o.material); });
    if (!ST.ready && ST.loaded >= 4) {
      ST.ready = true;
      emit("stream:ready", key);
    }
  });
  tiles.addEventListener("load-error", ({ error }) => {
    ST.errors++;
    if (ST.errors === 12 && !ST.ready) {
      toast("Map tiles aren't loading (no internet, or the tile service refused). Showing the built-in globe.", 6000);
      setStream(false);
    }
    if (ST.errors < 4) console.warn("tile load error", error);
  });
  ST.wrap.add(tiles.group);
  ST.tiles = tiles;
  ST.on = true;
  $("#attrib").textContent = `${bm.attribution} · ${TERRAIN.attribution}`;
  $("#attrib").hidden = false;
  $("#streamInfo").textContent = `Streaming ${bm.label} with 3D terrain. Zoom in for detail; right-drag (or Ctrl+drag) to tilt.`;
}

export function setBasemap(key) {
  if (!BASEMAPS[key] || !ST.wrap) return;
  build(key);
}

export function setStream(on) {
  ST.on = on;
  if (ST.tiles) ST.tiles.group.visible = on;
  G.earth.visible = !(on && ST.ready);
  $("#attrib").hidden = !on;
}

export function setExaggeration(k) {
  G.exaggeration = k;
  if (ST.plugin) ST.plugin.heightScale = k;
  ST.tiles?.forEachLoadedModel((scene) => scene.traverse((o) => { if (o.isMesh && o.material) fixBump(o.material); }));
}

const _inv = new THREE.Matrix4();
let minAltT = 0;
function update() {
  if (!ST.tiles || !ST.on) return;
  G.camera.updateMatrixWorld();
  G.globe.updateMatrixWorld(true);
  _inv.copy(G.globe.matrixWorld).invert();
  ST.uniforms.uGlobeInv.value.copy(_inv);
  ST.tiles.setResolutionFromRenderer(G.camera, G.renderer);
  ST.tiles.update();
  // hide the built-in sphere once real tiles cover the globe (they share the same surface)
  G.earth.visible = !ST.ready;
  // keep the camera above the terrain under it
  const now = performance.now();
  if (now - minAltT > 250) {
    minAltT = now;
    const c = viewCenter();
    const e = Math.max(0, sampleDEM(c.lat, c.lon).elev) * G.exaggeration;
    G.minAlt = (e + 350) / 6371000;
    if (G.dist - 1 < G.minAlt) G.dist = 1 + G.minAlt;
  }
}

export function streamStats() {
  const t = ST.tiles;
  if (!t) return null;
  return { basemap: ST.basemap, ready: ST.ready, loaded: ST.loaded, errors: ST.errors, fallbackTiles: ST.fallbackTiles || 0, visible: t.visibleTiles?.size ?? null, downloading: t.stats?.downloading ?? null };
}
