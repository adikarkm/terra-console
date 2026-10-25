// Time travel: scrub global sea level through history and IPCC projections, and compare NASA
// GIBS satellite imagery from two dates with a swipe divider.
import * as THREE from "three";
import { S, emit, on } from "../state.js";
import { $, $$, h, toast, setPressed } from "../util/dom.js";
import { G } from "../globe/scene.js";
import { SCENARIOS, seaRelativeToToday, PRESENT_YEAR } from "./scenarios.js";
import { setSea } from "../modes/whatif.js";

export const GIBS_LAYERS = {
  MODIS_Terra_CorrectedReflectance_TrueColor: { label: "True colour (MODIS Terra, 2000–today)", from: "2000-02-24", fmt: "image/jpeg" },
  VIIRS_SNPP_CorrectedReflectance_TrueColor: { label: "True colour (VIIRS, 2015–today)", from: "2015-11-24", fmt: "image/jpeg" },
  VIIRS_Black_Marble: { label: "Night lights (Black Marble, 2012 / 2016)", from: "2012-01-01", fmt: "image/png", dates: ["2012-01-01", "2016-01-01"] },
  MODIS_Terra_NDVI_8Day: { label: "Vegetation index (MODIS NDVI, 8-day)", from: "2000-02-18", fmt: "image/png" },
};

const T = { baseTex: null, altA: null, altB: null, dragging: false };

export function gibsUrl(layer, date, w = 2048, h = 1024) {
  const fmt = GIBS_LAYERS[layer]?.fmt || "image/jpeg";
  const q = `SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=${w}&HEIGHT=${h}&FORMAT=${encodeURIComponent(fmt)}&TIME=${date}`;
  return { direct: `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?${q}`, proxy: `/api/gibs?layer=${encodeURIComponent(layer)}&date=${date}&w=${w}&h=${h}` };
}

function loadTexture(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const t = new THREE.Texture(img);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      res(t);
    };
    img.onerror = () => rej(new Error("load failed"));
    img.src = url;
  });
}

async function loadGibs(layer, date) {
  const u = gibsUrl(layer, date);
  if (S.local) { try { return await loadTexture(u.proxy); } catch {} }
  return loadTexture(u.direct);
}

export function initTimeline() {
  T.baseTex = G.uniforms.dayTex.value;
  const yr = $("#yearSlider");
  yr.addEventListener("input", () => setYear(+yr.value));
  const sc = $("#scRow");
  for (const [k, v] of Object.entries(SCENARIOS)) {
    const b = h("button", { class: "chip", "data-sc": k, "aria-pressed": String(k === S.scenario), text: v.label.split(" · ")[0], title: v.label });
    b.addEventListener("click", () => { S.scenario = k; setPressed($$("#scRow .chip"), b); setYear(S.year); });
    sc.append(b);
  }
  const sel = $("#gibsLayer");
  for (const [k, v] of Object.entries(GIBS_LAYERS)) sel.append(h("option", { value: k, text: v.label }));
  $("#gibsLoad").addEventListener("click", () => compare($("#dateA").value, $("#dateB").value, sel.value));
  $("#gibsOff").addEventListener("click", endCompare);
  sel.addEventListener("change", () => {
    const L = GIBS_LAYERS[sel.value];
    if (L.dates) { $("#dateA").value = L.dates[0]; $("#dateB").value = L.dates[1]; }
  });
  $("#timeClose").addEventListener("click", () => toggleTime(false));
  on("time:toggle", (v) => toggleTime(v));
  on("time:compare", ({ a, b, layer }) => { toggleTime(true); compare(a, b, layer); });
  initSplitHandle();
  setYear(S.year, { silent: true });
}

export function toggleTime(open = !S.timeOpen) {
  S.timeOpen = open;
  $("#timePanel").hidden = !open;
  $("#timeBtn").classList.toggle("on", open);
  emit("time:state", open);
}

export function setYear(year, { silent = false } = {}) {
  S.year = year;
  $("#yearSlider").value = year;
  const rel = seaRelativeToToday(year, S.scenario);
  $("#yearVal").textContent = year;
  $("#yearSea").textContent = `${rel >= 0 ? "+" : "−"}${Math.abs(rel).toFixed(2)} m vs today`;
  $("#yearNote").textContent = year < PRESENT_YEAR ? "Historical reconstruction. Lower seas than today are not drawn." : year === PRESENT_YEAR ? "Today." : SCENARIOS[S.scenario].label + " (IPCC AR6, approximate median).";
  if (!silent) {
    if (S.mode !== "whatif") emit("mode:set", "whatif");
    setSea(Math.max(0, Math.round(rel * 100) / 100));
    emit("sim:changed", "year");
  }
}

export async function compare(a, b, layer = "MODIS_Terra_CorrectedReflectance_TrueColor") {
  const status = $("#gibsStatus");
  status.textContent = "Loading imagery from NASA GIBS…";
  try {
    const [ta, tb] = await Promise.all([loadGibs(layer, a), loadGibs(layer, b)]);
    T.altA?.dispose(); T.altB?.dispose();
    T.altA = ta; T.altB = tb;
    G.uniforms.altTex.value = ta;
    G.uniforms.dayTex.value = tb;
    G.uniforms.uAltOn.value = 1;
    S.holo = 0;
    $("#splitHandle").hidden = false;
    status.textContent = `Left: ${a} · Right: ${b}. Drag the divider.`;
    emit("time:compare:on", { a, b, layer });
  } catch {
    status.textContent = "NASA imagery couldn't load here. It needs internet access to gibs.earthdata.nasa.gov (works in the local version).";
  }
}

export function endCompare() {
  G.uniforms.uAltOn.value = 0;
  G.uniforms.dayTex.value = T.baseTex;
  G.uniforms.altTex.value = T.baseTex;
  $("#splitHandle").hidden = true;
  $("#gibsStatus").textContent = "";
}

function initSplitHandle() {
  const hd = $("#splitHandle");
  const set = (x) => {
    const f = Math.min(0.98, Math.max(0.02, x / innerWidth));
    G.uniforms.uSplit.value = f;
    hd.style.left = f * 100 + "%";
  };
  hd.addEventListener("pointerdown", (e) => { T.dragging = true; hd.setPointerCapture(e.pointerId); });
  hd.addEventListener("pointermove", (e) => { if (T.dragging) set(e.clientX); });
  hd.addEventListener("pointerup", () => (T.dragging = false));
  on("hand:drag-split", (x) => set(x));
  set(innerWidth / 2);
}
