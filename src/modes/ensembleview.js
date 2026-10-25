// Draw a storm ensemble: faint member tracks ("spaghetti") and a hurricane-wind probability map.
import * as THREE from "three";
import { $, h, toast, fmtPop } from "../util/dom.js";
import { group, clearGroup, Raster, label, removeLabels } from "../globe/overlays.js";
import { ll2v } from "../util/geo.js";
import { stormEnsemble } from "../sim/ensemble.js";
import { r34 } from "../sim/storm.js";
import { S } from "../state.js";

export const ENS = { g: null, last: null };
const GW = 1024, GH = 512;

export function initEnsembleView() {
  ENS.g = group("ensemble");
  $("#ensRun").addEventListener("click", () => {
    if (!S.storm) { toast("Draw or replay a storm first."); return; }
    runEnsembleView(S.storm.genesis, S.storm.cat, S.storm.push);
  });
}

export function runEnsembleView(genesis, cat, push, members = 50) {
  const res = stormEnsemble(genesis, cat, push, members);
  ENS.last = res;
  clearGroup(ENS.g);
  removeLabels(ENS.g);
  const mat = new THREE.LineBasicMaterial({ color: 0xffd6a0, transparent: true, opacity: 0.32, depthWrite: false });
  for (const tr of res.tracks) {
    const pts = tr.filter((p) => p.v >= 34).map((p) => ll2v(p.lat, p.lon, 1.005));
    if (pts.length > 1) ENS.g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
  // probability of hurricane-force winds per cell
  const count = new Uint16Array(GW * GH);
  for (const tr of res.tracks) {
    const seen = new Uint8Array(GW * GH);
    for (const p of tr) {
      if (p.cat < 1) continue;
      const R = r34(p) * 0.4, dLat = R / 111.32, dLon = dLat / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
      const y0 = Math.max(0, Math.floor(((90 - p.lat - dLat) / 180) * GH)), y1 = Math.min(GH - 1, Math.ceil(((90 - p.lat + dLat) / 180) * GH));
      const x0 = Math.floor(((p.lon - dLon + 180) / 360) * GW), x1 = Math.ceil(((p.lon + dLon + 180) / 360) * GW);
      for (let y = y0; y <= y1; y++) for (let xx = x0; xx <= x1; xx++) {
        const lat = 90 - ((y + 0.5) / GH) * 180, lon = ((xx + 0.5) / GW) * 360 - 180;
        const dy = (lat - p.lat) * 111.32, dx = (lon - p.lon) * 111.32 * Math.cos((p.lat * Math.PI) / 180);
        if (dx * dx + dy * dy > R * R) continue;
        seen[y * GW + (((xx % GW) + GW) % GW)] = 1;
      }
    }
    for (let i = 0; i < seen.length; i++) count[i] += seen[i];
  }
  const img = new ImageData(GW, GH);
  for (let i = 0; i < count.length; i++) {
    if (!count[i]) continue;
    const p = count[i] / res.members;
    const o = i * 4;
    img.data[o] = 255; img.data[o + 1] = Math.round(220 - 170 * p); img.data[o + 2] = Math.round(120 - 100 * p); img.data[o + 3] = Math.round(60 + 170 * p);
  }
  const c = document.createElement("canvas");
  c.width = GW; c.height = GH;
  c.getContext("2d").putImageData(img, 0, 0);
  Raster.set("ensemble", (ctx, W, H) => ctx.drawImage(c, 0, 0, W, H));
  for (const city of res.cities.slice(0, 5)) if (city.pHurricaneForce >= 0.2) label(city.lat, city.lon, `${city.name}<small>${Math.round(city.pHurricaneForce * 100)}% hurricane winds</small>`, "heat", ENS.g);
  const box = $("#ensOut");
  box.innerHTML = "";
  box.append(h("p", { class: "note", text: `${res.members} members · ${Math.round(res.landfallShare * 100)}% make landfall${res.medianLandfallHour ? `, median at hour ${res.medianLandfallHour}` : ""}. Shading = chance of hurricane-force winds.` }));
  const ul = h("ul", { class: "list" });
  for (const city of res.cities.slice(0, 8)) ul.append(h("li", { class: city.pHurricaneForce >= 0.5 ? "sev" : "" }, h("span", { text: `${city.name}, ${city.cc}` }), h("span", { text: `${Math.round(city.pHurricaneForce * 100)}% hurricane · ${Math.round(city.pStormForce * 100)}% storm · ${fmtPop(city.pop)}` })));
  box.append(ul);
  return res;
}

export function clearEnsemble() {
  clearGroup(ENS.g);
  removeLabels(ENS.g);
  Raster.remove("ensemble");
  $("#ensOut").innerHTML = "";
}
