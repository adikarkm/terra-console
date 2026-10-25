// Historical hurricanes: replay a real Atlantic storm, run the model from the same starting point,
// compare tracks, and report the model's forecast skill over 50 years of best tracks.
import * as THREE from "three";
import { $, h, toast, fmtPop } from "../util/dom.js";
import { group, clearGroup, tube, sprite, label, removeLabels, disc } from "../globe/overlays.js";
import { flyTo } from "../globe/scene.js";
import { STORMS, findStorm, replay, skill, stormSummary } from "../sim/validate.js";
import { stormImpacts, catFromKt, catLabel } from "../sim/storm.js";
import { emit } from "../state.js";

export const HIST = { g: null, last: null, skillCache: null };
const FAMOUS = ["Andrew 1992", "Mitch 1998", "Ivan 2004", "Katrina 2005", "Rita 2005", "Wilma 2005", "Ike 2008", "Sandy 2012", "Harvey 2017", "Irma 2017", "Maria 2017", "Michael 2018", "Dorian 2019", "Laura 2020", "Ida 2021", "Ian 2022", "Beryl 2024", "Helene 2024", "Milton 2024"];

export function initHistory() {
  HIST.g = group("history");
  const dl = $("#stormList");
  const seen = new Set(FAMOUS);
  for (const f of FAMOUS) dl.append(h("option", { value: f }));
  for (const s of STORMS) { const v = `${s.n} ${s.y}`; if (!seen.has(v) && Math.max(...s.p.map((q) => q[3])) >= 96) { seen.add(v); dl.append(h("option", { value: v })); } }
  $("#histGo").addEventListener("click", () => runReplay($("#histName").value));
  $("#histName").addEventListener("keydown", (e) => { if (e.key === "Enter") runReplay($("#histName").value); });
  $("#histSkill").addEventListener("click", showSkill);
  $("#histClear").addEventListener("click", clearHistory);
}

export function parseStormQuery(q) {
  const m = String(q).trim().match(/^([A-Za-z' -]+?)\s*(\d{4})?$/);
  return m ? { name: m[1].trim(), year: m[2] ? +m[2] : null } : null;
}

export function runReplay(q) {
  const pq = parseStormQuery(q);
  const s = pq && findStorm(pq.name, pq.year);
  if (!s) { toast(`No Atlantic storm named "${q}" in 1975–2024.`); return null; }
  const r = replay(s);
  HIST.last = { s, r };
  draw(s, r);
  const imp = stormImpacts(r.observed.map((p) => ({ lat: p.lat, lon: p.lon, v: p.v, cat: catFromKt(p.v), t: p.t, land: false })));
  const sum = stormSummary(s);
  const box = $("#histOut");
  box.innerHTML = "";
  box.append(
    h("p", { class: "note", html: false, text: `${s.n} ${s.y}: peak ${sum.peakWindKt} kt (${catLabel(catFromKt(sum.peakWindKt))}), ${sum.minPressureHpa < 9999 ? sum.minPressureHpa + " hPa, " : ""}${Math.round(sum.hours / 24)} days. Model started at hour ${r.init.t} (${r.init.wind} kt) from the observed motion.` }),
    h("ul", { class: "list" }, ...Object.entries(r.errors).map(([L, km]) => h("li", {}, h("span", { text: `${L} h track error` }), h("span", { text: `${km} km` })))),
    h("p", { class: "note", text: `Observed track hit ${imp.length} cities over 100k (${fmtPop(imp.reduce((a, c) => a + c.pop, 0))} people) within its storm-force wind radius.` })
  );
  emit("history:replay", { id: s.id });
  return { summary: sum, errors: r.errors, init: r.init, citiesHit: imp.length, peopleInCitiesHit: imp.reduce((a, c) => a + c.pop, 0), topCities: imp.slice(0, 8).map((c) => `${c.name}, ${c.cc}`) };
}

function draw(s, r) {
  clearGroup(HIST.g);
  removeLabels(HIST.g);
  const obs = r.observed;
  const t1 = tube(obs, { color: 0xffffff, radius: 0.0028, opacity: 0.9 });
  if (t1) HIST.g.add(t1);
  for (const p of obs) if (p.t % 24 === 0) HIST.g.add(sprite(p.lat, p.lon, { color: 0xffffff, size: 0.018 }));
  for (const p of obs) if (p.r34 && p.t % 24 === 0) HIST.g.add(disc(p.lat, p.lon, p.r34, { color: 0xffffff, opacity: 0.08 }));
  const model = r.model.filter((p, i) => i % 3 === 0);
  const t2 = tube(model, { color: 0xffb547, radius: 0.0028, opacity: 0.95 });
  if (t2) HIST.g.add(t2);
  for (const L of [24, 48, 72, 96, 120]) {
    const m = r.model[L];
    if (!m) continue;
    HIST.g.add(sprite(m.lat, m.lon, { color: 0xffb547, size: 0.03 }));
    label(m.lat, m.lon, `Model +${L} h`, "heat", HIST.g);
  }
  const first = obs[0];
  label(first.lat, first.lon, `${s.n} ${s.y}<small>observed (white) vs model (amber)</small>`, "", HIST.g);
  flyTo(r.init.lat, r.init.lon, 2.6);
}

export function clearHistory() {
  clearGroup(HIST.g);
  removeLabels(HIST.g);
  $("#histOut").innerHTML = "";
  HIST.last = null;
}

export function showSkill() {
  const box = $("#histOut");
  box.innerHTML = '<div class="thinking"><i></i><span>Running ~6,000 forecasts over 1980–2024…</span></div>';
  setTimeout(() => {
    const r = modelSkill();
    box.innerHTML = "";
    const tbl = h("table", { class: "skill" }, h("tr", {}, h("th", { text: "Lead" }), h("th", { text: "Model" }), h("th", { text: "Persistence" }), h("th", { text: "Skill" })));
    for (const [L, v] of Object.entries(r.test.leads)) tbl.append(h("tr", {}, h("td", { text: `${L} h` }), h("td", { text: `${v.modelKm} km` }), h("td", { text: `${v.persistenceKm} km` }), h("td", { text: `${v.skillVsPersistencePct > 0 ? "+" : ""}${v.skillVsPersistencePct}%` })));
    box.append(h("p", { class: "note", text: `Mean track error on held-out seasons 2015–2024 (${r.test.cases} forecasts). Parameters were fitted on 1980–2014. Positive skill means the model beats "keep moving the same way".` }), tbl);
  }, 30);
}

export function modelSkill() {
  if (!HIST.skillCache) HIST.skillCache = { test: skill({ yearFrom: 2015, yearTo: 2024 }), train: skill({ yearFrom: 1980, yearTo: 2014 }) };
  return HIST.skillCache;
}
