// Point-and-say: resolve "this", "here", "there", "that" in speech to where your finger (or mouse)
// was pointing at the moment you said the word. The pointer path is kept for 10 seconds; the word's
// time comes from when it first appears in the live (interim) transcript, minus recogniser latency.
import { S, on, emit } from "../state.js";
import { nearestCity } from "../data/places.js";
import { group, clearGroup, sprite, label, removeLabels } from "../globe/overlays.js";
import { fmtLat, fmtLon } from "../util/geo.js";

const HISTORY_MS = 10000;
const LATENCY_MS = 450; // typical gap between saying a word and it appearing in interim results
// "here", "this", "there" (not "is there", "there are"), "that place/spot/area/city/coast"
const DEICTIC = /\b(here|this|(?<!\b(?:is|are|was|were|be) )there(?! (?:is|are|was|were|will|would)\b)|that (?:place|spot|area|city|coast|point|region))\b/i;
const path = [];
let wordTime = null;
let marker = null;

export function initDeixis() {
  marker = group("deixis");
  on("hover", (p) => {
    if (!p) return;
    const now = performance.now();
    path.push({ t: now, lat: p.lat, lon: p.lon, src: S.hands ? "hand" : "mouse" });
    while (path.length && now - path[0].t > HISTORY_MS) path.shift();
  });
}

// called with every interim transcript; remembers when a deictic word was first heard
export function onInterim(text) {
  if (!text) return;
  if (wordTime == null && DEICTIC.test(text)) wordTime = performance.now() - LATENCY_MS;
}

export function pointAt(t) {
  if (!path.length) return null;
  let best = path[0];
  for (const p of path) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return Math.abs(best.t - t) < 2500 ? best : null;
}

// For a final utterance: returns { text (with the place written in), point } or null if no deixis
export function resolveDeixis(text, { typed = false } = {}) {
  const m = text.match(DEICTIC);
  const t = wordTime ?? performance.now() - (typed ? 0 : LATENCY_MS);
  wordTime = null;
  if (!m) return null;
  // "this region" with a drawn region means the region, not a point
  if (S.region && /\bthis (region|area)\b/i.test(text) && !pointAt(t)) return null;
  const p = pointAt(t) || (typed && path.length ? path[path.length - 1] : null);
  if (!p) return null;
  const c = nearestCity(p);
  const place = `${c && c.distKm < 60 ? `near ${c.name} ` : ""}(${p.lat.toFixed(2)}, ${p.lon.toFixed(2)})`;
  S.deixis = { lat: p.lat, lon: p.lon, at: Date.now(), place };
  showMarker(p, m[1]);
  emit("deixis", S.deixis);
  return { text: text.replace(DEICTIC, (w) => `${w} ${place}`), point: p };
}

function showMarker(p, word) {
  clearGroup(marker);
  removeLabels(marker);
  const s = sprite(p.lat, p.lon, { color: 0xff7ad9, size: 0.08 });
  marker.add(s);
  label(p.lat, p.lon, `“${word}”<small>${fmtLat(p.lat)} ${fmtLon(p.lon)}</small>`, "", marker);
  setTimeout(() => { clearGroup(marker); removeLabels(marker); }, 4000);
}

// the deictic point is used by tools for ~2 minutes
export function activeDeixis() {
  return S.deixis && Date.now() - S.deixis.at < 120000 ? S.deixis : null;
}
